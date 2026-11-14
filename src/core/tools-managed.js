// 外置工具托管安装（阶段 3）：只处理两件明确的事——
//   1) 下载 FFmpeg（固定来源 + SHA256，Windows zip）
//   2) 修复 Python / edge-tts / uv
// 安装状态留在内存里，前端轮询 /tools 就能看到“下载中/解压中/失败原因”。
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, copyFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { dataDir } from './store.js'

const WIN = process.platform === 'win32'
const jobs = new Map()

// uv 的来源与 song/studio.js 保持一致；这里不 import 那个大模块，避免安装器反向拉起翻唱。
const UV_WHEEL = 'packages/32/ea/771744a784b16aa21d195cb5d5d5a2878d72fa00fc26f11ea3f9646994fe/uv-0.13.5-py3-none-win_amd64.whl'
const UV_SHA = '1fb29fc46ba12033e2ef95a95ac79d649e71bbb1358419bbbcbd19d86026ef2f'
const UV_SOURCES = [
  { url: `https://mirrors.aliyun.com/pypi/${UV_WHEEL}`, sha256: UV_SHA },
  { url: `https://files.pythonhosted.org/${UV_WHEEL}`, sha256: UV_SHA },
  { url: 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' },
]

const FFMPEG_ZIP = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
const FFMPEG_SHA = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256'

export function toolJob(id) {
  return jobs.get(id) || null
}

export function toolJobs() {
  return Object.fromEntries([...jobs.entries()].map(([id, job]) => [id, { ...job }]))
}

function setJob(id, patch) {
  jobs.set(id, { id, at: Date.now(), ...(jobs.get(id) || {}), ...patch })
}

async function download(url, dest, { sha256 = '', onProgress = () => {} } = {}) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') || 0)
  const hash = createHash('sha256')
  let done = 0
  await new Promise((resolve, reject) => {
    const out = createWriteStream(dest)
    out.on('error', reject)
    out.on('finish', resolve)
    ;(async () => {
      try {
        for await (const chunk of res.body) {
          done += chunk.length
          hash.update(chunk)
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
          onProgress({ done, total })
        }
        out.end()
      } catch (error) {
        out.destroy()
        reject(error)
      }
    })()
  })
  const actual = hash.digest('hex')
  if (sha256 && actual.toLowerCase() !== String(sha256).toLowerCase()) {
    throw new Error(`SHA256 校验失败（期望 ${sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`)
  }
  return actual
}

async function shaFromSidecar(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`校验文件下载失败 HTTP ${res.status}`)
  const text = await res.text()
  return String(text).trim().split(/\s+/)[0] || ''
}

function expandZip(zip, dir) {
  mkdirSync(dir, { recursive: true })
  if (!WIN) return Promise.reject(new Error('当前仅支持 Windows 自动解压'))
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:AB_ZIP -DestinationPath $env:AB_DIR -Force'], {
      windowsHide: true,
      env: { ...process.env, AB_ZIP: zip, AB_DIR: dir },
    })
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`解压失败：${err.slice(-300) || code}`)))
  })
}

function findFile(dir, name) {
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch (error) { continue }
    for (const entry of entries) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name.toLowerCase() === name.toLowerCase()) return full
    }
  }
  return ''
}

async function installFfmpeg() {
  if (!WIN) throw new Error('FFmpeg 自动安装目前只支持 Windows；其他系统请用“手动路径”')
  setJob('ffmpeg', { state: 'downloading', message: '正在读取校验值…', progress: 0 })
  const sha256 = await shaFromSidecar(FFMPEG_SHA)
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('FFmpeg 校验文件格式不对')
  const root = dataDir('tools', 'ffmpeg')
  mkdirSync(root, { recursive: true })
  const zip = join(root, `ffmpeg-${Date.now()}.zip`)
  const tmp = join(root, `extract-${Date.now()}`)
  setJob('ffmpeg', { state: 'downloading', message: '正在下载 FFmpeg…', progress: 0 })
  await download(FFMPEG_ZIP, zip, {
    sha256,
    onProgress: ({ done, total }) => setJob('ffmpeg', { progress: total ? Math.round(done / total * 100) : 0, message: `正在下载 FFmpeg… ${Math.round(done / 1048576)}MB` }),
  })
  setJob('ffmpeg', { state: 'extracting', message: '正在解压…', progress: 100 })
  await expandZip(zip, tmp)
  const ffmpeg = findFile(tmp, 'ffmpeg.exe')
  const ffprobe = findFile(tmp, 'ffprobe.exe')
  if (!ffmpeg) throw new Error('压缩包里没找到 ffmpeg.exe')
  const dest = join(root, 'current')
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const destFfmpeg = join(dest, 'ffmpeg.exe')
  copyFileSync(ffmpeg, destFfmpeg)
  let destFfprobe = ''
  if (ffprobe) { destFfprobe = join(dest, 'ffprobe.exe'); copyFileSync(ffprobe, destFfprobe) }
  rmSync(zip, { force: true })
  rmSync(tmp, { recursive: true, force: true })
  setJob('ffmpeg', { state: 'done', message: 'FFmpeg 安装完成', progress: 100 })
  return { ffmpeg: destFfmpeg, ffprobe: destFfprobe }
}

async function installUv() {
  if (!WIN) throw new Error('uv 自动安装目前只支持 Windows；其他系统请用“手动路径”')
  const root = dataDir('tools', 'uv')
  mkdirSync(root, { recursive: true })
  let lastError = null
  for (const source of UV_SOURCES) {
    const zip = join(root, `uv-${Date.now()}.zip`)
    const tmp = join(root, `extract-${Date.now()}`)
    try {
      setJob('uv', { state: 'downloading', message: '正在下载 uv…', progress: 0 })
      await download(source.url, zip, {
        sha256: source.sha256 || '',
        onProgress: ({ done, total }) => setJob('uv', { progress: total ? Math.round(done / total * 100) : 0, message: `正在下载 uv… ${Math.round(done / 1048576)}MB` }),
      })
      setJob('uv', { state: 'extracting', message: '正在解压 uv…', progress: 100 })
      await expandZip(zip, tmp)
      const exe = findFile(tmp, 'uv.exe')
      if (!exe) throw new Error('压缩包里没找到 uv.exe')
      const dir = join(homedir(), 'Aurabot', 'bin')
      mkdirSync(dir, { recursive: true })
      const dest = join(dir, 'uv.exe')
      copyFileSync(exe, dest)
      rmSync(zip, { force: true })
      rmSync(tmp, { recursive: true, force: true })
      setJob('uv', { state: 'done', message: 'uv 安装完成', progress: 100 })
      return { uv: dest }
    } catch (error) {
      lastError = error
      rmSync(zip, { force: true })
      rmSync(tmp, { recursive: true, force: true })
      setJob('uv', { state: 'downloading', message: `换一个源重试：${error.message.slice(0, 60)}`, progress: 0 })
    }
  }
  throw new Error(`uv 下载失败：${lastError?.message || '没有可用下载源'}`)
}

async function installPython(log) {
  if (!WIN) throw new Error('Python 一键修复目前只支持 Windows')
  setJob('python', { state: 'installing', message: '正在准备 Python / edge-tts…', progress: 0 })
  const { installEdge, PYENV_DIR } = await import('../voice/tts.js')
  const result = await installEdge(log)
  if (!result?.ok) throw new Error(result?.message || 'Python / edge-tts 安装失败')
  const py = WIN ? join(PYENV_DIR, 'Scripts', 'python.exe') : join(PYENV_DIR, 'bin', 'python')
  setJob('python', { state: 'done', message: 'Python / edge-tts 已就绪', progress: 100 })
  return { python: existsSync(py) ? py : '' }
}

/** 后台执行安装；host 负责把返回的路径写进 config。 */
export async function runToolInstall(id, { log } = {}) {
  if (jobs.get(id)?.state === 'downloading' || jobs.get(id)?.state === 'extracting' || jobs.get(id)?.state === 'installing') {
    return { ok: false, message: '这个工具正在安装' }
  }
  setJob(id, { state: 'starting', message: '准备中…', progress: 0 })
  try {
    let paths = {}
    if (id === 'ffmpeg') paths = await installFfmpeg()
    else if (id === 'uv') paths = await installUv()
    else if (id === 'python') paths = await installPython(log)
    else throw new Error('这个工具不支持自动安装')
    return { ok: true, ...paths }
  } catch (error) {
    setJob(id, { state: 'error', message: error.message || '安装失败', progress: 0 })
    log?.warn?.(`外置工具 ${id} 安装失败：${error.message}`)
    return { ok: false, message: error.message || '安装失败' }
  }
}
