// 人格运行时 · 情绪三件事里的「读」与「残余小史现场派生」（设计 §2.3 / §3.2 / 审查 5；实施拆分 R4）
//
// 作用：把 mood 模块（情绪唯一真相与唯一写入口）的现状读成注入所需的形状：
//      1) 情感思想段要的「最强情绪 + 强弱」；
//      2) 情绪记忆段要的「最近 N 条残余小史」。
//
// 契约（PR9 单写者原则）：
//   · 本文件**只读** mood：不调 feel / nudge / importEmotions，不写 mood.json，不另建向量、不设第二半衰。
//   · 残余小史**不落盘**（工作区裁决：dataDir 只留 runtime.json 开关快照）。它是可重建的派生缓存，
//     每轮从 mood.state() 现场派生「≤24h、≤5 条」，丢了下次读还在——因此消除高频路径同步 IO。
//   · 清残余 = 清派生展示（route 提供）；**不提供清向量**——那是对她情绪的篡改，向量交 mood 半衰自然消退。
//   · mood 模块没跑 / state() 抛错 / 字段缺失：一律返回空结果，绝不抛错（增强层不许拖垮主流程）。
//   · 纯函数 + 一个薄读取包装；零依赖（不 import mood 内部，只吃它的 state() 导出面）。

/** 残余小史窗口：24h（更旧的按半衰早就淡了，留着只会误导）。 */
export const RESIDUAL_WINDOW_MS = 24 * 3600_000
/** 残余小史条数上限（§9.3 口径 N=5，降级时按 5→3→1→0 裁）。 */
export const RESIDUAL_MAX = 5

/** 强度措辞：跟 arousal 走（照 purpose 的既有规则）。 */
export function strengthWord(arousal) {
  const a = Number(arousal)
  if (!Number.isFinite(a)) return '隐约'
  if (a >= 0.75) return '强烈'
  if (a >= 0.5) return '明显'
  if (a >= 0.3) return '有些'
  return '隐约'
}

/** 强弱分档（情感思想段的括号里那句）。 */
export function strengthLevel(arousal) {
  const a = Number(arousal)
  if (!Number.isFinite(a)) return '弱'
  if (a >= 0.75) return '强'
  if (a >= 0.5) return '中'
  return '弱'
}

/**
 * 从 mood.state() 取「此刻最强的一项」。
 * state() 已经给了 emotionTop（{key,label,icon,value}）与 emotions（键→值）；
 * emotionTop 缺失时按 emotions 自己挑一个，挑不出返回 null（「没什么心情」是合法状态）。
 * @param {object} state mood.state() 的返回
 * @returns {{key:string,label:string,value:number}|null}
 */
export function topOf(state) {
  if (!state || typeof state !== 'object') return null
  const top = Array.isArray(state.emotionTop) ? state.emotionTop[0] : state.emotionTop
  if (top && typeof top === 'object' && top.key) {
    return { key: String(top.key), label: String(top.label || top.key), value: Number(top.value) || 0 }
  }
  const vector = state.emotions
  if (!vector || typeof vector !== 'object') return null
  let best = null
  for (const [key, raw] of Object.entries(vector)) {
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0.02) continue
    if (!best || value > best.value) best = { key: String(key), label: String(key), value }
  }
  if (!best) return null
  // 标签从 emotionsItems 里补齐（面板项带 label）
  const items = Array.isArray(state.emotionsItems) ? state.emotionsItems : []
  const item = items.find((x) => x && x.key === best.key)
  if (item) best.label = String(item.label || best.key)
  return best
}

/**
 * 从 mood.state() 现场派生「最近 N 条残余小史」。
 *
 * 数据来源是 mood 自己的 emotionTop/emotions（此刻）与 history（心情标量的 200 条变动记录，
 * 每条 {at, from, to, reason, chatId}）。我们**不复制**它的 delta/reason 全账，只提炼成
 * 「什么时候、大致什么感觉」这种丢了可重建的短句，供情绪记忆段使用。
 *
 * @param {object} state mood.state()
 * @param {object} [opts]
 * @param {number} [opts.now] 时间源
 * @param {number} [opts.limit] 条数上限（默认 RESIDUAL_MAX）
 * @param {number} [opts.windowMs] 时间窗（默认 24h）
 * @returns {{at:number, label:string, source:string, direction:string}[]} 旧→新
 */
export function deriveResiduals(state, { now = Date.now(), limit = RESIDUAL_MAX, windowMs = RESIDUAL_WINDOW_MS } = {}) {
  if (!state || typeof state !== 'object') return []
  const cap = Math.max(0, Math.floor(Number(limit) || 0))
  if (!cap) return []
  const since = now - windowMs
  const out = []

  // 1) 心情标量变动史：24h 内、有实际变化（|Δ|≥1）的条目 → 一条「那会儿心里往上/往下走」
  const history = Array.isArray(state.history) ? state.history : []
  for (const h of history) {
    if (!h || typeof h !== 'object') continue
    const at = Number(h.at) || 0
    if (!at || at < since || at > now + 60_000) continue
    const from = Number(h.from)
    const to = Number(h.to)
    const delta = Number.isFinite(from) && Number.isFinite(to) ? to - from : 0
    if (Math.abs(delta) < 1) continue
    out.push({
      at,
      // 口语化短标签：只留「因为什么」这个可追溯的锚，不搬 mood 的 delta/reason 全账
      label: String(h.reason || '').trim() ? `「${String(h.reason).slice(0, 18)}」那会儿` : (delta > 0 ? '心情往上走了一点' : '心情往下沉了一点'),
      source: 'chat',
      direction: delta > 0 ? 'up' : 'down',
    })
  }

  // 2) 此刻最强的那一项也算一条（「这阵子主要是…」的锚点），只有它没有对应历史时才补
  const top = topOf(state)
  if (top) {
    const shown = out.some((r) => r.label.includes(top.label))
    if (!shown) {
      out.push({ at: now, label: `眼下是「${top.label}」`, source: 'now', direction: 'flat' })
    }
  }

  // 旧→新排序（history 是新的在前），取最近 cap 条
  out.sort((a, b) => a.at - b.at)
  return out.slice(-cap)
}

/**
 * 残余小史的一句话概括（情绪记忆段的主句）：「这阵子先往下沉，后来主要是『平静』」这种。
 * @param {{direction:string,label:string}[]} residuals 旧→新
 * @returns {string}
 */
export function summarizeResiduals(residuals = []) {
  const list = Array.isArray(residuals) ? residuals.filter(Boolean) : []
  if (!list.length) return ''
  const last = list[list.length - 1]
  const trend = (() => {
    const ups = list.filter((r) => r.direction === 'up').length
    const downs = list.filter((r) => r.direction === 'down').length
    if (ups && !downs) return '一路往上走'
    if (downs && !ups) return '一路往下沉'
    if (ups && downs) return '起起落落'
    return '一直比较平'
  })()
  if (list.length === 1) return `这阵子${trend}，${last.label}`
  return `这阵子${trend}，${last.label}`
}

/**
 * 薄读取包装：拿 mood 模块的 state()，出错返回 null（只读、零副作用）。
 * @param {object|null} mood api.use('mood') 的导出面
 * @returns {object|null}
 */
export function readMoodState(mood) {
  try {
    if (!mood || typeof mood.state !== 'function') return null
    const s = mood.state()
    return s && typeof s === 'object' ? s : null
  } catch {
    return null
  }
}

/**
 * 显著波动检测（§2.3 转发口径）：emotionTop 键变化 或 心情标量 |Δ|≥8。
 *
 * 注意：调用方每轮把上一次的快照传进来，本函数**只比较不记账**（快照放内存，由模块壳持有）——
 * Runtime 不落盘、不设第二个写入口。
 *
 * @param {object|null} prev 上一轮的 {topKey, value}
 * @param {object|null} state mood.state()
 * @param {number} [threshold] 标量阈值（默认 8）
 * @returns {{changed:boolean, topKey:string, value:number, topChanged:boolean, valueDelta:number, label:string}|null}
 *   prev 为 null（首轮）时返回 null：首轮没有可比对象，不伪造一次波动（宁缺毋假）。
 */
export function detectShift(prev, state, threshold = 8) {
  if (!prev || typeof prev !== 'object') return null
  if (!state || typeof state !== 'object') return null
  const top = topOf(state)
  const topKey = top ? top.key : ''
  const topLabel = top ? top.label : ''
  const value = Number(state.value)
  const prevValue = Number(prev.value)
  const topChanged = Boolean(prev.topKey) && Boolean(topKey) && String(prev.topKey) !== topKey
  const valueDelta = Number.isFinite(value) && Number.isFinite(prevValue) ? value - prevValue : 0
  const bigMove = Math.abs(valueDelta) >= Number(threshold || 8)
  if (!topChanged && !bigMove) {
    return { changed: false, topKey, value: Number.isFinite(value) ? value : 0, topChanged: false, valueDelta, label: topLabel }
  }
  return {
    changed: true,
    topKey,
    value: Number.isFinite(value) ? value : 0,
    topChanged,
    valueDelta: Math.round(valueDelta),
    label: topLabel,
  }
}

/** 波动 → 一条观察文本（source='emotion'，喂 autotelic.observe.append）。 */
export function shiftText(shift) {
  if (!shift || !shift.changed) return ''
  const parts = []
  if (shift.topChanged && shift.label) parts.push(`心里最强的感觉变成「${shift.label}」`)
  if (Math.abs(shift.valueDelta) >= 8) parts.push(`心情${shift.valueDelta > 0 ? '往上' : '往下'}走了 ${Math.abs(shift.valueDelta)}`)
  return parts.join('，')
}

/**
 * 波动 → 观察显著度（0~1）：键变化给 0.6（与旧轮询桥同口径），幅度越大越高，封顶 0.9。
 * 低于观察层门控线（默认 0.2）的不会被写入——这是观察层自己的规矩，这里不去绕过。
 */
export function shiftSalience(shift) {
  if (!shift || !shift.changed) return 0
  let v = shift.topChanged ? 0.6 : 0.45
  v += Math.min(0.3, Math.abs(Number(shift.valueDelta) || 0) / 100)
  return Math.min(0.9, Math.round(v * 100) / 100)
}
