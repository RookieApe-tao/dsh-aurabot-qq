// 长会话越聊越慢：压缩门槛调低、召回提示有总长度上限。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTestIdentity } from './helpers/identity.js'

test('每个预设的会话压缩都在窗口 25% 时触发、保留 5%（默认 80% 会让百万窗口的会话长到几十万 token）', () => {
  const yml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const blocks = yml.split("name: '@deepseek-ai/dsh-compaction-basic'").slice(1)
  assert.ok(blocks.length >= 6)
  for (const b of blocks) {
    const head = b.split('- id:')[0]
    assert.match(head, /thresholdRatio: 0\.25/)
    assert.match(head, /retainRatio: 0\.05/)
  }
})

test('召回提示有总长度上限：聊天原文再多也不超过 recallHintMaxChars', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hint-cap-'))
  process.env.AURABOT_DATA_DIR = dir
  const { normalize } = await import('../src/core/config.js')
  const { createMemoryStore } = await import('../src/features/memory.js')
  const cfg = normalize({ ownerQQ: '10001', memory: { enabled: true, recallHintMaxChars: 400 } })
  assert.equal(normalize({ memory: { recallHintMaxChars: 99 } }).memory.recallHintMaxChars, 300)
  const day = new Date().toISOString().slice(0, 10)
  const lines = Array.from({ length: 300 }, (_, i) => ({ t: Date.now() - i * 1000, chatId: 'private:10001', who: 'n', uid: '10001', text: `奶茶和熬夜的事情聊了很久很久，第 ${i} 句，后面还有很多很多字` }))
  const hub = { chatLogDays: () => [day], chatLogOf: () => lines, speakersOf: () => [] }
  // 融合：主人私聊判定走身份库（identity 注入后 isOwnerChat 才能认出 private:10001 是主人）
  const identity = makeTestIdentity('10001', 'qq')
  const mem = createMemoryStore({ dsh: null, getConfig: () => cfg, hub, log: { info() {}, warn() {}, debug() {} }, identity })
  for (let i = 0; i < 20; i++) mem.add({ text: `主人喜欢奶茶，熬夜第 ${i} 次说要早睡但没做到，这条记忆写得比较长一些`, about: '10001', aboutName: '主人', importance: 0.7 })
  const hint = await mem.recallHintAsync({ chatId: 'private:10001', kind: 'private', userId: '10001' }, '上次说的奶茶和熬夜还记得吗', '', '', [], [])
  assert.ok(hint.length > 0)
  assert.ok(hint.length <= 400, `召回提示 ${hint.length} 字，超过上限`)
})
