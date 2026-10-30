// 面板集成：桌宠「行为动作」卡（设计稿 §8 测试通道）的 /panel/pet/behavior/* 代理。
// 覆盖：状态行数据（开关/额度/下次/回执/禁用表）、「试一下」下发、/playback 回执回读、
// 每动作 AI 开关（ext.pet.behaviorDisabledActions）、图标隔离区清单与「放回去」。
// fake-dsh 模式；AURABOT_DATA_DIR 隔离；不引入新依赖。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'
const PORT = 5099

async function brain() { return '嗯' }

const call = async (path, body) => (await fake.call(path, body)).json()

// pet 模块自己的路由（/playback、/behavior/icon/*）要过 guard：本机回环 Host + x-pet-token
let mock
let fake
let api
let dataDir
let petHeaders

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-panel-behavior-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
    bridge: { dshTools: false, http: true, token: 'a'.repeat(32) },
  }))
  fake = createFakeDsh({ brain })
  fake.ctx.webServer.port = PORT
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await api.ready.catch(() => {})
  await fake.call('/onebot/reconnect')
  // 先打一次 pet 模块自己的路由（必然 401），让模块把 host-token 落盘，再拿它当桌宠客户端身份
  await fake.call('/behavior/status', null, { host: `127.0.0.1:${PORT}` })
  const tokenFile = join(dataDir, 'modules-data', 'pet', 'host-token')
  assert.equal(existsSync(tokenFile), true, 'pet 模块启动后 host-token 应已落盘')
  petHeaders = { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', 'x-pet-token': readFileSync(tokenFile, 'utf8').trim() }
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

const behaviorFile = () => join(dataDir, 'modules-data', 'pet', 'behavior.json')
const quarantineDir = () => join(dataDir, 'modules-data', 'pet', 'desktop-quarantine')

test('状态行：/panel/pet/behavior/status 给齐总开关/额度/下次触发/回执/禁用表 + 动作全表', async () => {
  const r = await call('/panel/pet/behavior/status')
  assert.equal(r.ok, true, JSON.stringify(r))
  const b = r.behavior
  assert.ok(b, '要带 behavior 字段（面板状态行全靠它渲染）')
  assert.equal(typeof b.enabled, 'boolean', '总开关状态')
  assert.equal(typeof b.maxPerDay, 'number', '每日上限')
  assert.equal(typeof b.today, 'number', '今日次数')
  assert.equal(typeof b.nextAt, 'number', '下次触发时间戳（0 = 还没排程）')
  assert.equal(typeof b.thinking, 'boolean', '「正在想」')
  assert.equal(typeof b.online, 'boolean', '桌宠在不在跑（决定点了会不会有回执）')
  assert.ok(Array.isArray(b.recent), '最近回执列表')
  assert.ok(Array.isArray(b.disabledActions), '每动作开关的初始状态')
  // 动作全表：9 个全开放（2026-10-30 删 approach_cursor/sleep/stretch/poke_cursor/peek_window，面板每行都要有）
  for (const a of ['chase_cursor', 'wander', 'idle_anim', 'steal_cursor', 'say', 'drag_icon', 'hide_icon', 'nudge_window', 'close_window']) {
    assert.ok(b.openActions.includes(a), '已开放动作缺了 ' + a)
  }
  assert.deepEqual(b.deferredActions, [], '第三批已实现，没有暂未开放的动作')
  assert.equal(b.openActions.length, 9)
  assert.ok(b.openActions.includes('idle_anim'), 'idle_anim 是原「自动轮播」的替代出口')
})

test('「试一下」代理：默认 force 下发并回 playbackId；未知动作明确拒绝', async () => {
  const r = await call('/panel/pet/behavior', { action: 'chase_cursor' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.result.ok, true)
  assert.equal(r.result.action, 'chase_cursor')
  assert.match(String(r.result.playbackId || ''), /^[0-9a-f]{8}$/, '下发要带回执号（客户端播完拿它 POST /playback）')
  assert.match(String(r.message || ''), /已下发/, '给人话回执')
  // 不在全表里的动作：不炸，明确说没有
  const bad = await call('/panel/pet/behavior', { action: 'dance' })
  assert.equal(bad.ok, false)
  assert.match(String(bad.message || ''), /没有这个动作/)
})

test('回执回读：/playback 的 played / refused 写进 status.recent，面板按动作取最近一条', async () => {
  const sent = await call('/panel/pet/behavior', { action: 'steal_cursor' })
  const playbackId = sent.result.playbackId
  // 模拟客户端播完回执（pet 模块自己的路由，需要桌宠令牌）
  const played = await fake.call('/playback', { playbackId, status: 'played', action: 'steal_cursor' }, petHeaders)
  assert.equal(played.status, 200, played.raw())
  const refused = await fake.call('/playback', { playbackId: 'deadbeef', status: 'refused', action: 'close_window', reason: 'not-implemented' }, petHeaders)
  assert.equal(refused.status, 200, refused.raw())
  const b = (await call('/panel/pet/behavior/status')).behavior
  assert.ok(b.recent.some((x) => /^steal_cursor → played$/.test(x)), 'played 回执要进 recent：' + JSON.stringify(b.recent))
  assert.ok(b.recent.some((x) => /^close_window → refused（not-implemented）$/.test(x)), 'refused 带原因：' + JSON.stringify(b.recent))
})

test('每动作 AI 开关：写 ext.pet.behaviorDisabledActions（逗号分隔），status 读回；手动「试一下」不受影响', async () => {
  const off = await call('/panel/pet/behavior/actions', { action: 'wander', on: false })
  assert.equal(off.ok, true, JSON.stringify(off))
  assert.ok(off.disabledActions.includes('wander'))
  // 单一真相：落到 config.json 的 ext.pet.behaviorDisabledActions
  const saved = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))
  assert.equal(saved.ext.pet.behaviorDisabledActions, 'wander')
  assert.ok((await call('/panel/pet/behavior/status')).behavior.disabledActions.includes('wander'), 'status 回读禁用表')
  // 关掉 AI 动作表不等于禁用按钮：手动通道照样能下发
  const manual = await call('/panel/pet/behavior', { action: 'wander' })
  assert.equal(manual.ok, true, '手动「试一下」不受 AI 开关限制')
  // 再打开 → 从表里移除
  const on = await call('/panel/pet/behavior/actions', { action: 'wander', on: true })
  assert.equal(on.ok, true)
  assert.ok(!on.disabledActions.includes('wander'))
  const saved2 = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))
  assert.equal(saved2.ext.pet.behaviorDisabledActions, '', '恢复成空串（不要留一串空项）')
  // 垃圾动作名拒绝（别把错名字写进配置）
  const bad = await call('/panel/pet/behavior/actions', { action: 'dance', on: false })
  assert.equal(bad.ok, false)
  assert.match(String(bad.message || ''), /没有这个动作/)
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')).ext.pet.behaviorDisabledActions, '')
})

test('隔离区：空态 → 有记录（名称/原位置/时间/原因）→ 放回去真的回到原路径 → 记录消失', async () => {
  const empty = await call('/panel/pet/behavior/quarantine')
  assert.equal(empty.ok, true, JSON.stringify(empty))
  assert.deepEqual(empty.items, [], '一开始隔离区是空的（面板显示「隔离区空空的，桌宠很乖」）')

  // 造一条隔离记录：桌面文件已被 rename 进隔离区
  const desktop = join(dataDir, 'desktop')
  mkdirSync(desktop, { recursive: true })
  mkdirSync(quarantineDir(), { recursive: true })
  const name = 'note.txt'
  const originalPath = join(desktop, name)
  const quarantinePath = join(quarantineDir(), name)
  writeFileSync(quarantinePath, 'hello')
  writeFileSync(join(quarantineDir(), 'manifest.json'), JSON.stringify([
    { id: 'q1', name, originalPath, quarantinePath, at: Date.now(), reason: 'hide_icon' },
  ]))

  const list = await call('/panel/pet/behavior/quarantine')
  assert.equal(list.ok, true)
  assert.equal(list.items.length, 1)
  assert.equal(list.items[0].name, name)
  assert.equal(list.items[0].originalPath, originalPath, '面板要显示原位置')
  assert.ok(list.items[0].at > 0, '收走时间')
  assert.equal(list.items[0].reason, 'hide_icon')

  const back = await call('/panel/pet/behavior/restore', { id: 'q1' })
  assert.equal(back.ok, true, JSON.stringify(back))
  assert.match(String(back.message || ''), /放回去了/)
  assert.equal(existsSync(originalPath), true, '文件真的回到了原路径')
  assert.equal(readFileSync(originalPath, 'utf8'), 'hello', '内容没被动过')
  assert.deepEqual((await call('/panel/pet/behavior/quarantine')).items, [], '归还后记录消失')
  // 未知 id：给人话，不炸
  const miss = await call('/panel/pet/behavior/restore', { id: 'nope' })
  assert.equal(miss.ok, false)
  assert.match(String(miss.message || ''), /没有这条记录/)
})

test('隔离区清单坏掉不炸：manifest 是坏 JSON 时返回空数组（面板显示空态）', async () => {
  mkdirSync(quarantineDir(), { recursive: true })
  writeFileSync(join(quarantineDir(), 'manifest.json'), '{ 这不是 JSON')
  const r = await call('/panel/pet/behavior/quarantine')
  assert.equal(r.ok, true, '读不了就当空清单，别让卡片炸掉')
  assert.deepEqual(r.items, [])
})

test('行为状态落盘位置一致：status 的今日次数来自 behavior.json（面板「今天 N/上限」靠它）', async () => {
  const b = (await call('/panel/pet/behavior/status')).behavior
  const raw = JSON.parse(readFileSync(behaviorFile(), 'utf8'))
  assert.equal(b.today, Number(raw.count) || 0)
  assert.equal(b.nextAt, Number(raw.nextAt) || 0)
  assert.ok(b.maxPerDay >= 1, '上限默认 99999，至少是正数')
})

// 面板前端是单文件 client/client.js（数据目录里没有构建产物），源码契约直接断言，防合并时把卡片丢了
test('面板源码契约：桌宠页有「行为大脑」与「行为记录」卡（重排后含原两卡内容），9 个动作一个不落', async () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  // 2026-10-30 面板重排：「行为动作」并入「行为大脑」卡，「被收走的图标」并入「行为记录」卡（分区标题仍在）
  assert.ok(src.includes("title: '行为大脑'"), '缺「行为大脑」卡')
  assert.ok(src.includes("'行为与安全'"), '缺「行为与安全」分区')
  assert.ok(src.includes("title: '行为记录'"), '缺「行为记录」卡')
  assert.ok(src.includes("'被收走的图标'"), '缺「被收走的图标」分区')
  assert.ok(src.includes('隔离区空空的，桌宠很乖'), '缺隔离区空态文案')
  assert.ok(src.includes("post('/panel/pet/behavior'"), '「试一下」要走面板代理，不直连模块路由')
  assert.ok(src.includes("post('/panel/pet/behavior/actions'"), '每动作 AI 开关要走面板代理')
  assert.ok(src.includes("post('/panel/pet/behavior/restore'"), '放回去要走面板代理')
  assert.ok(src.includes("get('/panel/pet/behavior/status'"), '状态行要轮询 /behavior/status')
  assert.ok(src.includes("get('/panel/pet/behavior/quarantine'"), '隔离区清单要走面板代理')
  for (const a of ['chase_cursor', 'wander', 'idle_anim', 'steal_cursor', 'say', 'drag_icon', 'hide_icon', 'nudge_window', 'close_window']) {
    assert.ok(src.includes("action: '" + a + "'"), '面板动作表缺 ' + a)
  }
})

// ---------- 第三批：关窗记录 + 补偿道歉（面板代理） ----------

test('关窗记录：/playback 带 detail → 面板状态里能看到窗口名/今日次数/待道歉；道歉代理让心情回血', async () => {
  // 桌宠客户端身份回一次关窗回执（真机上由客户端 main.js 填 detail）
  const pid = 'beefcafe'
  const r = await fake.call('/playback', { playbackId: pid, action: 'close_window', status: 'played', detail: '草稿.txt - 记事本' }, petHeaders)
  assert.equal(r.status, 200, r.raw())

  const st = await call('/panel/pet/behavior/status')
  const b = st.behavior
  const playedLog = b.closeLog.filter((x) => x.status === 'played')
  assert.equal(playedLog.length, 1, '关窗账本记了一条「真关掉」的记录')
  assert.equal(playedLog[0].window, '草稿.txt - 记事本')
  assert.equal(b.closeToday, 1)
  assert.equal(b.apologyDue, true, '还没道歉 → 面板显示道歉按钮')

  const ap = await call('/panel/pet/behavior/apologize', {})
  assert.equal(ap.ok, true, JSON.stringify(ap))
  assert.match(ap.message, /记事本/)
  const st2 = await call('/panel/pet/behavior/status')
  assert.equal(st2.behavior.apologyDue, false, '道过歉不再提示')
  assert.equal(st2.behavior.closeLog.filter((x) => x.status === 'played').length, 1, '记录不删，只标记')
  assert.ok(st2.behavior.closeLog.find((x) => x.status === 'played').apologizedAt > 0)

  const again = await call('/panel/pet/behavior/apologize', {})
  assert.equal(again.ok, false, '没有待道歉的记录 → 明确告知')
})

test('面板源码契约（第三批）：有「关窗记录」卡与道歉按钮；三个窗口动作不再写「还没实现」', async () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  // 2026-10-30 面板重排：「关窗记录」从独立卡改为「行为记录」卡里的分区标题
  assert.ok(src.includes("'关窗记录'"), '缺「关窗记录」分区')
  assert.ok(src.includes("post('/panel/pet/behavior/apologize'"), '道歉按钮要走面板代理')
  assert.ok(src.includes('还没关过任何窗口'), '缺关窗记录空态文案')
  assert.ok(!src.includes('第三批，还没实现'), '第三批已实现，不该再有「还没实现」的硬编码文案')
  assert.ok(src.includes('deferredActions'), '置灰要认服务端的 deferredActions，而不是写死 tier')
})

// ---------- 行为与安全：模块级开关的唯一入口 ----------
// pet 是内置模块，DSH 面板不会给内置模块生成 settings 表单（hasUi 要求 running==='user' && !builtin），
// 所以 /panel/pet/config 是这些开关唯一能写进去的地方。不测这条，关窗物理闸随时可能又变回「打不开」。

test('行为与安全：/panel/pet/config 能写行为键，数字按范围钳制，类型不对的不收', async () => {
  const r = await call('/panel/pet/config', {
    behaviorCloseWindowEnabled: true,
    behaviorMoodCloseWindowBelow: 999,
    behaviorMinMinutes: 0,
    behaviorIconQuarantineDays: 9999,
    behaviorWindowWhitelist: 'notepad\ncode',
    behaviorEnabled: false,
    behaviorMoodCloseWindowBelow2: 1, // 不存在的键 → 无视
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  const b = (await call('/panel/pet/behavior/status')).behavior
  assert.equal(b.closeWindowEnabled, true, '物理闸必须能在这里打开（否则真机上关窗永远测不了）')
  assert.equal(b.moodCloseWindowBelow, 100, '心情闸钳到 100')
  assert.equal(b.minMinutes, 1, '最短 1 分钟（铁律）')
  assert.equal(b.iconQuarantineDays, 365, '归还天数钳到 365')
  assert.equal(b.windowWhitelist, 'notepad\ncode', '白名单原样存（含换行）')
  assert.equal(b.enabled, false, '总开关也能改')
  // 复原，别影响后面的用例
  await call('/panel/pet/config', { behaviorEnabled: true, behaviorCloseWindowEnabled: false, behaviorMoodCloseWindowBelow: 35, behaviorMinMinutes: 10, behaviorIconQuarantineDays: 7, behaviorWindowWhitelist: '' })
})

test('行为与安全：开关关着时 /behavior 下发关窗直接 400（物理闸在服务端，不靠客户端自觉）', async () => {
  await call('/panel/pet/config', { behaviorCloseWindowEnabled: false })
  const r = await call('/panel/pet/behavior', { action: 'close_window', force: true })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(r.reason, 'close-window-disabled')
  // 面板代理要把「去开哪个开关」翻成人话
  assert.match(String(r.message || ''), /允许 AI 关闭窗口/, '要告诉主人去哪个卡里开')
})

test('面板源码契约（行为与安全）：有卡片、走 /panel/pet/config、开关文案写清高危', async () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  // 2026-10-30 面板重排：「行为与安全」从独立卡改为「行为大脑」卡里的分区标题，断言改认子串
  assert.ok(src.includes("'行为与安全'"), '缺「行为与安全」分区')
  assert.ok(src.includes('behaviorCloseWindowEnabled'), '缺关窗物理闸的开关')
  assert.ok(src.includes('behaviorWindowWhitelist'), '缺白名单输入')
  assert.ok(src.includes('saveBehCfg'), '开关要走 saveBehCfg（存完清草稿 + 重拉状态）')
  assert.ok(src.includes('物理闸：AI 与「试一下」都绕不过去'), '高危提示不能省')
})

// ---------- 聊天联动：主人聊天时她可能顺带做个小动作（独立开关/范围/冷却/上限） ----------

test('聊天联动：/panel/pet/config 能写聊天联动键，数字按范围钳制，类型不对的不收', async () => {
  const r = await call('/panel/pet/config', {
    chatBehaviorEnabled: true,
    chatBehaviorCooldownMinutes: 99999, // 钳到 1440
    chatBehaviorMaxPerDay: -5,          // 钳到 0（= 不动）
    chatBehaviorWhitelist: 'private:12345\ngroup:67890',
    chatBehaviorFoo: 1, // 不存在的键 → 无视
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  const b = (await call('/panel/pet/behavior/status')).behavior
  assert.equal(b.chatBehaviorEnabled, true)
  assert.equal(b.chatBehaviorCooldownMinutes, 1440, '冷却钳到 1440')
  assert.equal(b.chatBehaviorMaxPerDay, 0, '每日上限钳到 0')
  assert.equal(b.chatBehaviorWhitelistText, 'private:12345\ngroup:67890', '范围白名单原样存（含换行）')
  // 复原
  await call('/panel/pet/config', { chatBehaviorEnabled: false, chatBehaviorCooldownMinutes: 5, chatBehaviorMaxPerDay: 20, chatBehaviorWhitelist: '' })
})

test('面板源码契约（聊天联动）：有卡、开关走 /panel/pet/config、写清「只读旁观不影响聊天」', async () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes("title: '聊天联动'"), '缺「聊天联动」卡')
  assert.ok(src.includes('chatBehaviorEnabled'), '缺聊天联动开关')
  assert.ok(src.includes('chatBehaviorWhitelist'), '缺生效范围输入')
  assert.ok(src.includes('不影响'), '要写清「不影响聊天」的承诺')
})
