// 内置模块：QQ 接口。SnowLuma 能做的事太多，不一个个写工具：一张权限表（actions.js）加两个工具，
// 工具定义短，不占提示词；她要用时先查再调。

import { defineTool, str } from '../../tools/tools.js'
import { QQ_API, paramsOf } from './actions.js'
import { clipText } from '../../core/text.js'

const RESULT_CHARS = 3000

/** 这一轮能不能调这个接口，不能就返回原因。 */
export function refusal({ action, params, cfg, owner, chat }) {
  const entry = QQ_API[action]
  if (!entry) return '这个接口不开放'
  for (const p of paramsOf(action)) if (p.required && (params[p.name] === undefined || params[p.name] === '')) return `缺参数 ${p.name}`
  if (owner) {
    if (entry[0] === 'owner' && (cfg.dryRun || !cfg.enabled)) return '现在是试运行，不真的执行'
    return ''
  }
  if (entry[0] !== 'open') return '这个只有主人开口才能用'
  if (action !== 'translate_en2zh' && (chat.kind !== 'group' || String(params.group_id) !== String(chat.groupId))) return '只能查当前这个群'
  return ''
}

/** 只留表里写的参数，模型多写的不传给网关。 */
export function pickParams(action, params) {
  const out = {}
  for (const p of paramsOf(action)) if (params[p.name] !== undefined) out[p.name] = params[p.name]
  return out
}

export default {
  id: 'qq-api',
  name: 'QQ 接口',
  version: '1.0.0',
  description: '把 SnowLuma 的 QQ 能力交给她：查群公告、精华、荣誉、群文件，主人开口时还能撤回、设精华、改群名片等（qq_api_find / qq_api_call）',
  api: 1,
  setup(api) {
    const { hub, onebot } = api.core
    api.tool(({ chat, level, sessionId }) => {
      if (chat.kind === 'system' || api.config().qqApi?.enabled === false) return []
      const isOwner = () => level === 'full' || Boolean(hub.turnSendersAllOwner?.(sessionId))
      return [
        defineTool({
          name: 'qq_api_find',
          description: '查 QQ 能做的事。用关键词找接口（比如 精华、公告、撤回、荣誉、群文件），返回接口名、参数和说明。',
          properties: { keyword: str('关键词，中文或接口名的一部分') },
          required: ['keyword'],
          execute: async ({ keyword }) => {
            const key = String(keyword || '').trim()
            const hits = Object.entries(QQ_API).filter(([name, e]) => (isOwner() || e[0] === 'open') && (name.includes(key) || e[2].includes(key))).slice(0, 12)
            if (!hits.length) return { ok: true, message: '没找到，换个说法' }
            return { ok: true, message: hits.map(([name, e]) => `${name}(${e[1]})：${e[2]}`).join('\n') }
          },
          render: (_args, value) => [{ type: 'text', text: value?.message || '' }],
        }),
        defineTool({
          name: 'qq_api_call',
          description: '调用 QQ 接口。先用 qq_api_find 查到接口名和参数。param 是 JSON 对象文字，比如 {"group_id":123456}。',
          properties: { action: str('接口名'), param: str('参数，JSON 对象文字') },
          required: ['action'],
          execute: async ({ action, param }) => {
            let params = {}
            try { params = JSON.parse(param || '{}') } catch (error) { return { ok: false, message: 'param 不是合法的 JSON' } }
            if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, message: 'param 要是 JSON 对象' }
            const name = String(action || '')
            const no = refusal({ action: name, params, cfg: api.config(), owner: isOwner(), chat })
            if (no) return { ok: false, message: no }
            api.log.info(`qq_api：${chat.chatId} 调用 ${name}`)
            const data = await onebot.call(name, pickParams(name, params), { timeoutMs: 15000, retries: 0 })
            return { ok: true, message: clipText(JSON.stringify(data ?? null), RESULT_CHARS) }
          },
          render: (_args, value) => [{ type: 'text', text: value?.message || '' }],
        }),
      ]
    })
    api.rule((kind, cfg) => (cfg.qqApi?.enabled === false ? [] : [kind === 'social'
      ? '- 群公告、精华、荣誉、群文件这些，用 qq_api_find 查接口再用 qq_api_call 调；别人只能查当前这个群。'
      : '- QQ 上想做的事（撤回、设精华、改群名片、点赞、表情回应、查群公告等）没有专门工具时，用 qq_api_find 查接口再用 qq_api_call 调。'].filter(Boolean)))
  },
}
