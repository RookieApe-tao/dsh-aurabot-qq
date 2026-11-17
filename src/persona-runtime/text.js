// 人格运行时 · 注入文本的 token 粗估与裁剪（设计 §2.5 / §4.3 降级顺序的度量工具）
//
// 作用：给「每轮注入文本」一个可观测、可机械执行的量。粗估口径与 autotelic v5 §9.3 一致：
//      中文 2 字符 ≈ 1 token。这里按**码点**计数（[...text]），emoji / 生僻字不会被算成 2 个 char
//      从而虚高预算。
//
// 契约：
//   · estimateTokens(text) → 非负整数（空串 0）
//   · cutToTokens(text, maxTokens) → 不超预算的文本；被裁时在尾部留省略号，原样可见「被裁过」
//   · 本文件纯函数、零 IO、零依赖。

/** 码点长度（emoji 记 1）。 */
export const charsOf = (text) => [...String(text ?? '')].length

/**
 * 粗估 token 数：中文 2 字符 ≈ 1 token。
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const n = charsOf(text)
  return n ? Math.ceil(n / 2) : 0
}

/**
 * 把文本裁到 token 预算内（保留开头——注入段的结论都在句首，尾部是补充说明）。
 * 被裁时补一个「…」让人一眼看出裁过（可审计，不静默）。
 * @param {string} text
 * @param {number} maxTokens 0 或负数 → 返回空串
 * @returns {string}
 */
export function cutToTokens(text, maxTokens) {
  const raw = String(text ?? '')
  const limit = Math.floor(Number(maxTokens))
  if (!raw) return ''
  if (!Number.isFinite(limit) || limit <= 0) return ''
  if (estimateTokens(raw) <= limit) return raw
  // 预算折回字符数，留 1 个字符给省略号
  const maxChars = Math.max(0, limit * 2 - 1)
  const chars = [...raw]
  if (maxChars <= 1) return ''
  return chars.slice(0, maxChars).join('') + '…'
}

/** 一句话摘要：按码点截断并可指定后缀（残余小史的口语化浓缩用）。 */
export function clipText(text, maxChars = 24, suffix = '…') {
  const chars = [...String(text ?? '').trim()]
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') + suffix : chars.join('')
}
