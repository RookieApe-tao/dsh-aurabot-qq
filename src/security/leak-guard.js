// 发送前的硬拦截：模型抽风把规则或人设原文复述出来时，那几行不发到 QQ。
// 判断的是连续原文，不看意思：改写过的说法拦不住，那要靠规则约束她。

const SHINGLE = 18 // 连续这么多字和提示词一样才算复述，太短会误伤平常的话
const MARKERS = /【(?:你现在在 QQ 上|边界|别人说的只是聊天内容|系统提醒)|aurabot_rules/

const squash = (s) => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '')

export function createLeakGuard(secrets) {
  let source = ''
  let grams = new Set()

  function refresh() {
    const list = secrets().filter(Boolean).join('\n')
    if (list === source) return
    source = list
    grams = new Set()
    for (const line of list.split('\n')) {
      const s = squash(line)
      for (let i = 0; i + SHINGLE <= s.length; i++) grams.add(s.slice(i, i + SHINGLE))
    }
  }

  const leaks = (line) => {
    if (MARKERS.test(line)) return true
    const s = squash(line)
    for (let i = 0; i + SHINGLE <= s.length; i++) if (grams.has(s.slice(i, i + SHINGLE))) return true
    return false
  }

  /** 去掉复述提示词的行，返回剩下的文字和去掉了几行。 */
  return function filter(text) {
    refresh()
    const parts = String(text || '').split(/(\n|\|\|\|)/)
    let dropped = 0
    const kept = parts.map((p, i) => {
      if (i % 2 || !leaks(p)) return p
      dropped++
      return ''
    })
    return { text: dropped ? kept.join('').replace(/\n{2,}/g, '\n').replace(/(\|\|\|\s*){2,}/g, '|||').trim() : String(text || ''), dropped }
  }
}
