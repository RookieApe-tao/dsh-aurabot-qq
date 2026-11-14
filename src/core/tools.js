// 外置工具探测：把 FFmpeg / Python / uv / Git / edge-tts 的位置和版本
// 汇总给「系统 → 外置工具」页。只读探测时不执行用户内容；手动路径会先测试再保存。
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { findFfmpeg } from './img.js'

const WIN = process.platform === 'win32'
const exe = (name) => (WIN ? `${name}.exe` : name)

function onPath(name) {
  const dirs = String(process.env.PATH || '').split(WIN ? ';' : ':').filter(Boolean)
  for (const dir of dirs) {
    const p = join(dir, exe(name))
    if (existsSync(p)) return p
  }
  return ''
}

/** 用户手动路径：去引号；如果给的是目录，自动补可执行文件名。 */
export function normalizeToolPath(raw, name) {
  let value = String(raw || '').trim().replace(/^"(.*)"$/, '$1').trim()
  if (!value) return ''
  // 只写命令名（ffmpeg / git）时也接受，等价于从 PATH 找。
  if (!/[\\/]/.test(value)) {
    const hit = onPath(value.replace(/\.exe$/i, ''))
    if (hit) value = hit
  }
  try {
    if (existsSync(value) && statSync(value).isDirectory()) value = join(value, exe(name))
  } catch (error) {}
  return value
}

function probe(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!cmd || !existsSync(cmd)) return resolve({ ok: false, output: '' })
    let out = ''
    let err = ''
    let done = false
    let child
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child?.kill() } catch (error) {}
      finish({ ok: false, output: '超时' })
    }, timeoutMs)
    try {
      child = spawn(cmd, args, { windowsHide: true })
      child.stdout.on('data', (d) => { out += d; if (out.length > 4000) out = out.slice(-4000) })
      child.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000) })
      child.on('error', (error) => finish({ ok: false, output: error.message }))
      child.on('close', (code) => finish({ ok: code === 0, output: (out + '\n' + err).trim() }))
    } catch (error) {
      finish({ ok: false, output: error.message })
    }
  })
}

const firstLine = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || ''
const versionMatch = (s) => {
  const text = String(s || '')
  const semver = text.match(/\b(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/)?.[1]
  if (semver) return semver
  // FFmpeg 的构建号是 N-107464-g...，不是标准 semver；至少把可读版本串带出来。
  return text.match(/\bversion\s+([^\s]+)/i)?.[1] || ''
}

const PROBE_ARGS = {
  ffmpeg: ['-version'],
  ffprobe: ['-version'],
  python: ['--version'],
  uv: ['--version'],
  git: ['--version'],
  cloudflared: ['--version'],
}

function pythonCandidates() {
  const dirs = [process.env.AURABOT_PYENV, join(homedir(), 'Aurabot', 'pyenv'), 'C:\\Aurabot\\pyenv'].filter(Boolean)
  const out = []
  for (const dir of dirs) out.push(WIN ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python'))
  for (const name of ['python', 'python3']) { const p = onPath(name); if (p) out.push(p) }
  return [...new Set(out)].filter(Boolean)
}

function edgeInstalled(pythonPath) {
  if (!pythonPath) return false
  const root = dirname(dirname(pythonPath))
  const candidates = WIN
    ? [join(root, 'Lib', 'site-packages', 'edge_tts')]
    : [join(root, 'lib', 'python3.12', 'site-packages', 'edge_tts'), join(root, 'lib', 'python3.11', 'site-packages', 'edge_tts')]
  return candidates.some((p) => existsSync(p))
}

function configuredPath(cfg, id) {
  return normalizeToolPath(cfg?.tools?.[id]?.path || '', id)
}

function autoExecutable(id) {
  if (id === 'ffmpeg') return findFfmpeg('')
  if (id === 'ffprobe') return onPath('ffprobe')
  if (id === 'git') return onPath('git')
  if (id === 'uv') {
    return [process.env.AURABOT_UV, join(homedir(), 'Aurabot', 'bin', exe('uv')), join('C:\\Aurabot', 'bin', exe('uv')), onPath('uv')].filter(Boolean).find((p) => existsSync(p)) || ''
  }
  if (id === 'python') return pythonCandidates().find((p) => existsSync(p)) || ''
  if (id === 'cloudflared') {
    return [join(homedir(), 'Aurabot', 'bin', exe('cloudflared')), onPath('cloudflared')].filter(Boolean).find((p) => existsSync(p)) || ''
  }
  return ''
}

async function describe(id, label, kind, path, source, usedBy, explicit = false) {
  const args = PROBE_ARGS[id] || ['--version']
  const result = path ? await probe(path, args) : { ok: false, output: '' }
  const invalidConfigured = explicit && path && !existsSync(path)
  return {
    id,
    label,
    kind,
    status: result.ok ? 'ready' : (path || invalidConfigured) ? 'invalid' : 'missing',
    path,
    version: versionMatch(firstLine(result.output)),
    detail: invalidConfigured ? '路径不存在或不可执行' : firstLine(result.output),
    source: source || '',
    usedBy,
  }
}

/** 测试一个手动路径，不写配置。 */
export async function probeTool(id, rawPath) {
  const name = id === 'ffmpeg' ? 'ffmpeg' : id === 'ffprobe' ? 'ffprobe' : id
  const path = normalizeToolPath(rawPath, name)
  if (!path) return { ok: false, status: 'missing', path: '', message: '路径为空' }
  if (!existsSync(path)) return { ok: false, status: 'invalid', path, message: '路径不存在' }
  const args = PROBE_ARGS[id] || ['--version']
  const result = await probe(path, args)
  return {
    ok: result.ok,
    status: result.ok ? 'ready' : 'invalid',
    path,
    version: versionMatch(firstLine(result.output)),
    message: result.ok ? '测试通过' : (firstLine(result.output) || '无法执行'),
  }
}

let listCache = null

/** 安装/改路径后让下一次 /tools 立即重新探测。 */
export function clearToolsCache() {
  listCache = null
}

/**
 * @param {() => object} getConfig
 * @param {{fresh?: boolean}} [opts]
 * @returns {Promise<{ok:true, tools:Array}>}
 */
export async function listTools(getConfig, { fresh = false } = {}) {
  if (!fresh && listCache && Date.now() - listCache.at < 20_000) return listCache.value
  const cfg = getConfig?.() || {}
  const tools = []

  // FFmpeg：新 tools 配置 > 旧 bili.ffmpegPath > 自动查找
  const ffmpegManual = configuredPath(cfg, 'ffmpeg')
  const ffmpegLegacy = normalizeToolPath(cfg.bili?.ffmpegPath || '', 'ffmpeg')
  const ffmpeg = ffmpegManual || ffmpegLegacy || autoExecutable('ffmpeg')
  tools.push(await describe(
    'ffmpeg', 'FFmpeg', 'media', ffmpeg,
    ffmpegManual ? 'config' : ffmpegLegacy ? 'legacy' : 'auto',
    ['B 站看画面', '聊天图片缩小', '生图', '头像', '翻唱'],
    Boolean(ffmpegManual || ffmpegLegacy),
  ))

  // FFprobe：配置 > FFmpeg 同目录 > PATH
  const ffprobeManual = configuredPath(cfg, 'ffprobe')
  const ffprobe = ffprobeManual
    || (ffmpeg ? join(dirname(ffmpeg), exe('ffprobe')) : autoExecutable('ffprobe'))
  tools.push(await describe(
    'ffprobe', 'FFprobe', 'media', ffprobe,
    ffprobeManual ? 'config' : 'auto',
    ['B 站视频信息', '翻唱时长检测'],
    Boolean(ffprobeManual),
  ))

  // Python
  const pythonManual = configuredPath(cfg, 'python')
  let python = pythonManual || autoExecutable('python')
  let pythonProbe = python ? await probe(python, ['--version']) : { ok: false, output: '' }
  if (!pythonManual && !pythonProbe.ok) {
    for (const candidate of pythonCandidates()) {
      const p = await probe(candidate, ['--version'])
      if (p.ok) { python = candidate; pythonProbe = p; break }
    }
  }
  tools.push({
    id: 'python',
    label: 'Python',
    kind: 'runtime',
    status: python && pythonProbe.ok ? 'ready' : python ? 'invalid' : 'missing',
    path: python,
    version: versionMatch(firstLine(pythonProbe.output)),
    detail: firstLine(pythonProbe.output) || (pythonManual && !existsSync(python) ? '路径不存在或不可执行' : ''),
    source: pythonManual ? 'config' : python && python.includes('pyenv') ? 'managed' : python ? 'auto' : '',
    usedBy: ['翻唱 / RVC', '语音合成 edge-tts'],
  })

  // uv
  const uvManual = configuredPath(cfg, 'uv')
  const uv = uvManual || autoExecutable('uv')
  tools.push(await describe(
    'uv', 'uv', 'runtime', uv,
    uvManual ? 'config' : 'auto',
    ['创建 Python 环境', '安装翻唱依赖'],
    Boolean(uvManual),
  ))

  // Git
  const gitManual = configuredPath(cfg, 'git')
  const git = gitManual || autoExecutable('git')
  tools.push(await describe(
    'git', 'Git', 'tool', git,
    gitManual ? 'config' : 'auto',
    ['备份推送'],
    Boolean(gitManual),
  ))

  // Cloudflare Quick Tunnel：QQ 官方机器人 Webhook 回调
  const cloudflaredManual = configuredPath(cfg, 'cloudflared')
  const cloudflared = cloudflaredManual || autoExecutable('cloudflared')
  tools.push(await describe(
    'cloudflared', 'Cloudflare Tunnel', 'network', cloudflared,
    cloudflaredManual ? 'config' : 'auto',
    ['QQ 官方机器人 Webhook 回调'],
    Boolean(cloudflaredManual),
  ))

  const edgeReady = edgeInstalled(python)
  tools.push({
    id: 'edge-tts',
    label: 'edge-tts',
    kind: 'runtime',
    status: edgeReady ? 'ready' : 'missing',
    path: edgeReady ? dirname(python) : '',
    version: '',
    detail: edgeReady ? '已安装到 Python 环境' : '未安装到 Python 环境',
    source: edgeReady ? 'managed' : '',
    usedBy: ['语音合成'],
  })

  const value = { ok: true, tools }
  listCache = { at: Date.now(), value }
  return value
}
