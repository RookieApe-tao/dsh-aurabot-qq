// U1：外置工具页必须接上系统页签、组件、宿主路由和只读工具注册表。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')
const tools = readFileSync(new URL('../src/core/tools.js', import.meta.url), 'utf8')

test('外置工具页接上了 TABS、Pages 和系统分组', () => {
  assert.ok(client.includes("{ id: 'tools', label: '外置工具' }"), 'TABS 缺外置工具页')
  assert.ok(client.includes('tools: Tools'), '组件表缺 tools → Tools')
  assert.ok(client.includes("tabs: ['platforms', 'tools', 'connect'"), '系统分组缺 tools')
  assert.ok(client.includes('function Tools({ toast })'), '缺 Tools 组件')
})

test('外置工具页：检测、手动路径和测试路由都已接上，下载仍留给下一阶段', () => {
  assert.ok(host.includes("route('/tools'"), '缺 /tools 路由')
  assert.ok(host.includes("route('/tools/refresh'"), '缺 /tools/refresh 路由')
  assert.ok(host.includes("route('/tools/test'"), '缺 /tools/test 路由')
  assert.ok(host.includes("route('/tools/path'"), '缺 /tools/path 路由')
  assert.ok(host.includes("route('/tools/reset'"), '缺 /tools/reset 路由')
  assert.ok(tools.includes('export async function listTools'), '缺工具注册表')
  assert.ok(tools.includes('export async function probeTool'), '缺路径测试')
  assert.ok(tools.includes('normalizeToolPath'), '缺路径归一化')
  assert.ok(tools.includes("describe(\n    'ffmpeg'") || tools.includes("'ffmpeg', 'FFmpeg'"), '缺 ffmpeg 定义')
  assert.ok(tools.includes("'ffprobe'"), '缺 ffprobe 定义')
  assert.ok(tools.includes("id: 'python'"), '缺 python 定义')
  assert.ok(tools.includes("'uv'"), '缺 uv 定义')
  assert.ok(tools.includes("'git'"), '缺 git 定义')
  assert.ok(!tools.includes('download'), '下载逻辑应留到下一阶段')
})
