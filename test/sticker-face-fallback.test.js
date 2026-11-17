// #420: 网关把 add_custom_face 的 file 当本地路径时，base64 失败要退回刚写下的本地文件，而不是只刷 warn。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const old = process.env.AURABOT_DATA_DIR
process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-sticker-face-'))
const { normalize } = await import('../src/core/config.js')
const { createStickerStore } = await import('../src/features/stickers.js')

test('add_custom_face 不认 base64 时退回本地路径', async (t) => {
  t.after(() => { if (old === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = old })
  const calls = []
  const cfg = normalize({ enabled: true, dryRun: false, stickers: { enabled: true } })
  const store = createStickerStore({
    dsh: null,
    getConfig: () => cfg,
    onebot: {
      async call(action, params) {
        calls.push([action, params.file.slice(0, 20)])
        if (action === 'add_custom_face' && params.file.startsWith('base64://')) throw Object.assign(new Error('ENAMETOOLONG: name too long, stat base64://x'), { code: 'ENAMETOOLONG' })
        if (action === 'add_custom_face') return { emoji_id: 'e1' }
        return {}
      },
    },
    log: { info() {}, warn() {}, debug() {} },
  })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const r = await store.addFromBuffer(png, { name: '测试', toQQ: true })
  assert.equal(r.ok, true)
  assert.equal(r.item.emojiId, 'e1')
  assert.equal(calls.filter(([a]) => a === 'add_custom_face').length, 2)
})
