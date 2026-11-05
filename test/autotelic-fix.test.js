// 自驱引擎三病修复的回归测试（2026-11-05，真机账本实证后修的）：
//   病一「只会写判断笔记」 → 任务书多步化（engine.buildTodos）
//   病二「重复立项饿死引擎」→ 同源冷却 + sourceId 精确去重（engine.proposeTasks）
//   病三「冷却中冤死成 blocked」→ 瞬态退避（book.releaseStep + runtime 瞬态口径）
//   附带：人格提案工具的落盘口径（proposals/persona-*.md，提案权不直写人格卡）
// 真机证据：ledger.json 16 个任务全是单步模板；同 sourceId 立项 3 次；4 个 blocked 里 3 个瞬态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proposeTasks, buildTodos } from '../src/autotelic/engine.js'
import { createBook } from '../src/autotelic/book.js'
import { createRuntime } from '../src/autotelic/runtime.js'

// —— 造素材：collectMaterials 的 items 带 needAffinity（keyword 命中才有分），测试里直接给 ——

function mat(id, text, { need = 'identity', affinity = 0.9, kind = 'self', who = '' } = {}) {
  return { id, text, kind, who, source: kind, importance: 0, needAffinity: { [need]: affinity } }
}

const BASE = { minCuriosity: 0.5 }

// —— 病二：同源冷却 + sourceId 精确去重 ——

test('同源冷却：做完的 sourceId 7 天内不再立项（修重复立项饿死引擎）', () => {
  const m = mat('qq:1:2:3:self', '拆解大肥鱼AI自主刷B站原理', { need: 'identity' })
  const r = proposeTasks({ materials: [m], coolSourceIds: ['qq:1:2:3:self'], ...BASE })
  assert.equal(r.candidates.length, 0, '冷却中的同源素材不许再立项')
  assert.ok(r.rejected.some((x) => /冷却/.test(x.why)), `落选原因要写冷却：${JSON.stringify(r.rejected)}`)
})

test('冷却外的同源素材照常立项', () => {
  const m = mat('m-new', '学一下算命的流派划分', { need: 'learn' })
  const r = proposeTasks({ materials: [m], coolSourceIds: ['m-old'], ...BASE })
  assert.equal(r.candidates.length, 1)
})

test('进行中的同源素材也不重复立项（sourceId 精确挡，标题截断绕不过）', () => {
  const m = mat('m1', '拆解刷B站原理', { need: 'identity' })
  const r = proposeTasks({
    materials: [m],
    activeTasks: [{ title: '完全不同的另一个标题', sourceId: 'm1' }],
    ...BASE,
  })
  assert.equal(r.candidates.length, 0)
  assert.ok(r.rejected.some((x) => /进行中/.test(x.why)))
})

// —— 病一：任务书多步化 ——

test('任务书多步化：学/创/自我类至少 3 步，收尾是把结论写进记忆', () => {
  for (const need of ['learn', 'create', 'identity', 'install']) {
    const steps = buildTodos('随便什么方向', need)
    assert.ok(steps.length >= 3, `${need} 类至少 3 步，实得 ${steps.length}`)
    assert.equal(steps[0].level, 'L0', '第一步仍是只读判断')
    assert.equal(steps.at(-1).level, 'L1-b', '收尾步是写记忆（L1-b）')
    assert.match(steps.at(-1).desc, /autotelic_note/, '收尾步点名记忆工具')
  }
})

test('任务书多步化：玩/陪类两步收场，不硬塞记忆步', () => {
  for (const need of ['play', 'connect', 'care']) {
    const steps = buildTodos('随便什么方向', need)
    assert.equal(steps.length, 2, `${need} 类两步就够`)
  }
})

// —— 病三：瞬态退避 ——

function tmpLedger(t, tasks) {
  const dir = mkdtempSync(join(tmpdir(), 'autotelic-fix-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'ledger.json')
  const at = Date.now()
  writeFileSync(file, JSON.stringify({
    tasks: tasks.map((x) => ({ score: 0.6, sourceId: 's', reason: 'r', why: '', fingerprints: [], ...x, createdAt: x.createdAt || at, updatedAt: x.updatedAt || at })),
    actions: [], ticks: [], lastTick: null,
  }), 'utf8')
  return file
}

const BASE_SETTINGS = {
  enabled: true, allowAct: true, presetIdOverride: false,
  maxTasksActive: 8, maxSteps: 8, budgetActionsPerHour: 12, minCuriosity: 0.55,
}

const mkTask = (id, title = 'T') => ({
  id, title, reason: 'r', sourceId: 's1', status: 'active',
  steps: [{ desc: 'd', level: 'L0', status: 'pending', attempts: 0, fingerprint: '', why: '' }],
})

test('瞬态退避：后台冷却不算步失败，退回 pending 不计次数（修 blocked 冤死）', async (t) => {
  const file = tmpLedger(t, [mkTask('t1')])
  const rt = createRuntime({
    settings: () => ({ ...BASE_SETTINGS }),
    hub: {},
    ledgerFile: file,
    act: { runStep: async () => ({ ok: false, observation: '回合失败：后台会话冷却中，1 分钟后再试', hadTools: false }) },
  })
  const r = await rt.step()
  assert.equal(r.outcome, 'act-backoff', `瞬态要走 backoff，实得 ${r.outcome}`)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  const t1 = saved.tasks.find((x) => x.id === 't1')
  assert.equal(t1.status, 'active', '任务不许被憋成 blocked')
  assert.equal(t1.steps[0].status, 'pending', '步退回待办')
  assert.equal(t1.steps[0].attempts, 0, '失败计数退回，不占熔断额度')
})

test('真失败照样计数：非瞬态且观察不同的失败 2 次仍会 blocked（别把退避做成免死金牌）', async (t) => {
  const file = tmpLedger(t, [mkTask('t2')])
  let n = 0
  const rt = createRuntime({
    settings: () => ({ ...BASE_SETTINGS }),
    hub: {},
    ledgerFile: file,
    // 观察每次不同——同观察两次会走熔断（abandoned），那是另一条设计好的路
    act: { runStep: async () => { n += 1; return { ok: false, observation: `第 ${n} 次查证：这条素材的原文还是没找到（查证角度 ${n}）`, hadTools: false } } },
  })
  await rt.step()
  await rt.step()
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.tasks.find((x) => x.id === 't2').status, 'blocked', '真失败两次还是要 blocked')
})

// —— 附带：buildTodos 的产物能被 addTask 原样落账（多步不被吞） ——

test('多步任务书经 addTask 落账后步数不变', () => {
  const bk = createBook({}) // 不落盘
  const todos = buildTodos('学算命的流派', 'learn')
  const r = bk.addTask({ title: '学算命的流派', reason: '好奇', todos, sourceId: 's9' })
  assert.equal(r.ok, true)
  assert.equal(r.task.steps.length, todos.length, '多步不许被账本吞成一步')
})
