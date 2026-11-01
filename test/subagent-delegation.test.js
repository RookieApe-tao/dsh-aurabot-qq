// 子智能体委派：hub.runSubagentTurn 的行为契约。
// 模块（手机逛逛等）把「自足任务书」交给它，它 spawn 一个全新子 agent 跑完、把最终文本交回来。
// 除链路本身，这里还钉住一审 #177 的权限边界：能力声明（plugin-internals）+ 主人开口（或显式开后台开关）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'

const OWNER = '10001'
const OWNER_CHAT = `private:${OWNER}`
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate) }

/** 起一个真 hub + 假 DSH：subagents 服务可注入，记录每次 startActivation 的参数。 */
function setup(t, { subagents, capabilities, config } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-subagent-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = join(root, 'data')
  const fake = createFakeDsh({ brain: async () => '' })
  const cfg = normalize({ enabled: true, dryRun: true, ownerQQ: OWNER, workspaceDir: join(root, 'workspace'), ...(config || {}) })
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((k) => [k, (...v) => fake.logs.push(v.join(' '))]))
  const hub = createHub({
    dsh: fake.ctx,
    getConfig: () => cfg,
    log,
    onebot: {},
    buildTools: () => [{ name: 'system-probe' }],
    // 模拟模块清单：phone 声明了 plugin-internals，别的没声明
    capabilitiesOf: (id) => (typeof capabilities === 'function' ? capabilities(id) : id === 'phone' ? ['network', 'plugin-internals'] : []),
  })
  const calls = []
  const disposed = []
  if (subagents !== null) {
    fake.ctx.subagents = subagents || {
      async startActivation(args) {
        calls.push(args)
        return {
          result: Promise.resolve('子智能体办好了'),
          dispose: async () => { disposed.push(args.label) },
        }
      },
    }
  }
  t.after(() => {
    hub.dispose()
    fake.dispose()
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    rmSync(root, { recursive: true, force: true })
  })
  // 默认按「主人开口」调用；权限用例自己覆盖参数
  const run = (prompt = '任务书', opts = {}) => hub.runSubagentTurn('phone', '手机逛逛', prompt, { moduleId: 'phone', source: { kind: 'owner', chatId: OWNER_CHAT }, ...opts })
  return { fake, hub, calls, disposed, cfg, run }
}

test('宿主没有 subagents 服务：明确报 SUBAGENT_UNAVAILABLE，不吞成空结果', async (t) => {
  // null = 显式不注入服务（旧版 DSH 的样子）
  const s = setup(t, { subagents: null })
  await assert.rejects(s.run(), (error) => {
    assert.equal(error.code, 'SUBAGENT_UNAVAILABLE')
    assert.match(error.message, /subagents/)
    return true
  })
})

test('委派契约：spawn + delivery:"caller" + 显式 agentPreset，父级常驻并复用', async (t) => {
  const s = setup(t)
  const first = await s.run('打开手机，刷十分钟，回来告诉我看到了什么')
  assert.equal(first, '子智能体办好了')

  const call = s.calls[0]
  assert.equal(call.provider, 'spawn', '必须用 spawn 后端（子级独立会话、空历史）')
  assert.equal(call.delivery, 'caller', '结果要直接回给调用方，不能挤进工作区聊天流')
  assert.equal(call.request.agentPreset, 'aurabot-subagent', '不显式指定就会继承 aurabot-social（零本地工具），子级拿不到 shell')
  assert.equal(call.request.prompt[0].type, 'text')
  assert.equal(call.request.prompt[0].text, '打开手机，刷十分钟，回来告诉我看到了什么')
  assert.equal(call.label, '手机逛逛', 'label 直接用任务标题')
  assert.ok(call.signal instanceof AbortSignal, '要把可中止信号交给服务（超时要能掐断）')

  // 父级必须是活着的 agent 句柄（spawn 子级的前提），且第二次委派复用同一个，不重复建会话
  const parent = call.request.parent
  assert.ok(parent && typeof parent.id === 'string' && parent.id, 'parent 必须是 agent 句柄')
  const second = await s.run('再刷五分钟')
  assert.equal(second, '子智能体办好了')
  assert.equal(s.calls[1].request.parent.id, parent.id, '父级会话复用，不能每趟新建')
  assert.equal(s.calls[1].request.parent.preset, 'aurabot-social', '父级是社交档（带工具的挂载）')

  // 结果拿到后要主动释放子树
  await settle()
  assert.deepEqual(s.disposed, ['手机逛逛', '手机逛逛'])
})

test('结果形状兜底：字符串 / 消息块数组 / 包着 output 的对象，都取最后一段有效文本', async (t) => {
  const shapes = [
    ['纯字符串', '直接给的答案', '直接给的答案'],
    ['消息块数组', [{ type: 'text', text: '先想了下' }, { type: 'text', text: '最终答案' }], '最终答案'],
    ['对象 output', { output: '对象里的答案' }, '对象里的答案'],
    ['对象 text', { text: 'text 字段的答案' }, 'text 字段的答案'],
  ]
  for (const [name, result, want] of shapes) {
    const s = setup(t)
    s.fake.ctx.subagents = { async startActivation() { return { result: Promise.resolve(result), dispose: async () => {} } } }
    assert.equal(await s.run(), want, name)
  }
})

test('子智能体失败：result 带 error 时抛错，但子树仍然释放（不泄漏挂载）', async (t) => {
  const s = setup(t)
  const disposed = []
  s.fake.ctx.subagents = {
    async startActivation() {
      return { result: Promise.resolve({ error: '模型超时' }), dispose: async () => { disposed.push(1) } }
    },
  }
  await assert.rejects(s.run(), /子智能体执行失败：模型超时/)
  await settle()
  assert.equal(disposed.length, 1, '失败路径也要 dispose')
})

// ---------- 一审 #177 的权限边界 ----------

test('能力声明：模块没在 module.json 声明 plugin-internals 就不许委派', async (t) => {
  const s = setup(t)
  // 换个没声明能力的模块 id
  await assert.rejects(s.hub.runSubagentTurn('other', '别的模块', '任务书', { moduleId: 'other', source: { kind: 'owner', chatId: OWNER_CHAT } }), (error) => {
    assert.equal(error.code, 'CAPABILITY_REQUIRED')
    return true
  })
  // 完全没传 moduleId 也一样
  await assert.rejects(s.hub.runSubagentTurn('probe', '探测', '任务书'), (error) => {
    assert.equal(error.code, 'CAPABILITY_REQUIRED')
    return true
  })
  assert.equal(s.calls.length, 0, '被拒时不能真的 spawn')
})

test('主人开口：只有主人私聊来源放行；群里/别人/没来源一律拒绝（无人应答 = 拒绝）', async (t) => {
  const s = setup(t)
  const runWith = (source) => s.hub.runSubagentTurn('phone', '手机逛逛', '任务书', { moduleId: 'phone', source })
  await assert.rejects(runWith(null), (e) => e.code === 'OWNER_REQUIRED')
  await assert.rejects(runWith({ kind: 'owner', chatId: 'group:12345' }), (e) => e.code === 'OWNER_REQUIRED')
  await assert.rejects(runWith({ kind: 'owner', chatId: 'private:99999' }), (e) => e.code === 'OWNER_REQUIRED')
  await assert.rejects(runWith({ kind: 'system', reason: 'cron' }), (e) => e.code === 'OWNER_REQUIRED')
  assert.equal(s.calls.length, 0)
})

test('后台开关：config.subagentBackground 打开后才允许 system 来源（定时任务）', async (t) => {
  const s = setup(t, { config: { subagentBackground: true } })
  const out = await s.hub.runSubagentTurn('phone', '定时逛逛', '任务书', { moduleId: 'phone', source: { kind: 'system', reason: 'cron' } })
  assert.equal(out, '子智能体办好了')
  assert.equal(s.calls.length, 1)
})

test('cordis.patch.yml 里有专给子级的 aurabot-subagent preset：本机工具 + 无 QQ 人格', () => {
  const yml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(yml, /id:\s*preset-aurabot-subagent/, 'preset 条目必须存在')
  const block = yml.slice(yml.indexOf('id: preset-aurabot-subagent'))
  const body = block.slice(0, block.indexOf('- id: preset-aurabot-social') > 0 ? block.indexOf('- id: preset-aurabot-social') : block.length)
  assert.match(body, /id:\s*aurabot-subagent/, 'preset id 与 hub 指定的一致')
  assert.match(body, /dsh-tool-pwsh/, 'Windows 上要能跑命令')
  assert.match(body, /dsh-tool-fs/, '要能读写文件')
  assert.doesNotMatch(body, /aurabot_persona/, '子级不带 QQ 人格')
})
