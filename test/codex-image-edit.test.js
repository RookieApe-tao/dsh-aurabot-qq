// Codex 订阅：图片编辑走 /images/edits，参考图以 data URL 放在 images 数组里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCodexImage } from '../src/features/codex-image.js'

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])
const noopLog = { info() {}, debug() {}, warn() {}, error() {} }
const auth = {
  revision: () => 1,
  assertCurrent() {},
  ensureAccess: async () => ({ access: 'token', accountId: 'acct' }),
}

function fakeFetch (calls) {
  return async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers })
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

test('Codex 图片编辑：走 /images/edits，并把参考图放进 images', async () => {
  const calls = []
  const generate = createCodexImage({ auth, fetchImpl: fakeFetch(calls), log: noopLog })
  const out = await generate({ codex: { model: 'gpt-image-2' } }, '把伞换成红色', { shape: 'square', image: png })
  assert.deepEqual(out, png)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/backend-api\/codex\/images\/edits$/)
  assert.equal(calls[0].body.images.length, 1)
  assert.match(calls[0].body.images[0].image_url, /^data:image\/png;base64,/)
  assert.equal(calls[0].body.prompt.includes('把伞换成红色'), true)
  assert.equal(calls[0].headers['chatgpt-account-id'], 'acct')
})

test('Codex 文生图：没有参考图仍走 /images/generations', async () => {
  const calls = []
  const generate = createCodexImage({ auth, fetchImpl: fakeFetch(calls), log: noopLog })
  await generate({ codex: { model: 'gpt-image-2' } }, '画一只猫', { shape: 'square' })
  assert.match(calls[0].url, /\/backend-api\/codex\/images\/generations$/)
  assert.equal('images' in calls[0].body, false)
})
