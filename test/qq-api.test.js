import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickParams, refusal } from '../src/modules/qq-api/index.js'
import { QQ_API, paramsOf } from '../src/modules/qq-api/actions.js'

const cfg = { enabled: true, dryRun: false }
const group = { kind: 'group', groupId: '9', chatId: 'group:9' }
const check = (action, params, o = {}) => refusal({ action, params, cfg, owner: false, chat: group, ...o })

test('危险接口不在表里', () => {
  for (const a of ['get_cookies', 'get_credentials', 'get_clientkey', 'get_csrf_token', 'get_rkey', 'send_packet', 'send_msg', 'download_file', 'upload_file_stream', 'delete_friend', 'set_group_leave', 'create_flash_task', 'set_group_portrait']) {
    assert.equal(QQ_API[a], undefined, a)
    assert.equal(check(a, {}, { owner: true }), '这个接口不开放', a)
  }
})

test('群里别人只能查当前群', () => {
  assert.equal(check('get_essence_msg_list', { group_id: 9 }), '')
  assert.match(check('get_essence_msg_list', { group_id: 10 }), /当前这个群/)
  assert.match(check('get_essence_msg_list', { group_id: 9 }, { chat: { kind: 'private', userId: '2' } }), /当前这个群/)
})

test('写操作只有主人开口才行', () => {
  assert.match(check('delete_msg', { message_id: 1 }), /主人/)
  assert.equal(check('delete_msg', { message_id: 1 }, { owner: true }), '')
  assert.match(check('set_group_whole_ban', { group_id: 9 }), /主人/)
})

test('试运行不执行写操作，查询照常', () => {
  const dry = { enabled: true, dryRun: true }
  assert.match(check('delete_msg', { message_id: 1 }, { owner: true, cfg: dry }), /试运行/)
  assert.equal(check('get_essence_msg_list', { group_id: 9 }, { owner: true, cfg: dry }), '')
})

test('必填参数和多余参数', () => {
  assert.match(check('delete_msg', {}, { owner: true }), /缺参数 message_id/)
  assert.deepEqual(pickParams('delete_msg', { message_id: 1, evil: 2 }), { message_id: 1 })
})

test('接口表每项完整', () => {
  for (const [name, e] of Object.entries(QQ_API)) {
    assert.ok(['open', 'owner'].includes(e[0]), name)
    assert.ok(e[2], name)
    assert.ok(paramsOf(name).every((p) => p.name), name)
    if (e[0] === 'open' && name !== 'translate_en2zh') assert.ok(paramsOf(name).some((p) => p.name === 'group_id' && p.required), name)
  }
})

test('工具接到网关：查询走 onebot，别人写操作被拒', async () => {
  const { default: mod } = await import('../src/modules/qq-api/index.js')
  const calls = []
  let build
  mod.setup({
    core: { hub: { turnSendersAllOwner: () => false }, onebot: { call: async (a, p) => { calls.push([a, p]); return { ok: 1 } } } },
    config: () => ({ enabled: true, dryRun: false, qqApi: { enabled: true } }),
    tool: (fn) => { build = fn }, rule: () => {}, log: { info() {} },
  })
  const [find, call] = build({ chat: group, level: 'social', sessionId: 's' })
  assert.match((await find.execute({ keyword: '精华' })).message, /get_essence_msg_list/)
  assert.doesNotMatch((await find.execute({ keyword: '撤回' })).message, /delete_msg/, '查不到自己用不了的接口')
  assert.equal((await call.execute({ action: 'get_essence_msg_list', param: '{"group_id":9,"x":1}' })).ok, true)
  assert.deepEqual(calls, [['get_essence_msg_list', { group_id: 9 }]])
  assert.equal((await call.execute({ action: 'delete_msg', param: '{"message_id":1}' })).ok, false)
  assert.equal((await call.execute({ action: 'get_essence_msg_list', param: 'x' })).ok, false)
  assert.equal(calls.length, 1)
  assert.deepEqual(build({ chat: { kind: 'system' }, level: 'social' }), [])
})
