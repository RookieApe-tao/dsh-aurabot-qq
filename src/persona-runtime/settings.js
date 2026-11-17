// 人格运行时（persona-runtime）· 配置读取与归一（设计 docs/design/persona-runtime/00-design.md
// §2.2 九开关 / §2.5 token 预算 / §4 配置汇总；实施拆分 R1）
//
// 作用：把 api.settings()（模块 defaults 与 ext['persona-runtime'] 合并后的原始配置）归一成一份
//      「运行时开关快照」。注入函数、路由、面板、审计全都用这一份判断，避免各处各读一份口径漂移。
//
// 契约（fail-closed，设计审查 7）：
//   · 本文件永不抛错：读配置失败 / 值类型不对 / 键缺失，一律回落到安全侧。
//   · 安全类开关（adminMode / hostTakeover）严格 `=== true` 才算开——读不到就是关。
//   · 体验类开关（selfAware / agentIdentity / affectThought / affectPerceive / emotionMemory）在读取
//     失败时按「人格卡基线」= DEFAULT_SWITCHES 回落：配置读不到不等于主人要全关，整层摘掉会是
//     「全关退化」而不是「配置异常」；异常本身由 configError 显性暴露给面板。
//   · 预算键一律 clamp 到安全区间；非法值回落默认（不可观测的预算等于没有预算，见 §7 纪律 5）。
//   · 本文件零 IO、零依赖：单测直接传 { settings: () => ({...}) } 之类的假 api 即可。

/** 开关默认值。体验类 = 人格卡基线（开）；安全/主动类 = 关（fail-closed 的另一面）。 */
export const DEFAULT_SWITCHES = Object.freeze({
  enabled: true,        // 爆式总开关：关=整个 Runtime 层退场，回复管线回到「人格卡 + mood 旧口径」
  selfAware: true,      // 自我意识（稳定半段进 system，每轮半段进用户消息尾）
  agentIdentity: true,  // 独立智能体身份（群聊以本名本人身份应答）
  affectThought: true,  // 情感思想（情绪向量 → 判断倾向）
  affectPerceive: true, // 情感感知（先读对方语气再回）
  emotionMemory: true,  // 情绪记忆（残余小史进上下文 + 观察桥推送）
  adminMode: false,     // 超级管理员：申报级别上限放开到主机级（管申报级别，不管语气）
  hostTakeover: false,  // 宿主接管：接管期申报一律排队（绝不进 autoConfirmOwner 豁免）
  activeThinking: false, // 主动思考：只做 ignite 事件转发，物理不存在静默期推演
})

/** 预算键默认值（§2.5；键族 rt（runtime 前缀）与 autotelic 的 chat / intent / gate / review 四组严格分家）。 */
export const DEFAULT_BUDGETS = Object.freeze({
  rtMaxInjectTokens: 600, // 对话轮四段注入总上限
  rtIdentityTokens: 120,  // 自我意识每轮半段
  rtAffectTokens: 150,    // 情感思想段
  rtPerceiveTokens: 150,  // 情感感知段
  rtMemoryTokens: 180,    // 情绪记忆段（含 N 条小史）
})

/** 预算键的安全区间：面板给它一个边界，手写配置写飞了也不至于把每轮撑爆或全裁。 */
export const BUDGET_RANGES = Object.freeze({
  rtMaxInjectTokens: { min: 0, max: 8000, def: 600 },
  rtIdentityTokens: { min: 0, max: 2000, def: 120 },
  rtAffectTokens: { min: 0, max: 2000, def: 150 },
  rtPerceiveTokens: { min: 0, max: 2000, def: 150 },
  rtMemoryTokens: { min: 0, max: 2000, def: 180 },
})

/** 全部开关键（顺序即面板行序：总开关 → 九开关）。 */
export const SWITCH_KEYS = Object.freeze(Object.keys(DEFAULT_SWITCHES))
/** 安全类开关（fail-closed 严格判）。 */
export const SECURITY_SWITCHES = Object.freeze(['adminMode', 'hostTakeover'])
/** 预算键。 */
export const BUDGET_KEYS = Object.freeze(Object.keys(DEFAULT_BUDGETS))

const clampInt = (value, range) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return range.def
  return Math.min(range.max, Math.max(range.min, Math.round(n)))
}

/**
 * 读并归一模塊配置。
 * @param {{settings?:()=>object}|object} api 模块 api（只需要 settings()；测试可给假的）
 * @returns {object} 冻结快照：9 个开关 + 5 个预算键 + configError（true = 配置读取异常）
 */
export function readRuntimeSettings(api) {
  let raw = null
  let configError = false
  try {
    const fn = typeof api?.settings === 'function' ? api.settings : null
    raw = fn ? fn() : api
  } catch (error) {
    configError = true
    raw = null
  }
  if (!raw || typeof raw !== 'object') {
    configError = true
    raw = {}
  }
  const out = {}
  for (const key of SWITCH_KEYS) {
    const v = raw[key]
    // 安全类：严格 true 才算开（fail-closed）；体验类：读不到就按人格卡基线回落
    if (SECURITY_SWITCHES.includes(key)) out[key] = v === true
    else out[key] = typeof v === 'boolean' ? v : DEFAULT_SWITCHES[key]
  }
  for (const key of BUDGET_KEYS) out[key] = clampInt(raw[key], BUDGET_RANGES[key])
  // 总开关读不到时按默认（开）：模块壳已经在 BUILTINS 里，这里再返回「关」会让一次读配置抖动
  // 静默把整层摘掉——真正的关断由 configError 提示 + 面板开关显式执行。
  if (typeof raw.enabled !== 'boolean' && configError) out.enabled = DEFAULT_SWITCHES.enabled
  out.configError = configError
  return Object.freeze(out)
}

/** 面板/status 用的开关清单（键 + 中文名 + 说明），避免面板与实现各写一份。 */
export const SWITCH_LABELS = Object.freeze([
  { key: 'enabled', label: '启用人格运行时', hint: '总开关。关掉整个 Runtime 层（≠插件总开关）：回复管线精确退回「人格卡 + mood 旧口径」，她依然是完整伙伴' },
  { key: 'selfAware', label: '自我意识', hint: '开：跨话题长对话自称稳定、被问「你是谁」答案恒定；关：只靠人格卡正文' },
  { key: 'agentIdentity', label: '独立智能体身份', hint: '开：群聊里以「自己」的名字与本名身份应答；关：回退群聊规则的既有口径' },
  { key: 'affectThought', label: '情感思想', hint: '开：判断带好恶有温度；关：中性助手腔有问必答无态度' },
  { key: 'affectPerceive', label: '情感感知', hint: '开：撒娇接得住、抱怨先共情、玩笑不较真；关：字面理解。最能日常感知的开关' },
  { key: 'emotionMemory', label: '情绪记忆', hint: '开：聊天氛围有连续性；关：每条消息情绪从零开始。残余同时写一条观察（情绪也是经历）' },
  { key: 'adminMode', label: '超级管理员', hint: '只管对话内行动申报的级别上限（主机级放开），不管语气/人格。硬禁区优先于本开关；每次行使写审计' },
  { key: 'hostTakeover', label: '宿主接管', hint: '接管期她的一切本机操作申报一律排队等主人亲自放行（不进 autoConfirmOwner 豁免）' },
  { key: 'activeThinking', label: '主动思考', hint: '语义已改造：开 = 允许重要对话结束点燃一次自驱回味（ignite 转发）；关 = 只剩定时回味。物理不存在静默期持续推演' },
  { key: 'rtMaxInjectTokens', label: '每轮注入总预算（token）', hint: '对话轮四段注入总上限（不是模型调用预算）。超了先裁情绪记忆，再裁情感感知/思想，自我意识与人格锚永不裁' },
  { key: 'rtIdentityTokens', label: '自我意识段预算（token）', hint: '' },
  { key: 'rtAffectTokens', label: '情感思想段预算（token）', hint: '' },
  { key: 'rtPerceiveTokens', label: '情感感知段预算（token）', hint: '' },
  { key: 'rtMemoryTokens', label: '情绪记忆段预算（token）', hint: '含最近 N 条残余小史（≤24h、≤5 条，不落盘）' },
])
