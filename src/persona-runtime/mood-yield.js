// 人格运行时 · mood.contextLine 让位（设计 §1.2 全关退化形态，审查 3 保守取合方案 a）
//
// 背景（钉死口径）：`mood.contextLine` **永久保留为 fallback**——Runtime 开时它让位（防同一句话
// 在一轮里出现两遍），Runtime 关时 mood 顶上。零成本、且符合「增强层」的语义。
//
// 为什么用「摘块」而不是「改 mood」：
//   本模块的写作用域只有 src/persona-runtime/** 与 src/modules/persona-runtime/**（外加 BUILTINS 一行），
//   mood 模块的注册顺序在本模块之前（BUILTINS 里 mood 在前），所以它的 prompt 钩子先跑、把它那一段
//   追加进 content；本模块的钩子随后拿到 content，**在接管时把它摘掉**即可实现让位——
//   不改 mood 一行代码、不动 hub.js、也不引入第二套开关。
//
// 契约：
//   · 只摘「mood.contextLine 的固定句式」，不摘别人的块（句式见 MOOD_LINE_RES）。
//   · 只在 Runtime 真的要接管情绪段（enabled 且 affectThought 或 emotionMemory 有注入）时摘；
//     否则原样留着（mood 顶上 = 全关退化形态）。
//   · 纯函数，无副作用；不认识 ContentPart 的自由格式内容不会误伤（必须是 text 块且整块匹配）。

/** mood.contextLine 的固定句式（features/mood.js L283 的模板）：
 *  `（你现在${label}${reason}。这会自然地影响你说话：${style}。不用说出来自己心情如何。）`
 *  只匹配整块，避免误摘把这句话当内容引用的用户文本。 */
const MOOD_LINE_RES = [
  /^（你现在[^）]*这会自然地影响你说话：[^）]*不用说出来自己心情如何。）$/s,
]

/**
 * 判断一个 content 块是不是 mood.contextLine 产出的那种块。
 * @param {object} block 宿主的 ContentPart（{type:'text', text}）
 * @returns {boolean}
 */
export function isMoodContextBlock(block) {
  if (!block || block.type !== 'text') return false
  const text = String(block.text ?? '').trim()
  if (!text) return false
  return MOOD_LINE_RES.some((re) => re.test(text))
}

/**
 * Runtime 接管时把 mood 的 contextLine 块摘掉（让位），没接管时原样返回。
 *
 * @param {Array} content 本轮 content 块数组
 * @param {boolean} takeOver Runtime 是否要接管情绪段（enabled 且至少一段情绪注入有内容）
 * @returns {Array} 处理后的块数组（takeOver=false 时是同一个引用，零拷贝）
 */
export function yieldMoodLine(content, takeOver) {
  if (!takeOver) return content
  if (!Array.isArray(content)) return content
  let removed = 0
  const out = content.filter((block) => {
    if (!isMoodContextBlock(block)) return true
    removed += 1
    return false
  })
  return removed ? out : content
}
