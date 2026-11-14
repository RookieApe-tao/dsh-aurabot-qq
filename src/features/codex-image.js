// 实验性订阅接法：使用非公开端点，账号 / 工作区是否可用由服务端决定。
import { randomUUID } from 'node:crypto'
import { fetchImage } from '../core/net.js'
import { mimeOf } from '../chat/inbound.js'
import { pickShape } from './image-shape.js'

function requestError(message, status) { const error = new Error(message); error.imageRequestFailed = true; if (status) error.imageStatus = status; return error }

export function createCodexImage({ auth, fetchImpl, log }) {
  return async function generate(config, prompt, { shape, image } = {}) {
    const revision = auth.revision?.()
    const check = () => auth.assertCurrent?.(revision)
    check()
    const c = config.codex || {}
    const hint = { square: '方图构图（1:1）', portrait: '竖版构图（2:3）', landscape: '横版构图（3:2）', wide: '宽幅横版构图（16:9）' }[pickShape(shape, config)]
    const editing = Buffer.isBuffer(image) && image.length > 0
    const body = { prompt: [prompt, hint].filter(Boolean).join('，'), model: c.model || 'gpt-image-2', quality: c.quality || 'auto', size: 'auto', background: c.background || 'auto' }
    // Codex 订阅的图片编辑端点：images 是 data URL 数组，和文生图共用同一套鉴权/响应格式。
    if (editing) {
      const detected = String(mimeOf(image) || '')
      const mime = detected.startsWith('image/') ? detected : 'image/png'
      body.images = [{ image_url: `data:${mime};base64,${image.toString('base64')}` }]
    }
    const endpoint = editing
      ? 'https://chatgpt.com/backend-api/codex/images/edits'
      : 'https://chatgpt.com/backend-api/codex/images/generations'
    const once = async ({ access, accountId }) => {
      check()
      if (!accountId) throw new Error('登录信息里没有账号 ID，去生图页重新登录 ChatGPT')
      try { return await fetchImpl(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${access}`, 'chatgpt-account-id': accountId, accept: 'application/json', 'content-type': 'application/json', originator: 'pi', 'x-codex-image-turn-id': randomUUID(), 'user-agent': 'aurabot-qq' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
      }) } catch (error) { error.imageRequestFailed = true; error.imageNetworkFailure = true; throw error }
    }
    log.info(`订阅${editing ? '图片编辑' : '生图'}请求：${body.model} / ${body.quality}`)
    let credential
    try { credential = await auth.ensureAccess() } catch (error) { error.imageRequestFailed = true; throw error }
    let r = await once(credential)
    check()
    if (r.status === 401) {
      await r.body?.cancel()
      try { credential = await auth.ensureAccess({ force: true }) }
      catch (error) { throw requestError('订阅登录已过期，去生图页重新登录 ChatGPT') }
      r = await once(credential)
      check()
    }
    const j = await r.json().catch(() => null)
    check()
    if (!r.ok) {
      if (r.status === 401) throw requestError('订阅登录已失效，去生图页重新登录 ChatGPT', 401)
      if (r.status === 403) throw requestError('这个订阅 / 工作区不能用生图（HTTP 403）', 403)
      if (r.status === 429) throw requestError('订阅生图用得太频繁或额度用完了（HTTP 429）', 429)
      throw requestError(`订阅生图失败（HTTP ${r.status}）`, r.status)
    }
    const item = j?.data?.[0]
    if (typeof item?.b64_json === 'string' && item.b64_json) return Buffer.from(item.b64_json, 'base64')
    if (typeof item?.url === 'string' && item.url) {
      const buf = await fetchImage(item.url, { maxBytes: 20 * 1024 * 1024, allowLocal: false, timeoutMs: 120000 })
      check()
      return buf
    }
    throw new Error('订阅生图没有返回图片')
  }
}
