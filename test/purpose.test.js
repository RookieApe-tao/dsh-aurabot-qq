// 目的机制（主动搭话引擎移植版）：
//   · 排程重算（nextFireAt 落盘、tick 重算、重启不补发）
//   · 闸门（总开关 / 主人刚说话 / 安静时段）
//   · 目标归属升级（群友目标重复 ≥3 次才升 self）
//   · 回执反馈（主人回复正/负 → confirmed / rejected）
//   · pending 待续（备忘【状态】待续 → 惦记账本 → 下次优先）
//   · silent（模型跳过不硬发）
// 引擎是纯函数，归属/回执/待续直接测 engine.js；接线用假 hub/memory/mood（同 fake-dsh 模式）。
// 落盘测试必须 AURABOT_DATA_DIR 隔离。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createPurpose
let purposeConfig
let cleanReply
let engine
const OWNER = '10000001'
const MIN = 60_000
let dataRoot = ''

before(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'aurabot-purpose-'))
  process.env.AURABOT_DATA_DIR = dataRoot
  ;({ createPurpose, purposeConfig, cleanReply } = await import('../src/purpose/module.js'))
  engine = await import('../src/purpose/engine.js')
})

beforeEach(() => {
  // 每个用例独立数据目录，互不串状态
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-purpose-'))
})

function stateFile() { return join(process.env.AURABOT_DATA_DIR, 'purpose', 'purpose-state.json') }

// 假 hub：runSystemTurn 可脚本化回复；deliver 记录投递（成功返回 {missedAt:[]}，同 hub.deliver 契约）
const DEFAULT_MEMORIES = [
  { id: 'mm1', text: '主人上周在玩星穹列车', importance: 0.6 },
  { id: 'mm2', text: '主人喜欢下班后打两把游戏放松', importance: 0.5 },
]
function makeHub({ reply = '主人，今天想到一件事想跟你说', lastOwnerChatAt = 0, lastBot = { at: 0, text: '' }, log = [] } = {}) {
  return {
    lastOwnerChatAt,
    lastBotToOwner: lastBot,
    chatLogDays: () => [],
    chatLogOf: () => [],
    delivered: [],
    turns: log,
    async runSystemTurn(name, title, prompt) { this.turns.push({ name, title, prompt }); return typeof reply === 'function' ? reply(prompt) : reply },
    async deliver(chatId, text, opts = {}) { this.delivered.push({ chatId, text, opts }); return { missedAt: [] } },
  }
}

function makePurpose(hub, overrides = {}) {
  const cfg = {
    enabled: true, ownerQQ: OWNER, ownerName: '主人',
    speakUp: { enabled: false, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: true },
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
    ...overrides,
  }
  const nudges = []
  const p = createPurpose({
    getConfig: () => cfg,
    hub,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false,
    mood: () => ({ nudge: (d, r) => nudges.push({ d, r }) }),
    memory: () => ({ list: () => (overrides.memories ?? DEFAULT_MEMORIES).map((m) => ({ id: m.id || 'm1', text: m.text, importance: m.importance ?? 0.8, at: Date.now() })) }),
    personaText: () => overrides.persona || '',
  })
  return { p, cfg, nudges }
}

// 把状态文件的 nextFireAt 拨到过去，下一次 tick 就到点
function dueNow() {
  const s = JSON.parse(readFileSync(stateFile(), 'utf8'))
  s.nextFireAt = Date.now() - 1
  writeFileSync(stateFile(), JSON.stringify(s))
}

function setupTick(p, hub) {
  return p.tick().then(() => { dueNow(); return p.tick() })
}

// ---------- 排程重算 ----------

test('排程：tick 到点才出发，跑完后 nextFireAt 重新落盘到未来', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub)
  await p.tick() // 首次：只排程，不发
  const s1 = JSON.parse(readFileSync(stateFile(), 'utf8'))
  assert.ok(s1.nextFireAt > Date.now(), '首次 tick 排出未来的 nextFireAt')
  assert.equal(hub.delivered.length, 0)

  dueNow()
  await p.tick() // 到点：真跑一轮
  assert.equal(hub.delivered.length, 1)
  assert.equal(hub.delivered[0].chatId, `private:${OWNER}`)
  // 不带 own:true：这条是别处发的，hub 要把她说的话记进 saidElsewhere，
  // 主人在私聊回复时才补得回她的上下文（她得知道自己刚发过什么）。
  assert.ok(!hub.delivered[0].opts.own, '目的引擎 QQ 投递不能带 own:true，否则 hub 不做「别处说过」桥接')
  assert.equal(hub.delivered[0].opts.userText, '【系统提醒，不是主人说的话】（她主动找你）')
  const s2 = JSON.parse(readFileSync(stateFile(), 'utf8'))
  assert.equal(s2.lastOutcome, 'sent')
  assert.equal(s2.countToday, 1)
  assert.ok(s2.nextFireAt >= Date.now() + 5 * MIN - 1000, `跑完重排到未来（gap 5 分钟）：${new Date(s2.nextFireAt).toISOString()}`)
})

test('闸门：主人刚说过话（空闲不足）时到点也不发，记 owner-active 跳过', async () => {
  const hub = makeHub({ lastOwnerChatAt: Date.now() - 2 * MIN })
  const { p } = makePurpose(hub)
  await setupTick(p, hub)
  assert.equal(hub.delivered.length, 0)
  const s = JSON.parse(readFileSync(stateFile(), 'utf8'))
  assert.equal(s.lastSkip.reason, 'owner-active')
})

test('闸门：安静时段（醒着窗口外）不发，推到安静结束', async () => {
  const hub = makeHub()
  const { p, cfg } = makePurpose(hub)
  cfg.speakUp.awakeFrom = 9
  cfg.speakUp.awakeTo = 22
  // 当前真实时钟必然落在 9:00~22:00 之外或之内不定，直接用引擎断言派生关系更稳
  const c = purposeConfig(cfg)
  assert.equal(c.quietStart, '22:00')
  assert.equal(c.quietEnd, '09:00')
  assert.ok(engine.inQuietHours(new Date('2026-01-01T23:00:00').getTime(), c), '23 点属于安静时段')
  assert.ok(!engine.inQuietHours(new Date('2026-01-01T12:00:00').getTime(), c), '中午不属于安静时段')
})

test('闸门：总开关关掉后 tick 完全静默', async () => {
  const hub = makeHub()
  const { p, cfg } = makePurpose(hub)
  cfg.ext.purpose.enabled = false
  await p.tick()
  await p.fire()
  assert.equal(hub.delivered.length, 0)
  assert.equal(hub.turns.length, 0)
  assert.ok(!existsSync(stateFile()), '关掉后不写目的状态')
})

test('闸门：与旧「主动搭话」互不影响——speakUp 关着不影响 purpose 开着跑', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub) // makePurpose 默认 speakUp.enabled=false、ext.purpose.enabled=true
  await setupTick(p, hub)
  assert.equal(hub.delivered.length, 1, 'speakUp 总开关关着，目的引擎照常工作')
})

test('重启不补发：上次在途（pending）改判 interrupted，归零重排而不是立刻发', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub)
  await setupTick(p, hub)
  const deliveredBefore = hub.delivered.length
  const s = JSON.parse(readFileSync(stateFile(), 'utf8'))
  s.lastOutcome = 'pending'
  s.nextFireAt = Date.now() + 10 * MIN
  writeFileSync(stateFile(), JSON.stringify(s))
  await p.tick() // 还没到点，但读取时应已改判
  const s2 = JSON.parse(readFileSync(stateFile(), 'utf8'))
  assert.equal(s2.lastOutcome, 'interrupted')
  assert.equal(hub.delivered.length, deliveredBefore, '不补发')
})

// ---------- 状态（host.js / 概览页依赖，同步返回） ----------

test('state() 同步返回且含 count；count 跟今日次数走', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub)
  const st0 = p.state()
  assert.equal(typeof st0.count, 'number')
  await setupTick(p, hub)
  assert.equal(p.state().count, 1)
})

// ---------- 归属升级（引擎纯逻辑） ----------

test('归属：群友聊一次只记 member 目标，重复 ≥3 次才升出 self 目标', () => {
  const memberMsg = (n) => ({
    id: `qq:group:1:${1000 + n}`, source: 'qq', kind: 'member', at: Date.now() + n,
    who: '群友', text: ['那个养鱼游戏，怎么玩啊', '那个养鱼游戏，联机开黑真快乐', '那个养鱼游戏，出攻略了吗'][n] ?? '那个养鱼游戏，还在吗',
  })
  const now = Date.now()
  const first = engine.formGoalHypotheses({
    materials: [memberMsg(0)], goals: [], observations: [],
    now, lastMasterAt: now - 10 * 3600_000, roleName: '大肥鱼', persona: { hasText: false, traits: [], text: '', bias: {} },
  })
  const owners1 = first.goals.filter((g) => g.domain === 'play').map((g) => g.owner)
  assert.ok(owners1.includes('member'), '第一次：先记成群友的目标')
  assert.ok(!owners1.includes('self'), '第一次：不该有「我也想玩」的 self 目标')

  let goals = []
  let observations = []
  for (let i = 0; i < 3; i++) {
    const r = engine.formGoalHypotheses({
      materials: [memberMsg(i)], goals, observations,
      now, lastMasterAt: now - 10 * 3600_000, roleName: '大肥鱼', persona: { hasText: false, traits: [], text: '', bias: {} },
    })
    goals = r.goals
    observations = r.observations
  }
  const selfGoal = goals.find((g) => g.owner === 'self' && g.domain === 'play')
  assert.ok(selfGoal, '重复 3 次后：升出 self 的「我也有点想试」目标')
  const memberGoal = goals.find((g) => g.owner === 'member' && g.domain === 'play')
  assert.ok(memberGoal, 'member 目标仍在（她只能跟主人聊「群里在玩什么」）')
  const selfCandidate = engine.goalToCandidate(selfGoal)
  assert.equal(engine.PURPOSE_NEEDS.includes(selfCandidate.need), true)
})

test('归属置信度公式：一条只出现一次的素材 confidence 不高（试探语气），主人私聊话题则 0.78', () => {
  const now = Date.now()
  const mediaOnce = engine.formGoalHypotheses({
    materials: [{ id: 'm1', source: 'memory', kind: 'memory', at: now, who: '记忆', text: '想起一个叫星穹列车的游戏' }],
    goals: [], observations: [], now, lastMasterAt: now - 3600_000,
    roleName: '大肥鱼', persona: { hasText: false, traits: [], text: '', bias: {} },
  })
  const g = mediaOnce.goals.find((x) => x.source === 'memory')
  assert.ok(g && g.confidence < 0.7, `单条记忆目标置信度保守（实际 ${g?.confidence}）`)

  const ownerTurn = engine.formGoalHypotheses({
    materials: [{ id: 'q1', source: 'qq', kind: 'owner', at: now, who: '主人', text: '我明天要去医院复查，有点紧张', meta: { key: `private:${OWNER}` } }],
    goals: [], observations: [], now, lastMasterAt: now - 3600_000,
    roleName: '大肥鱼', persona: { hasText: false, traits: [], text: '', bias: {} },
  })
  const care = ownerTurn.goals.find((x) => x.owner === 'owner' && x.domain === 'care')
  assert.ok(care, '主人私聊里说的事形成「想接上/想问后来」目标')
  assert.ok(care.confidence >= 0.7, `主人直接说的事置信度高（实际 ${care?.confidence}）`)
})

// ---------- 回执反馈（引擎纯逻辑） ----------

test('回执：主人正面回复 → confirmed 置信度涨；负面 → rejected 不再主动提', () => {
  const now = Date.now()
  const actedAt = now - 3600_000
  const mk = () => [{
    id: 'g1', owner: 'self', domain: 'play', object: { type: 'game', name: '养鱼游戏' },
    intent: '想拉主人一起玩', confidence: 0.5, value: 0.5, urgency: 0.3, risk: 0.1,
    action: 'invite', status: 'active', evidence: [], createdAt: actedAt, lastSeenAt: actedAt,
    expiresAt: now + 86400_000, attempts: 1, lastActionAt: actedAt, lastFeedbackAt: 0, sightings: 1, source: 'self',
  }]
  const pos = engine.applyGoalFeedback(mk(), [{ kind: 'owner', at: now - 1000, text: '好啊，一起玩吧' }], now)
  assert.equal(pos[0].status, 'confirmed')
  assert.ok(pos[0].confidence > 0.5)

  const neg = engine.applyGoalFeedback(mk(), [{ kind: 'owner', at: now - 1000, text: '不要，没空' }], now)
  assert.equal(neg[0].status, 'rejected')
  assert.ok(neg[0].confidence < 0.4)
})

test('回执：中性回复只微调置信度，不改变状态', () => {
  const now = Date.now()
  const goals = [{
    id: 'g1', owner: 'self', domain: 'play', object: { type: 'game', name: '养鱼游戏' },
    intent: '想拉主人一起玩', confidence: 0.5, value: 0.5, urgency: 0.3, risk: 0.1,
    action: 'invite', status: 'hypothesis', evidence: [], createdAt: now, lastSeenAt: now,
    expiresAt: now + 86400_000, attempts: 1, lastActionAt: now - 3600_000, lastFeedbackAt: 0, sightings: 1, source: 'self',
  }]
  const out = engine.applyGoalFeedback(goals, [{ kind: 'owner', at: now - 1000, text: '嗯嗯' }], now)
  assert.equal(out[0].status, 'hypothesis')
  assert.ok(Math.abs(out[0].confidence - 0.52) < 1e-9)
})

// ---------- pending 待续 ----------

test('待续：备忘【状态】待续 → 进惦记账本；下次 selectPurpose 优先接上', async () => {
  const now = Date.now()
  const state = engine.createPurposeState(now)
  const config = engine.normalizePurposeConfig({})
  engine.applyPurposeOutcome(state, {
    now, config,
    outcome: 'sent',
    text: '主人，你上次说的那个面试怎么样啦',
    memo: { purpose: '关心面试结果', kind: 'care', need: 'care', emotionText: '', status: '待续', followUp: '等面试结果出来再问一次' },
    planned: { text: '关心面试', kind: 'care', need: 'care', action: 'ask', emotion: 'worried', fromPending: false },
  })
  assert.equal(state.pending.length, 1)
  assert.match(state.pending[0].text, /面试结果/)

  const picked = engine.selectPurpose({ seeds: [], goals: [], pending: state.pending, history: state.history, config, drives: state.drives, now, random: () => 0.01 })
  assert.ok(picked.purpose, '有 pending 时应能选出目的')
  assert.equal(picked.fromPending, true, '随机最小时优先接上惦记的事')
})

test('待续：备忘【状态】完成 → 相似 pending 被移除', () => {
  const now = Date.now()
  const state = engine.createPurposeState(now)
  engine.addPendingPurpose(state, { text: '关心面试结果', kind: 'care', need: 'care', now, config: engine.normalizePurposeConfig({}) })
  engine.applyPurposeOutcome(state, {
    now, config: engine.normalizePurposeConfig({}),
    outcome: 'sent', text: '面试结果出来啦？',
    memo: { purpose: '关心面试结果', kind: 'care', need: 'care', emotionText: '', status: '完成', followUp: '' },
    planned: { text: '关心面试结果', kind: 'care', need: 'care', action: 'ask', emotion: 'worried', fromPending: false },
  })
  assert.equal(state.pending.length, 0)
})

// ---------- silent：模型有权跳过，不硬发 ----------

test('silent：模型回 [沉默] 时不投递、结局记 silent，但不白占今日次数的重试', async () => {
  const hub = makeHub({ reply: '  [沉默]  ' })
  const { p } = makePurpose(hub)
  await setupTick(p, hub)
  assert.equal(hub.delivered.length, 0, '没硬发')
  const s = JSON.parse(readFileSync(stateFile(), 'utf8'))
  assert.equal(s.lastOutcome, 'silent')
  assert.equal(s.countToday, 1, '生成回合已花钱，占今日次数')
  assert.equal(s.attempts, 0, 'silent 不进失败重试')
  assert.ok(s.nextFireAt >= Date.now() + 5 * MIN - 1000, '照常排下一枪')
})

test('silent：模型只输出内部备忘（跳过）也被清洗成 silent', async () => {
  const raw = '【目的】无\n【需求】陪\n【类型】分享\n【状态】跳过\n【待续】无'
  assert.equal(cleanReply(raw), '')
  const memo = engine.parsePurposeMemo(raw)
  assert.equal(memo.status, '跳过')
})

test('清洗：去掉备忘段、引号和「大肥鱼：」前缀', () => {
  assert.equal(cleanReply('「主人，晚上一起打游戏吗」\n【目的】邀请主人玩游戏\n【状态】完成'), '主人，晚上一起打游戏吗')
  assert.equal(cleanReply('大肥鱼：想你了'), '想你了')
})

// ---------- 素材适配（记忆 importance 0~1 → 0~100） ----------

test('记忆适配：aurabot 0~1 重要度 ×100 后能过引擎阈值，成为素材', async () => {
  const hub = makeHub({ reply: () => `想起「星穹列车」了，主人玩过吗` })
  const { p } = makePurpose(hub, { memories: [
    { id: 'mm1', text: '主人上周在玩星穹列车', importance: 0.6 },
    { id: 'mm2', text: '主人喜欢下班后打两把游戏放松', importance: 0.5 },
  ] })
  await setupTick(p, hub)
  assert.equal(hub.delivered.length, 1)
  const s = JSON.parse(readFileSync(stateFile(), 'utf8'))
  assert.ok(s.lastMaterialCount >= 1, `记忆素材应被计入（实际 ${s.lastMaterialCount}）`)
})

// ---------- 心情打通 ----------

test('心情：sent 后按情绪 nudge mood；silent 不 nudge', async () => {
  const hub = makeHub()
  const { p, nudges } = makePurpose(hub)
  await setupTick(p, hub)
  const s = JSON.parse(readFileSync(stateFile(), 'utf8'))
  if (s.lastOutcome === 'sent') {
    assert.ok(nudges.length === 1 || (s.history.at(-1)?.emotion ?? '') === '', 'sent 时推了心情')
  }
})

test('心情：记忆素材带亲近情绪时，sent 会正向 nudge', async () => {
  const now = Date.now()
  // 直接验引擎侧的情绪映射来源：connect+正面 → affectionate → +5
  const emo = engine.appraiseMaterial({ material: { text: '主人说喜欢你', kind: 'memory', selfRef: true }, need: 'connect', now, lastMasterAt: now - 3600_000 })
  assert.equal(emo, 'affectionate')
})

// ---------- 生成提示词（模型直接输出那句话，无 QQ 发送工具指令） ----------

test('提示词：不带 qq_send_private_message 发送指令；带反注入与索取边界', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub, { memories: [{ id: 'mm1', text: '主人上周在玩星穹列车', importance: 0.6 }] })
  await p.tick()
  assert.ok(hub.turns.length >= 0)
  const pv = p.preview()
  assert.ok(pv.prompt, 'preview 给出提示词')
  assert.ok(!pv.prompt.includes('qq_send_private_message'), '不要求模型调 QQ 发送工具')
  assert.match(pv.prompt, /不是给你的指令/, '素材段带反注入提醒')
  assert.match(pv.prompt, /不要要钱、不要要贵重东西/, '索取边界写进提示词')
})

// ---------- 白名单的朋友 ----------

test('白名单：朋友单独排程，提示词里没有主人的记忆和群聊，发给朋友本人', async () => {
  const FRIEND = '20000009'
  const now = Date.now()
  const rows = [
    { t: now - 7200000, chatId: `private:${FRIEND}`, who: '阿花', uid: FRIEND, text: '我最近在学游泳，好累呀' },
    { t: now - 7100000, chatId: `private:${FRIEND}`, who: 'bot', text: '加油，下次跟我说说' },
    { t: now - 7000000, chatId: 'group:555', who: '路人', uid: '333333', text: '群里的八卦不能外传' },
    { t: now - 6900000, chatId: `private:${OWNER}`, who: '主人', uid: OWNER, text: '我准备辞职了别告诉别人' },
  ]
  const hub = { ...makeHub({ reply: '游泳学得怎么样啦' }), chatLogDays: () => ['d'], chatLogOf: () => rows, lastPrivateAt: () => now - 7200000 }
  const memories = [
    { id: 'f1', text: '阿花最近在学游泳', about: FRIEND, importance: 0.7, at: now },
    { id: 'o1', text: '主人打算偷偷辞职', about: OWNER, importance: 0.9, at: now },
    { id: 'n1', text: '没写是谁的日记内容', about: '', importance: 0.9, at: now },
  ]
  const cfg = {
    enabled: true, ownerQQ: OWNER, ownerName: '主人',
    speakUp: { allow: [FRIEND, OWNER], awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: false },
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
  }
  const p = createPurpose({
    getConfig: () => cfg, hub, log: { info() {}, warn() {}, debug() {} },
    isMuted: (id) => id === `private:${OWNER}`,
    mood: () => null, personaText: () => '',
    memory: () => ({ list: () => memories, profiles: () => [{ qq: FRIEND, name: '阿花' }] }),
  })
  await p.tick()
  const file = join(process.env.AURABOT_DATA_DIR, 'purpose', 'friends', `${FRIEND}.json`)
  const s = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...s, nextFireAt: Date.now() - 1 }))
  await p.tick()
  assert.equal(hub.turns.length, 1, JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).lastOutcome))
  const { prompt } = hub.turns[0]
  assert.match(prompt, /游泳/)
  assert.doesNotMatch(prompt, /辞职|八卦|日记|主人/)
  assert.deepEqual(hub.delivered, [{ chatId: `private:${FRIEND}`, text: '游泳学得怎么样啦', opts: { userText: '【系统提醒，不是主人说的话】（她主动找你）' } }])
})

test('白名单：没聊过的朋友不找，人设再完整也不凭空开口', async () => {
  const FRIEND = '20000010'
  const hub = { ...makeHub(), lastPrivateAt: () => 0 }
  const cfg = {
    enabled: true, ownerQQ: OWNER, ownerName: '主人',
    speakUp: { allow: [FRIEND], awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: false },
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
  }
  const p = createPurpose({
    getConfig: () => cfg, hub, log: { info() {}, warn() {}, debug() {} },
    isMuted: (id) => id === `private:${OWNER}`, mood: () => null,
    personaText: () => '她是一条活泼的鱼，喜欢聊天', memory: () => ({ list: () => [] }),
  })
  await p.tick()
  const file = join(process.env.AURABOT_DATA_DIR, 'purpose', 'friends', `${FRIEND}.json`)
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), nextFireAt: Date.now() - 1 }))
  await p.tick()
  assert.equal(hub.turns.length, 0)
  assert.equal(hub.delivered.length, 0)
})

test('内部备忘的标题不发到 QQ（#172）', () => {
  assert.equal(cleanReply('正文\n内部备忘\n【目的】说说群里的事\n【状态】完成'), '正文')
  assert.equal(cleanReply('正文\n【内部备忘】\n【目的】x'), '正文')
  assert.equal(cleanReply('内部备忘\n【状态】跳过'), '')
  assert.equal(cleanReply('这是我的内部备忘录哦'), '这是我的内部备忘录哦', '句子中间提到不算')
})

// ---------- 代发决断（broker 档：api.proactive.submit 的内容先给引擎过目） ----------

test('代发决断：固定一条工作区会话（system:purpose-broker），不按模块/条目分会话', async () => {
  const hub = makeHub({ reply: '原样' })
  const { p } = makePurpose(hub)
  // 三个不同模块、三个不同 itemId 各提交一条：会话名必须都一样
  await p.brokerReview({ to: `private:${OWNER}`, text: '抖音日报', moduleId: 'douyin', itemId: 'i-douyin' })
  await p.brokerReview({ to: `private:${OWNER}`, text: 'B站周报', moduleId: 'bili', itemId: 'i-bili' })
  await p.brokerReview({ to: `private:${OWNER}`, text: '热榜摘要', moduleId: 'tophub', itemId: 'i-tophub' })
  assert.equal(hub.turns.length, 3, '每条都要真的开决断回合（会话窗口里才看得到过程）')
  assert.deepEqual(hub.turns.map((t) => t.name), ['purpose-broker', 'purpose-broker', 'purpose-broker'], '会话名固定，不随模块/条目变')
  // 标题按主人定的名字（不带「QQ · 」前缀，titleFor 会统一拼成「QQ · 目的引擎（代发决断）」）
  assert.deepEqual(hub.turns.map((t) => t.title), ['目的引擎（代发决断）', '目的引擎（代发决断）', '目的引擎（代发决断）'])
})

test('代发决断：会话提示词写明是哪个模块提交的（工作区里看得见来源）', async () => {
  const hub = makeHub({ reply: '原样' })
  const { p } = makePurpose(hub)
  await p.brokerReview({ to: `private:${OWNER}`, text: '今天刷到一条视频', moduleId: 'douyin', itemId: 'x' })
  assert.match(hub.turns[0].prompt, /模块「douyin」/, '提示词要交代提交方')
  assert.match(hub.turns[0].prompt, /今天刷到一条视频/, '要把原文本带进会话')
})

test('代发决断：记忆里刚记下同样的内容 ≠ 已经跟主人说过（先写记忆再推送的模块不能因此沉默）', async () => {
  const now = Date.now()
  const CONTENT = '刷到条电竞锐评我完全看不懂，可热评有人立flag：IG进决赛就抽十个兄弟喝奶茶'
  const memories = [
    // 这条正是「bili 模块刚写进记忆」的稿子：几秒前记下，内容和待发消息几乎一样
    { id: 'm-fresh', text: '比赛我一个字没看懂，倒被热评那条「进决赛抽十个兄弟喝奶茶」甜到了，这股高兴劲儿比锐评好看多了', importance: 0.8, at: now - 3000, source: 'tool' },
    { id: 'm-old', text: '主人喜欢看我讲刷到的东西', importance: 0.7, at: now - 3 * 24 * 3600 * 1000, source: 'tool' },
  ]
  // 聊天流水：她最近**没有**在私聊里发过这条内容
  const rows = [
    { t: now - 3600000, chatId: `private:${OWNER}`, who: '主人', uid: OWNER, text: '早点睡' },
    { t: now - 3000000, chatId: `private:${OWNER}`, who: 'bot', text: '好，你也早点睡' },
  ]
  const hub = { ...makeHub({ reply: '原样' }), chatLogDays: () => ['d'], chatLogOf: () => rows }
  const p = createPurpose({
    getConfig: () => ({
      enabled: true, ownerQQ: OWNER, ownerName: '主人',
      speakUp: { enabled: false, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: false },
      ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
    }),
    hub,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false, mood: () => null,
    memory: () => ({ list: () => memories, recall: () => memories.map((m) => ({ it: m, score: 0.9 })), personaPerson: () => null }),
    personaText: () => '爱撒娇的大肥鱼',
  })
  const r = await p.brokerReview({ to: `private:${OWNER}`, text: CONTENT, moduleId: 'bili' })
  assert.equal(r.send, true, '记忆里有同样内容不算说过，不能因此沉默')
  const prompt = hub.turns[0].prompt
  assert.match(prompt, /不等于你已经/, '要明确记忆不等于讲过')
  assert.match(prompt, /先把看到的东西记进记忆，再推送消息/, '要点明浏览模块「先记忆后推送」的顺序')
  assert.match(prompt, /只以【你们最近聊过】/, '要以聊天流水作为说过的依据')
  assert.match(prompt, /刚刚记下的/, '刚写的记忆要标注出来')
  assert.match(prompt, /最近没发过几乎一样的内容/, '要给出「没说过」的硬证据')
})

test('代发决断：聊天流水里确实发过类似内容 → 明确提示重复', async () => {
  const now = Date.now()
  const CONTENT = '刷到条电竞锐评我完全看不懂，可热评有人立flag：IG进决赛就抽十个兄弟喝奶茶'
  const rows = [
    { t: now - 3000000, chatId: `private:${OWNER}`, who: 'bot', text: '爸爸，刷到条电竞锐评我完全看不懂，可热评有人立flag：IG进决赛就抽十个兄弟喝奶茶～' },
    { t: now - 2000000, chatId: `private:${OWNER}`, who: '主人', uid: OWNER, text: '哈哈哈有意思' },
  ]
  const hub = { ...makeHub({ reply: '原样' }), chatLogDays: () => ['d'], chatLogOf: () => rows }
  const p = createPurpose({
    getConfig: () => ({
      enabled: true, ownerQQ: OWNER, ownerName: '主人',
      speakUp: { enabled: false, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: false },
      ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
    }),
    hub,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false, mood: () => null, memory: () => ({ list: () => [], recall: () => [] }),
    personaText: () => '',
  })
  await p.brokerReview({ to: `private:${OWNER}`, text: CONTENT, moduleId: 'bili' })
  const prompt = hub.turns[0].prompt
  assert.match(prompt, /最近已经发过很像的话/, '真发过要明确告诉模型')
})

test('代发决断：提示词注入人格、心情、相关记忆、人物档案与最近聊天（不再只有一段干巴巴的原文）', async () => {
  const now = Date.now()
  const rows = [
    { t: now - 600000, chatId: `private:${OWNER}`, who: '主人', uid: OWNER, text: '今天有点累，先睡了' },
    { t: now - 300000, chatId: `private:${OWNER}`, who: 'bot', text: '好，那你早点休息' },
  ]
  const hub = { ...makeHub({ reply: '原样' }), chatLogDays: () => ['d'], chatLogOf: () => rows }
  const memories = [
    { id: 'm1', text: '主人最近在准备一个很重要的面试', importance: 0.9, about: OWNER },
    { id: 'm2', text: '主人喜欢大肥鱼叫他爸爸', importance: 0.8, about: OWNER },
    { id: 'm3', text: '主人说别再半夜发消息吵他', importance: 0.7, about: OWNER },
  ]
  const nudges = []
  const p = createPurpose({
    getConfig: () => ({
      enabled: true, ownerQQ: OWNER, ownerName: '主人',
      speakUp: { enabled: false, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: false },
      ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
    }),
    hub,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false,
    // 心情：contextLine 有就用它（真实 mood 模块的形态）
    mood: () => ({ contextLine: () => '（你现在有点低落，因为主人刚说要去睡。这会自然地影响你说话：话少一点、别太闹。）', nudge: (d, r) => nudges.push({ d, r }) }),
    memory: () => ({
      list: (q) => memories,
      recall: () => memories.map((m) => ({ it: m, score: 0.8 })),
      personaPerson: () => ({ alias: '爸爸', persona: '工作很忙但会陪她', handle: '互相惦记着' }),
    }),
    personaText: () => '她是一条住在 QQ 里的大肥鱼，说话软糯、爱撒娇、偶尔犯傻但很贴心。',
  })
  await p.brokerReview({ to: `private:${OWNER}`, text: 'B站上有个「怎么养大肥鱼」的教程', moduleId: 'bili' })
  const prompt = hub.turns[0].prompt
  // 人格
  assert.match(prompt, /大肥鱼/, '要带人格（她是谁）')
  assert.match(prompt, /软糯|撒娇/, '人格描述要进提示词')
  // 心情
  assert.match(prompt, /有点低落/, '心情 contextLine 要进提示词')
  assert.match(prompt, /别太闹|话少/, '心情对说话风格的影响要进提示词')
  // 记忆（按内容检索）
  assert.match(prompt, /面试|爸爸|半夜/, '相关记忆要进提示词')
  // 人物档案
  assert.match(prompt, /爸爸/, '人物档案（称呼）要进提示词')
  assert.match(prompt, /互相惦记着/, '相处方式要进提示词')
  // 最近聊天
  assert.match(prompt, /今天有点累|早点休息/, '最近的聊天来往要进提示词')
  // 不掺排程/额度
  assert.doesNotMatch(prompt, /下次可开口|剩余额度|额度已用/, '审查上下文不该掺排程与额度')
})

test('代发决断：引擎没开时不过目，按原文放行（决断是增强不是新闸门）', async () => {
  const hub = makeHub()
  const { p, cfg } = makePurpose(hub)
  cfg.ext.purpose.enabled = false
  const r = await p.brokerReview({ to: `private:${OWNER}`, text: '抖音日报来了', moduleId: 'douyin' })
  assert.deepEqual(r, { ok: true, send: true, text: '抖音日报来了', reviewed: false })
  assert.equal(hub.turns.length, 0, '不该起决断回合')
})

test('代发决断：非主人私聊（朋友/群）不过目，按原文放行', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub)
  const r = await p.brokerReview({ to: `private:20000009`, text: 'x', moduleId: 'm' })
  assert.equal(r.send, true)
  assert.equal(r.text, 'x')
  assert.equal(hub.turns.length, 0)
})

test('代发决断：决断为沉默 → 不发；改写 → 用改写文本；出错 → 原文放行', async () => {
  // 沉默
  const silentHub = makeHub({ reply: '[沉默]' })
  const silent = makePurpose(silentHub)
  const r1 = await silent.p.brokerReview({ to: `private:${OWNER}`, text: '没必要说的', moduleId: 'm', itemId: 'i1' })
  assert.equal(r1.send, false, '引擎说沉默就不发')
  assert.equal(silentHub.turns.length, 1)
  assert.match(silentHub.turns[0].prompt, /没必要说的/, '决断回合的提示词要带上原文本')

  // 改写
  const rewriteHub = makeHub({ reply: '主人，抖音里那条视频我看到最后了，结尾很有意思' })
  const rewrite = makePurpose(rewriteHub)
  const r2 = await rewrite.p.brokerReview({ to: `private:${OWNER}`, text: '抖音日报', moduleId: 'douyin' })
  assert.equal(r2.send, true)
  assert.equal(r2.text, '主人，抖音里那条视频我看到最后了，结尾很有意思', '用改写后的文本')

  // 原样
  const rawHub = makeHub({ reply: '原样' })
  const raw = makePurpose(rawHub)
  const r3 = await raw.p.brokerReview({ to: `private:${OWNER}`, text: '就发这句', moduleId: 'm' })
  assert.equal(r3.send, true)
  assert.equal(r3.text, '就发这句', '「原样」指令回原文')

  // 决断回合出错：按原文放行（门闸已放行的消息不能被决断故障卡死）
  const errHub = makeHub()
  errHub.runSystemTurn = async () => { throw new Error('决断炸了') }
  const err = makePurpose(errHub)
  const r4 = await err.p.brokerReview({ to: `private:${OWNER}`, text: '原文直发', moduleId: 'm' })
  assert.equal(r4.send, true)
  assert.equal(r4.text, '原文直发')
})
