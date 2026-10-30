// 桌宠「聊天联动动作」测试（2026-10-30）：
//   · 默认关；只读旁观 activity 事件（不接管消息、不影响聊天管线）
//   · 生效范围白名单：留空 = 只有主人私聊；配置后精确 chatId 匹配
//   · 决策走独立 key 的后台回合（key:'chatBehavior'），只挑安分子集动作（chase_cursor/wander/idle_anim/say）
//   · 模型选 none / 废单 → 安静收场，不记次数；冷却与每日上限独立于定时行为大脑
// 全程 AURABOT_DATA_DIR 隔离，fake api 仿 test/pet-behavior.test.js + activity 监听面，不引入新依赖。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let mod
const OWNER = '10000001'
const MODULE_DIR = fileURLToPath(new URL('../src/modules/pet', import.meta.url))

before(async () => {
  mod = (await import('../src/modules/pet/index.js')).default
})

beforeEach(() => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-pet-chat-'))
})

// ---------- 假模块环境（与 test/pet-behavior.test.js 同一个 makeApi 面 + activity 监听） ----------

function startModule({ settings = {} } = {}) {
  const s = { carrier: 'pet', modality: 'text', petFallbackToQQ: true, pack: 'default', ...settings }
  const routes = new Map()
  const sentToQQ = []
  const listeners = new Map() // 事件名 → [fn]（对齐 modules.js 的 api.on 面）
  const api = {
    id: 'pet',
    dir: MODULE_DIR,
    version: 'test',
    __petTestHooks: {},
    log: { info() {}, warn() {}, debug() {}, error() {} },
    dataDir: (...parts) => join(process.env.AURABOT_DATA_DIR, 'modules-data', 'pet', ...parts),
    // 全天醒着：与 pet-behavior.test.js 同口径，不受测试运行时段影响
    config: () => ({ ownerQQ: OWNER, speakUp: { awakeFrom: 0, awakeTo: 24 } }),
    settings: () => ({ ...s }),
    saveSettings: (patch) => { Object.assign(s, patch); return { ...s } },
    route: (path, handler) => { routes.set(path, handler) },
    every: () => () => {},
    onDispose: () => {},
    on: (event, fn) => { listeners.set(event, [...(listeners.get(event) || []), fn]) },
    has: (id) => id === 'mood' || id === 'memory',
    use: (id) => (id === 'mood' ? { current: () => moodValue, nudge: (d, r) => nudges.push({ d, r }) }
      : id === 'memory' ? { list: () => memItems, add: (e) => memAdds.push(e) } : null),
    sendText: async (chatId, text) => { sentToQQ.push({ chatId, text }) },
    core: {
      http: {
        send: (res, code, body) => { res.statusCode = code; res.end(JSON.stringify(body)) },
        query: (req) => { try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams) } catch { return {} } },
        body: async (req) => req.__json ?? {},
      },
    },
  }
  let moodValue = 75
  let memItems = []
  let thinkReply = ''
  let focusOn = false
  const nudges = []
  const memAdds = []
  const thinkCalls = []
  api.think = async (prompt, opts = {}) => {
    thinkCalls.push({ prompt, title: opts.title, noTools: opts.noTools, timeoutMs: opts.timeoutMs, key: opts.key })
    return thinkReply
  }
  const exports = mod.setup(api) ?? {}
  const token = readFileSync(api.dataDir('host-token'), 'utf8').trim()

  function req(path, { method = 'GET', query = {}, token: tk = token, json, headers = {} } = {}) {
    const qs = new URLSearchParams(query).toString()
    return {
      method,
      url: `${path}${qs ? '?' + qs : ''}`,
      headers: { host: '127.0.0.1:53210', ...(tk ? { 'x-pet-token': tk } : {}), ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
      __json: json,
    }
  }
  async function call(path, opts = {}) {
    const handler = routes.get(path.split('?')[0])
    if (!handler) return { status: 404, json: { ok: false, message: 'no route ' + path } }
    const res = { statusCode: 200, headers: {}, raw: null, setHeader() {}, end(b) { this.raw = b } }
    await handler(req(path, opts), res)
    let body = res.raw
    try { body = JSON.parse(res.raw) } catch {}
    return { status: res.statusCode, headers: res.headers, raw: res.raw, json: body }
  }
  /** 模拟客户端连上长轮询（顺带刷新心跳 = 桌宠在线）；wantEvents=true 时取增量事件。 */
  async function connect({ wantEvents = false, since } = {}) {
    const first = await call('/events', { query: { wait: '0', client: 'pet-test' } })
    assert.equal(first.json.ok, true)
    if (!wantEvents) return { cursor: first.json.cursor, events: [] }
    const r = await call('/events', { query: { since: String(since ?? first.json.cursor), wait: '0', client: 'pet-test' } })
    return { cursor: first.json.cursor, events: r.json.events }
  }
  return {
    api, exports, call, connect, token, sentToQQ, nudges, memAdds, thinkCalls,
    setMood: (v) => { moodValue = v }, setThinkReply: (t) => { thinkReply = t }, setFocus: (v) => { focusOn = v },
    setSettings: (patch) => { Object.assign(s, patch) },
    /** 模拟宿主广播 activity 事件（fire-and-forget，等微任务落地）。 */
    emitActivity: async (msg) => {
      for (const fn of listeners.get('activity') || []) { try { fn(msg) } catch {} }
      await new Promise((r) => setTimeout(r, 0))
    },
  }
}

const MSG_OWNER = { kind: 'in', chatId: `private:${OWNER}`, userId: OWNER, text: '今天好累呀，陪我聊聊', direct: true, owner: true }

// ---------- 开关与只读旁观 ----------

test('默认关：聊天联动关着时主人发消息也不触发决策（聊天管线完全不受影响）', async () => {
  const env = startModule()
  await env.connect()
  const r = await env.exports.chatBehavior(MSG_OWNER)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'disabled')
  assert.equal(env.thinkCalls.length, 0, '没到决策那一步，一次模型调用都没有')
  assert.equal(env.sentToQQ.length, 0, '联动绝不发 QQ')
})

test('只读旁观：activity 监听器只认「收到消息」，不接管、不阻塞；out 方向不触发', async () => {
  const env = startModule({ settings: { chatBehaviorEnabled: true } })
  await env.connect()
  await env.emitActivity({ kind: 'out', chatId: `private:${OWNER}`, text: '她自己的回复' })
  assert.equal(env.thinkCalls.length, 0, '她发出去的话不触发联动')
  await env.emitActivity(MSG_OWNER)
  assert.equal(env.thinkCalls.length, 1, '收到的消息触发一次决策（fire-and-forget）')
})

// ---------- 生效范围白名单 ----------

test('生效范围：留空 = 只有主人私聊生效；群聊和别人的私聊一律不触发', async () => {
  const env = startModule({ settings: { chatBehaviorEnabled: true } })
  await env.connect()
  assert.equal((await env.exports.chatBehavior({ ...MSG_OWNER, chatId: 'group:888' })).reason, 'not-allowed')
  assert.equal((await env.exports.chatBehavior({ ...MSG_OWNER, chatId: 'private:999' })).reason, 'not-allowed')
  assert.equal((await env.exports.chatBehavior(MSG_OWNER)).reason, 'parse', '主人的私聊过了范围闸（模型没回内容，卡在解析）')
})

test('生效范围：配了白名单就精确匹配 chatId；非法行（没写 private:/group:）直接丢弃', async () => {
  const env = startModule({ settings: { chatBehaviorEnabled: true, chatBehaviorWhitelist: 'group:888\n某人私聊\nprivate:999' } })
  const cb = env.exports.chatBehaviorSettings()
  assert.deepEqual(cb.whitelist, ['group:888', 'private:999'], '非法行被过滤')
  await env.connect()
  assert.equal((await env.exports.chatBehavior(MSG_OWNER)).reason, 'not-allowed', '主人不在白名单里也不行（白名单非空按精确匹配）')
  assert.equal((await env.exports.chatBehavior({ ...MSG_OWNER, chatId: 'group:888' })).reason, 'parse', '白名单里的群过了范围闸')
})

test('生效范围：行内空白先归一再匹配——冒号后带空格这类手滑也能认（审查建议）', () => {
  const env = startModule({ settings: { chatBehaviorEnabled: true, chatBehaviorWhitelist: 'group: 888\n private:999 \nprivate：777（全角冒号算非法）' } })
  const cb = env.exports.chatBehaviorSettings()
  assert.deepEqual(cb.whitelist, ['group:888', 'private:999'], '半角冒号 + 空白的行归一后命中；全角冒号仍按非法丢弃')
})

test('每日上限跨天清零：day 翻转后 count 归零，不会把昨天的次数带进今天（审查建议）', () => {
  const env = startModule({ settings: { chatBehaviorEnabled: true, chatBehaviorMaxPerDay: 2 } })
  const file = env.api.dataDir('chat-behavior.json')
  const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toDateString()
  writeFileSync(file, JSON.stringify({ day: yesterday, count: 2, lastAt: Date.now() - 10 * 60_000, lastChatId: 'group:888' }))
  const s = env.exports.behaviorStatus()
  assert.equal(s.chatBehaviorToday, 0, '昨天的 2 次不计入今天')
})

// ---------- 决策与下发 ----------

test('决策：主人私聊 + 模型给合法动作单 → 走独立会话 key、behavior 事件带 reason=chat、次数落盘', async () => {
  const env = startModule({ settings: { chatBehaviorEnabled: true } })
  await env.connect()
  env.setThinkReply('{"action":"idle_anim","params":{},"say":"（蹭了蹭主人的手）","moodDelta":2}')
  const { cursor } = await env.connect()
  const r = await env.exports.chatBehavior(MSG_OWNER)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.action, 'idle_anim')
  assert.equal(env.thinkCalls[0].key, 'chatBehavior', '独立会话，不与碎碎念/行为大脑抢同一条')
  assert.equal(env.thinkCalls[0].noTools, true)
  assert.ok(env.thinkCalls[0].prompt.includes('今天好累呀'), '简报里带这条消息本身')
  assert.ok(env.thinkCalls[0].prompt.includes('none'), '提示词里给了「不做动作」的出口')
  assert.ok(!env.thinkCalls[0].prompt.includes('close_window'), '安分子集：高危动作根本不进聊天联动的动作表')
  const ev = await env.connect({ wantEvents: true, since: cursor })
  const b = ev.events.find((x) => x.type === 'behavior')
  assert.ok(b, 'behavior 事件已下发')
  assert.equal(b.reason, 'chat') // 事件载荷是平铺结构（emit 把 payload 展开进事件对象）
  assert.equal(b.action, 'idle_anim')
  assert.equal(b.say, '（蹭了蹭主人的手）')
  assert.equal(env.nudges.at(-1)?.d, 2, 'moodDelta 抬心情')
  const st = JSON.parse(readFileSync(env.api.dataDir('chat-behavior.json'), 'utf8'))
  assert.equal(st.count, 1, '次数落盘（独立于 behavior.json）')
  assert.equal(st.lastChatId, `private:${OWNER}`)
})

test('分寸：模型选 none 或给废单 → 安静收场，不下发也不记次数', async () => {
  const env = startModule({ settings: { chatBehaviorEnabled: true } })
  await env.connect()
  env.setThinkReply('{"action":"none"}')
  assert.equal((await env.exports.chatBehavior(MSG_OWNER)).reason, 'declined')
  env.setThinkReply('{"action":"close_window","params":{}}')
  assert.equal((await env.exports.chatBehavior(MSG_OWNER)).reason, 'parse', '高危动作不在聊天联动动作表里 = 废单')
  env.setThinkReply('{"action":"say","params":{"text":""}}')
  assert.equal((await env.exports.chatBehavior(MSG_OWNER)).reason, 'parse', '「说话」没给内容 = 废单')
  const file = env.api.dataDir('chat-behavior.json')
  const st = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  assert.equal(st.count || 0, 0, '一次都没记数')
  const ev = await env.connect({ wantEvents: true })
  assert.equal(ev.events.filter((x) => x.type === 'behavior').length, 0, '没有下发任何 behavior 事件')
})

test('say 动作只保留 text 参数，丢弃其余字段（聊天入口参数面最小化）', () => {
  const env = startModule()
  const p = env.exports.chatBehaviorParse('{"action":"say","params":{"text":"喵","icon":"a.lnk","x":9},"say":"（喵）","moodDelta":99}')
  assert.equal(p.action, 'say')
  assert.deepEqual(p.params, { text: '喵' }, '其余参数一律丢弃')
  assert.equal(p.moodDelta, 10, 'moodDelta 钳到 ±10')
  assert.equal(env.exports.chatBehaviorParse('{"action":"steal_cursor"}'), null, '叼鼠标不在安分子集里')
  assert.equal(env.exports.chatBehaviorParse('不是 JSON'), null)
})

// ---------- 冷却 / 上限 / 专注 / 离线 ----------

test('冷却与每日上限：独立配额；force 语义不适用（聊天联动没有手动 force）', async () => {
  const env = startModule({ settings: { chatBehaviorEnabled: true, chatBehaviorCooldownMinutes: 5, chatBehaviorMaxPerDay: 2 } })
  await env.connect()
  env.setThinkReply('{"action":"wander","params":{},"say":"","moodDelta":0}')
  assert.equal((await env.exports.chatBehavior(MSG_OWNER)).ok, true)
  assert.equal((await env.exports.chatBehavior(MSG_OWNER)).reason, 'cooldown', '5 分钟内第二条被冷却拦住')
  assert.equal(env.thinkCalls.length, 1, '冷却在决策前拦，不多花模型调用')
  // 把冷却时间拨回 6 分钟前 → 放行第二次；第三次撞每日上限
  const file = env.api.dataDir('chat-behavior.json')
  const st = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...st, lastAt: Date.now() - 6 * 60_000 }))
  assert.equal((await env.exports.chatBehavior(MSG_OWNER)).ok, true)
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), lastAt: Date.now() - 6 * 60_000 }))
  assert.equal((await env.exports.chatBehavior(MSG_OWNER)).reason, 'daily-max', '第 3 次撞每日上限')
  assert.equal(env.thinkCalls.length, 2)
})

test('专注模式开着不联动；桌宠离线没人演也不联动（都不花模型调用）', async () => {
  const env = startModule({ settings: { chatBehaviorEnabled: true } })
  await env.connect()
  // 专注闸走模块自己的 /focus 路由（focus.json 落盘），不是测试里的本地变量
  await env.call('/focus', { method: 'POST', json: { enabled: true, source: 'test' } })
  assert.equal((await env.exports.chatBehavior(MSG_OWNER)).reason, 'focus')
  // 离线：新开一个模块环境，不模拟客户端心跳 → online() 判假
  const env2 = startModule({ settings: { chatBehaviorEnabled: true } })
  assert.equal((await env2.exports.chatBehavior(MSG_OWNER)).reason, 'pet-offline')
  assert.equal(env2.thinkCalls.length, 0, '没人演就不花模型调用')
  assert.equal(env.thinkCalls.length, 0, '专注闸在决策前拦')
})

test('行为状态里能看到聊天联动的配置与计数（面板「聊天联动」卡的数据源）', async () => {
  const env = startModule({ settings: { chatBehaviorEnabled: true, chatBehaviorCooldownMinutes: 3 } })
  const s = env.exports.behaviorStatus()
  assert.equal(s.chatBehaviorEnabled, true)
  assert.equal(s.chatBehaviorCooldownMinutes, 3)
  assert.equal(s.chatBehaviorMaxPerDay, 20)
  assert.equal(s.chatBehaviorToday, 0)
  assert.equal(s.chatBehaviorWhitelistText, '')
})
