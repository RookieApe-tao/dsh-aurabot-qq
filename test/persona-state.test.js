// 人格隔离（续）：心情、目的引擎状态、autotelic 账本和日志也是她自己的，跟着人格走。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { createRuntime } from '../src/autotelic/runtime.js'
import { createJournal } from '../src/autotelic/reflect.js'

const OWNER = '10000001'
const BOT = '20000002'
let fake
let api
let dataDir
before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-persona-state-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    ext: { purpose: { enabled: true } },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: 'http://127.0.0.1:9', wsUrl: 'ws://127.0.0.1:9', dir: join(dataDir, 'no-snowluma') },
  }))
  fake = createFakeDsh({ brain: async () => '嗯' })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await fake.call('/persona/save', { id: 'shoko', name: '翔子', tags: [], body: '你是牧之原翔子。' })
})

after(() => {
  fake?.dispose()
  setTimeout(() => process.exit(0), 200).unref()
})

const use = async (id) => {
  const r = await fake.call('/persona/use', { id })
  assert.equal(r.json().ok, true, r.raw())
}
const shokoDir = (...parts) => join(dataDir, 'persona-data', 'shoko', ...parts)
const rules = () => fake.variables.get('aurabot_rules_private')()
const drives = (dir, need) => {
  mkdirSync(join(dir, 'purpose'), { recursive: true })
  writeFileSync(join(dir, 'purpose', 'purpose-state.json'), JSON.stringify({ drives: { [need]: 0.9 } }))
}

test('心情跟着人格走：大肥鱼开心的原因不带到翔子身上，切回来还在', async () => {
  assert.equal(api.getConfig().persona.dataOwner, 'dafeiyu')
  api.mood.nudge(20, '主人夸她可爱')
  assert.match(api.mood.state().reason, /主人夸她可爱/)
  assert.ok(existsSync(join(dataDir, 'mood.json')), '根目录人格的心情还在老位置')
  await use('shoko')
  assert.doesNotMatch(api.mood.state().reason || '', /主人夸她可爱/)
  api.mood.nudge(-10, '下雨了')
  assert.ok(existsSync(shokoDir('mood.json')))
  await use('dafeiyu')
  assert.match(api.mood.state().reason, /主人夸她可爱/)
})

test('目的引擎的状态跟着人格走：「心里想要什么」只注入到自己身上', async () => {
  await use('dafeiyu')
  drives(dataDir, 'connect')
  assert.match(rules(), /你最近心里比较想要：陪/)
  await use('shoko')
  assert.doesNotMatch(rules(), /你最近心里比较想要/, '翔子还没有自己的目的状态')
  drives(shokoDir(), 'share')
  assert.match(rules(), /你最近心里比较想要：分享/)
  await use('dafeiyu')
  assert.match(rules(), /你最近心里比较想要：陪/)
})

test('autotelic 账本按当时的文件取：换了人格就换一本，切回来接着记', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-ledger-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let file = join(dir, 'a', 'ledger.json')
  const rt = createRuntime({
    settings: () => ({ maxTasksActive: 3, maxSteps: 8, budgetActionsPerHour: 12 }),
    hub: {},
    ledgerFile: () => file,
  })
  rt.book().heartbeat('大肥鱼的一拍')
  file = join(dir, 'b', 'ledger.json')
  assert.equal(rt.book().meta().ticks.length, 0, '翔子的账本是空的')
  rt.book().heartbeat('翔子的一拍')
  file = join(dir, 'a', 'ledger.json')
  assert.deepEqual(rt.book().meta().ticks.map((x) => x.outcome), ['大肥鱼的一拍'])
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'b', 'ledger.json'), 'utf8')).ticks.map((x) => x.outcome), ['翔子的一拍'])
})

test('autotelic 日志按当时的目录写', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-journal-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let base = join(dir, 'a')
  const journal = createJournal(() => base)
  journal.write('daily', '2026-11-13', '大肥鱼的一天')
  base = join(dir, 'b')
  assert.equal(journal.exists('daily', '2026-11-13'), false)
  base = join(dir, 'a')
  assert.equal(journal.read('daily', '2026-11-13'), '大肥鱼的一天')
})
