// Quick Tunnel URL 提取：cloudflared 的提示在 stderr 里，格式可能带边框。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseQuickTunnelUrl } from '../src/core/quick-tunnel.js'

test('Quick Tunnel：从带边框日志里提取 trycloudflare 地址', () => {
  const text = 'INF |  https://midi-contributions-margin-ever.trycloudflare.com                                  |\n'
  assert.equal(parseQuickTunnelUrl(text), 'https://midi-contributions-margin-ever.trycloudflare.com')
  assert.equal(parseQuickTunnelUrl('no url here'), '')
})
