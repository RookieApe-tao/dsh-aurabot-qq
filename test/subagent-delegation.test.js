// 子智能体委派：hub.runSubagentTurn 的行为契约。
// 模块（手机逛逛等）把「自足任务书」交给它，它 spawn 一个全新子 agent 跑完、把最终文本交回来。
// 这里钉住四件事：宿主没服务时明确报错、spawn 参数（caller 投递 + 显式 preset + 常驻父级）、
// 结果形状的兜底收集、失败也要释放子树（activation.dispose）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate) }

/** 起一个真 hub + 假 DSH：subagents 服务可注入，记录每次 startActivation 的参数。 */
function setup(t, { subagents } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-subagent-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = join(root, 'data')
  const fake = createFakeDsh({ brain: async () => '' })
  const cfg = normalize({ enabled: true, dryRun: true, workspaceDir: join(root, 'workspace') })
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((k) => [k, (...v) => fake.logs.push(v.join(' '))]))
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log, onebot: {}, buildTools: () => [{ name: 'system-probe' }] })
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
  return { fake, hub, calls, disposed }
}

test('宿主没有 subagents 服务：明确报 SUBAGENT_UNAVAILABLE，不吞成空结果', async (t) => {
  // null = 显式不注入服务（旧版 DSH 的样子）
  const s = setup(t, { subagents: null })
  await assert.rejects(s.hub.runSubagentTurn('probe', '探测', '任务书'), (error) => {
    assert.equal(error.code, 'SUBAGENT_UNAVAILABLE')
    assert.match(error.message, /subagents/)
    return true
  })
})

test('委派契约：spawn + delivery:"caller" + 显式 agentPreset，父级常驻并复用', async (t) => {
  const s = setup(t)
  const first = await s.hub.runSubagentTurn('phone', '手机逛逛：刷了一会儿', '打开手机，刷十分钟，回来告诉我看到了什么')
  assert.equal(first, '子智能体办好了')

  const call = s.calls[0]
  assert.equal(call.provider, 'spawn', '必须用 spawn 后端（子级独立会话、空历史）')
  assert.equal(call.delivery, 'caller', '结果要直接回给调用方，不能挤进工作区聊天流')
  assert.equal(call.request.agentPreset, 'aurabot-subagent', '不显式指定就会继承 aurabot-social（零本地工具），子级拿不到 shell')
  assert.equal(call.request.prompt[0].type, 'text')
  assert.equal(call.request.prompt[0].text, '打开手机，刷十分钟，回来告诉我看到了什么')
  assert.equal(call.label, '手机逛逛：刷了一会儿', 'label 直接用任务标题')
  assert.ok(call.signal instanceof AbortSignal, '要把可中止信号交给服务（超时要能掐断）')

  // 父级必须是活着的 agent 句柄（spawn 子级的前提），且第二次委派复用同一个，不重复建会话
  const parent = call.request.parent
  assert.ok(parent && typeof parent.id === 'string' && parent.id, 'parent 必须是 agent 句柄')
  const second = await s.hub.runSubagentTurn('phone', '第二趟', '再刷五分钟')
  assert.equal(second, '子智能体办好了')
  assert.equal(s.calls[1].request.parent.id, parent.id, '父级会话复用，不能每趟新建')
  assert.equal(s.calls[1].request.parent.preset, 'aurabot-social', '父级是社交档（带工具、不带 QQ 人格的挂载）')

  // 结果拿到后要主动释放子树
  await settle()
  assert.deepEqual(s.disposed, ['手机逛逛：刷了一会儿', '第二趟'])
})

test('结果形状兜底：字符串 / 消息块数组 / 包着 output 的对象，都取最后一段有效文本', async (t) => {
  const shapes = [
    ['纯字符串', '直接给的答案'],
    ['消息块数组', [{ type: 'text', text: '先想了下' }, { type: 'text', text: '最终答案' }]],
    ['对象 output', { output: '对象里的答案' }],
    ['对象 text', { text: 'text 字段的答案' }],
  ]
  for (const [name, result] of shapes) {
    const s = setup(t)
    s.fake.ctx.subagents = { async startActivation() { return { result: Promise.resolve(result), dispose: async () => {} } } }
    const got = await s.hub.runSubagentTurn('probe', '形状', '任务书')
    const want = {
      '纯字符串': '直接给的答案',
      '消息块数组': '最终答案',
      '对象 output': '对象里的答案',
      '对象 text': 'text 字段的答案',
    }[name]
    assert.equal(got, want, name)
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
  await assert.rejects(s.hub.runSubagentTurn('probe', '失败趟', '任务书'), /子智能体执行失败：模型超时/)
  await settle()
  assert.equal(disposed.length, 1, '失败路径也要 dispose')
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
