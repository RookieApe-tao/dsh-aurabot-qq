// 群消息入口过滤；纯配置判断，不联网、不创建计时器。
import { isOwner } from './access.js'
const id = value => typeof value === 'string' && /^[1-9]\d{4,11}$/.test(value)
export function validMemberFilter(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(k => ['enabled', 'rules'].includes(k)) && typeof value.enabled === 'boolean' &&
    Array.isArray(value.rules) && value.rules.length <= 100 &&
    new Set(value.rules.map(r => r?.userId)).size === value.rules.length &&
    value.rules.every(r => r && typeof r === 'object' && !Array.isArray(r) &&
      Object.keys(r).every(k => ['userId', 'scope', 'groups'].includes(k)) && id(r.userId) &&
      ['all', 'groups'].includes(r.scope) && Array.isArray(r.groups) && r.groups.length <= 100 && r.groups.every(id))
}
export function normalizeMemberFilter(value) {
  // 无效文件配置不会变成「所有群」；面板另行严格拒绝无效输入。
  const seen = new Set()
  const rules = []
  for (const r of Array.isArray(value?.rules) ? value.rules : []) {
    if (!r || !id(r.userId) || seen.has(r.userId) || !['all', 'groups'].includes(r.scope) || !Array.isArray(r.groups) || !r.groups.every(id)) continue
    seen.add(r.userId)
    rules.push({ userId: r.userId, scope: r.scope, groups: [...new Set(r.groups)].slice(0, 100) })
    if (rules.length === 100) break
  }
  return { enabled: value?.enabled !== false, rules }
}
// 融合：主人判定走身份库（ownerRef = identity），不再用旧配置的硬编码 QQ 号比较；ownerRef 缺省时
// 由调用方传入的 msg.sender.isOwner 兜底（网关已算好的字段）。
export function ignoredGroupMember(cfg, msg, ownerRef = null) {
  if (msg?.kind !== 'group' || cfg.memberFilter?.enabled !== true) return false
  const user = String(msg.userId || ''), group = String(msg.groupId || '')
  if (!id(user) || !id(group) || isOwner(ownerRef, msg) || msg?.sender?.isOwner === true) return false
  return (cfg.memberFilter.rules || []).some(r => r.userId === user &&
    (r.scope === 'all' || (r.scope === 'groups' && r.groups.includes(group))))
}
