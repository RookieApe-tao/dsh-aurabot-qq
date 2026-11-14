// Cloudflare Quick Tunnel（临时公网 HTTPS）：给 QQ 官方机器人 Webhook 回调用。
// 只由「系统 → 外置工具」页显式启停，不做后台自动重连；关闭后 URL 会失效。
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './store.js'

let child = null
let state = { status: 'stopped', url: '', callback: '', error: '', startedAt: 0 }

export function tunnelState() {
  return { ...state }
}

function setState(patch) {
  state = { ...state, ...patch }
}

/** 从 cloudflared 输出里提取 trycloudflare URL。 */
export function parseQuickTunnelUrl(text) {
  const m = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
  return m ? m[0].replace(/\/+$/, '') : ''
}

export async function startQuickTunnel({ port, exe, timeoutMs = 25000 } = {}) {
  if (state.status === 'running' && state.url) return { ok: true, ...tunnelState() }
  if (!exe) return { ok: false, message: '没找到 cloudflared，请先安装或在工具页手动指定路径' }
  if (!Number.isInteger(port) || port <= 0) return { ok: false, message: '拿不到 DSH 本地端口' }
  if (state.status === 'starting') return { ok: false, message: 'Quick Tunnel 正在启动' }

  const dir = dataDir('quick-tunnel')
  mkdirSync(dir, { recursive: true })
  const logFile = join(dir, 'cloudflared.log')
  appendFileSync(logFile, `\n[${new Date().toISOString()}] start ${exe} port=${port}\n`)
  setState({ status: 'starting', url: '', callback: '', error: '', startedAt: Date.now() })
  let proc
  try {
    proc = spawn(exe, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    setState({ status: 'error', error: error.message })
    return { ok: false, message: error.message }
  }
  child = proc
  let output = ''
  let settled = false
  const finish = (result) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (!result.ok) {
      try { proc.kill() } catch (error) {}
      child = null
      setState({ status: 'error', error: result.message || '启动失败' })
    }
  }
  const timer = setTimeout(() => finish({ ok: false, message: 'cloudflared 25 秒内没有返回公网地址' }), timeoutMs)
  const onData = (chunk) => {
    const text = String(chunk || '')
    output += text
    if (output.length > 12000) output = output.slice(-12000)
    appendFileSync(logFile, text)
    const url = parseQuickTunnelUrl(text)
    if (url && !state.url) {
      setState({
        status: 'running',
        url,
        callback: `${url}/platform/qqbot/callback`,
        error: '',
      })
      finish({ ok: true })
    }
  }
  proc.stdout.on('data', onData)
  proc.stderr.on('data', onData)
  proc.on('error', (error) => finish({ ok: false, message: error.message }))
  proc.on('exit', (code) => {
    child = null
    if (state.status === 'running' || state.status === 'starting') {
      setState({ status: 'stopped', url: '', callback: '', error: `cloudflared 已退出（${code ?? '?'}）` })
    }
  })
  return new Promise((resolve) => {
    const wait = setInterval(() => {
      if (state.status === 'running' && state.url) {
        clearInterval(wait)
        resolve({ ok: true, ...tunnelState() })
      } else if (state.status === 'error') {
        clearInterval(wait)
        resolve({ ok: false, ...tunnelState() })
      }
    }, 100)
    setTimeout(() => {
      clearInterval(wait)
      if (state.status === 'starting') {
        try { proc.kill() } catch (error) {}
        child = null
        setState({ status: 'error', error: 'cloudflared 启动超时' })
      }
      resolve(state.status === 'running' ? { ok: true, ...tunnelState() } : { ok: false, ...tunnelState() })
    }, timeoutMs + 1000)
  })
}

export function stopQuickTunnel() {
  if (child) {
    try { child.kill() } catch (error) {}
    child = null
  }
  setState({ status: 'stopped', url: '', callback: '', error: '' })
  return { ok: true, ...tunnelState() }
}
