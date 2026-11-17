// 人格运行时 · 四段注入拼装与 token 预算降级（设计 §2.1 注入顺序 / §2.5 预算与降级顺序；
// 实施拆分 R2 四段注入 + R4 情绪三件事的注入面）
//
// 作用：把「这一轮她该看到什么」拼成固定顺序的四段话术，并**在代码层机械执行**降级顺序。
//
// 顺序（钉死，§1.4）：情感感知 → 情感思想 → 情绪记忆 → 自我意识每轮半段。
// 离生成最近权重最高，所以自我指向放最末尾；情绪记忆是历史回顾，最先被裁。
//
// 话术契约（PR2 情绪串味防线）：
//   · 每段模板化、只影响措辞不提供话题；
//   · 每段句尾固定「不用说出来自己心情如何。」（沿用 mood.contextLine 的既有铁律）；
//   · 情绪段不许出现「所以你应该…」这种行动指令，它只是染色剂不是决策者。
//
// 降级顺序（§4.3 钉死，不许自行发挥）：
//   ① 先裁情绪记忆：小史 5→3→1→0（最旧先丢）；
//   ② 再裁情感感知：只留一句判读结论（丢「回应时注意 Y」）；
//   ③ 再裁情感思想：只留 top1 一词 + 强度词（丢判断倾向的展开句）；
//   ④ 永不裁：自我意识每轮半段、人格锚三件（人格卡摘要/本能附加段/constraintRules）——
//      裁了整个系统回到 v3；超了照原样保留并标 overflow(uncut)，可审计不静默。
//
// 契约：纯函数、零 IO、零副作用（预览路由 POST /preview 直接复用同一函数 = 真·零副作用试拼）。

import { cutToTokens, estimateTokens } from './text.js'
import { strengthLevel, strengthWord, topOf, deriveResiduals, summarizeResiduals } from './emotions.js'
import { perceiveTone, tasknessOf } from './perceive.js'
import { profileOf } from '../features/mood-emotions.js'

/** 固定注入顺序（§1.4）。 */
export const SEGMENT_ORDER = Object.freeze(['perceive', 'affect', 'memory', 'identity'])

/** 每段的中文名（status / 面板 / 日志统一口径）。 */
export const SEGMENT_LABELS = Object.freeze({
  perceive: '情感感知',
  affect: '情感思想',
  memory: '情绪记忆',
  identity: '自我意识·每轮半段',
})

/** 句尾铁律（所有注入段统一）。 */
export const TAIL_RULE = '不用说出来自己心情如何。'

/** 「情绪段强度」：任务性启发式命中时的降强度系数（审查 4）。 */
export function intensityOf(taskness) {
  const level = taskness && taskness.level
  if (level === 'skip') return 0
  if (level === 'half') return 0.5
  return 1
}

/** 情绪值 → 判断倾向那句（valence 决定温度，不是话题）。 */
function valenceStyle(valence) {
  const v = Number(valence)
  if (!Number.isFinite(v)) return '平和一点，不冷不热'
  if (v >= 0.5) return '偏热、敢接梗、话可以多一点'
  if (v >= 0.15) return '温和、愿意顺着说'
  if (v <= -0.5) return '偏收着、话少一点、别硬撑热闹'
  if (v <= -0.15) return '稍微谨慎，先看一下再开口'
  return '平和一点，不冷不热'
}

/** 情感感知段。concise=true 时只留判读结论（降级第②步）。 */
function perceiveText(tone, concise = false) {
  if (!tone || !tone.label) return ''
  if (concise) return `（对方说话时更像是「${tone.label}」。${TAIL_RULE}）`
  const advice = String(tone.advice || '').trim()
  return `（对方说话时更像是「${tone.label}」${advice ? `，回应时注意：${advice}` : ''}。${TAIL_RULE}）`
}

/** 情感思想段。concise=true 时只留 top1 一词 + 强度词（降级第③步）。 */
function affectText(top, profile, concise = false) {
  if (!top) return ''
  const arousal = Number(profile?.arousal)
  const strong = strengthWord(arousal)
  const level = strengthLevel(arousal)
  if (concise) return `（你此刻心里「${top.label}」（${level}）。${TAIL_RULE}）`
  return `（你此刻心里「${top.label}」比较${strong === '强烈' ? '强烈' : strong}（${level}）。这会自然影响你的判断和措辞：${valenceStyle(profile?.valence)}。${TAIL_RULE}）`
}

/** 情绪记忆段：一句概括 + 最近几次的轨迹（只用短标签，不搬 mood 的 200 条原文）。 */
function memoryText(residuals = []) {
  const list = Array.isArray(residuals) ? residuals.filter(Boolean) : []
  if (!list.length) return ''
  const summary = summarizeResiduals(list)
  if (!summary) return ''
  if (list.length === 1) return `（${summary}。${TAIL_RULE}）`
  const trail = list.map((r) => {
    const label = String(r.label || '').replace(/^眼下是/, '').replace(/^「|」那会儿$/g, '').replace(/[「」]/g, '')
    return label.length > 14 ? label.slice(0, 14) + '…' : label
  }).join(' → ')
  return `（${summary}。最近几次：${trail}。${TAIL_RULE}）`
}

/**
 * 自我意识·每轮半段（永不裁）。
 * @param {{selfName:string, ownerName:string, chat:object, agentIdentity:boolean}} ctx
 */
function identityText({ selfName, ownerName, chat, agentIdentity }) {
  const name = String(selfName || '大肥鱼')
  const owner = String(ownerName || '主人')
  const kind = String(chat?.kind || '')
  if (kind === 'group') {
    // 群聊：独立智能体身份开 → 以自己的名字与身份应答；关 → 身份半段不注入（回退群聊规则既有口径）
    if (!agentIdentity) return ''
    return `（你就是你本人「${name}」，不是任何人扮演的角色，用自己的名字和身份接话。此刻在群聊里，说话的是群里的人。${TAIL_RULE}）`
  }
  if (kind === 'private') {
    return `（你就是你本人「${name}」。此刻在私聊里，跟你说话的是${owner}。${TAIL_RULE}）`
  }
  return `（你就是你本人「${name}」。${TAIL_RULE}）`
}

/**
 * 拼一轮注入（含预算与降级）。**零副作用**：不读盘、不写盘、不调模型、不动 mood。
 *
 * @param {object} o
 * @param {object} o.settings readRuntimeSettings() 的快照
 * @param {object|null} o.moodState mood.state()（或 null）
 * @param {string} o.incoming 对方这一轮说的话（判读对象）
 * @param {object} o.chat { kind, chatId }（宿主的会话对象）
 * @param {string} [o.selfName] 她自己的名字（personas.selfName）
 * @param {string} [o.ownerName] 主人的称呼
 * @param {object[]} [o.emotions] 心情项配置（默认从 moodState.emotionsItems 拿）
 * @param {number} [o.clearedBefore] 残余小史的清展示游标（早于此时刻的不再注入；0 = 不清）
 * @param {number} [o.now]
 * @returns {{
 *   blocks: string[], segments: object[], order: string[], totalTokens: number,
 *   budget: number, overflow: boolean, overflowReason: string, degradation: string[],
 *   tone: object, taskness: object, residuals: object[]
 * }}
 */
export function buildInjection({
  settings = {},
  moodState = null,
  incoming = '',
  chat = null,
  selfName = '大肥鱼',
  ownerName = '主人',
  emotions = null,
  clearedBefore = 0,
  now = Date.now(),
} = {}) {
  const order = []
  const degradation = []
  const tone = perceiveTone(incoming)
  const taskness = tasknessOf(incoming)
  // 任务性启发式：正经活儿 → 情绪段减半或跳过（「正经问题优先」有机制判据，不悬在模型自觉上）
  const intensity = intensityOf(taskness)

  const seg = {
    perceive: settings.affectPerceive !== false ? perceiveText(tone, false) : '',
    affect: '',
    memory: '',
    identity: identityText({ selfName, ownerName, chat, agentIdentity: settings.agentIdentity !== false }),
  }

  // —— 情绪段：按强度与开关决定要不要 / 要不要半强度 ——
  const top = topOf(moodState)
  if (settings.affectThought !== false && top && intensity > 0) {
    const prof = profileOf(emotions || moodState?.emotionsItems || null, top.key)
    seg.affect = affectText(top, prof, false)
    if (intensity < 1) {
      // 半强度：只留「一句话结论」，且明说这条是正经事优先
      seg.affect = `（你此刻心里「${top.label}」，但这条是正经事，先把事说清楚，情绪只是措辞。${TAIL_RULE}）`
      degradation.push(`情感思想降为半强度（${taskness.why}）`)
    }
  } else if (settings.affectThought !== false && top && intensity === 0) {
    degradation.push(`情感思想本轮跳过（${taskness.why}）`)
  }
  const residuals = settings.emotionMemory !== false
    ? deriveResiduals(moodState, { now, limit: 5 }).filter((r) => (Number(r.at) || 0) > Number(clearedBefore || 0))
    : []
  if (settings.emotionMemory !== false && intensity > 0) {
    seg.memory = memoryText(residuals)
    if (intensity < 1 && seg.memory) {
      // 半强度：小史压到 1 条（最旧先丢，与降级顺序同向）
      seg.memory = memoryText(residuals.slice(-1))
      degradation.push('情绪记忆压到 1 条（任务性降强度）')
    }
  } else if (settings.emotionMemory !== false && intensity === 0) {
    degradation.push(`情绪记忆本轮跳过（${taskness.why}）`)
  }

  // —— 逐段预算（§2.5 分段键）：超了就按本段预算裁，标记可见 ——
  const perBudget = {
    identity: Number(settings.rtIdentityTokens),
    affect: Number(settings.rtAffectTokens),
    perceive: Number(settings.rtPerceiveTokens),
    memory: Number(settings.rtMemoryTokens),
  }
  // 每段是否被裁过（面板/预览显示用；被裁不等于残缺，但必须可见）
  const cutMap = {}
  // 自我意识每轮半段的「本段预算」只做可观测标注，绝不裁（§4.3 第④条：永不裁）。
  // 裁了它整系统就回到 v3——预算是观测工具，不是裁决者。
  if (seg.identity && Number.isFinite(perBudget.identity) && estimateTokens(seg.identity) > perBudget.identity) {
    degradation.push(`自我意识段超出本段预算 ${perBudget.identity} token：只标注不裁（永不裁）`)
  }
  for (const key of SEGMENT_ORDER) {
    const raw = seg[key]
    if (!raw) continue
    // 自我意识每轮半段：跳过裁剪（永不裁）
    if (key === 'identity') { order.push(key); continue }
    const limit = perBudget[key]
    if (!Number.isFinite(limit)) { order.push(key); continue }
    const cut = cutToTokens(raw, limit)
    if (cut !== raw) {
      seg[key] = cut
      cutMap[key] = true
      degradation.push(`${SEGMENT_LABELS[key]}裁到本段预算 ${limit} token`)
    }
    order.push(key)
  }

  // —— 总预算：机械执行降级顺序（①记忆 5→3→1→0 ②感知只留结论 ③思想只留 top1+强度词）——
  const maxTokens = Number.isFinite(Number(settings.rtMaxInjectTokens))
    ? Math.max(0, Math.floor(Number(settings.rtMaxInjectTokens)))
    : 600
  const tokensOf = () => SEGMENT_ORDER.reduce((sum, k) => sum + estimateTokens(seg[k]), 0)
  let overflow = false

  if (tokensOf() > maxTokens) {
    // ① 情绪记忆 5→3→1→0（最旧先丢）。只记录**真的发生了变化**的步骤，不无脑刷一串降级记录。
    const kept = Array.isArray(residuals) ? residuals.slice() : []
    const steps = [3, 1, 0]
    for (const n of steps) {
      if (tokensOf() <= maxTokens) break
      const next = n > 0 ? memoryText(kept.slice(-n)) : ''
      if (next === seg.memory) continue // 已经是这个形状了，别再记一遍
      seg.memory = next
      cutMap.memory = true
      degradation.push(n > 0 ? `情绪记忆降到 ${n} 条（总预算）` : '情绪记忆整段裁掉（总预算）')
    }
    // ② 情感感知只留判读结论
    if (tokensOf() > maxTokens && seg.perceive) {
      const concise = perceiveText(tone, true)
      if (concise !== seg.perceive) {
        seg.perceive = concise
        cutMap.perceive = true
        degradation.push('情感感知只留判读结论（总预算）')
      }
    }
    // ③ 情感思想只留 top1 + 强度词
    if (tokensOf() > maxTokens && seg.affect && top) {
      const prof = profileOf(emotions || moodState?.emotionsItems || null, top.key)
      const concise = affectText(top, prof, true)
      if (concise !== seg.affect) {
        seg.affect = concise
        cutMap.affect = true
        degradation.push('情感思想只留 top1 + 强度词（总预算）')
      }
    }
    // ④ 永不裁：自我意识每轮半段与人格锚三件。仍超 → 照原样保留并标 overflow(uncut)
    if (tokensOf() > maxTokens) {
      overflow = true
      degradation.push(`overflow(uncut)：裁完情绪段仍超 ${maxTokens} token，自我意识与人格锚永不裁，照原样保留`)
    }
  }

  const segments = SEGMENT_ORDER
    .filter((key) => seg[key])
    .map((key) => ({
      key,
      label: SEGMENT_LABELS[key],
      text: seg[key],
      tokens: estimateTokens(seg[key]),
      budget: perBudget[key],
      // 被裁过（分段预算或总降级）——面板可一眼看出「这轮哪段被压过」
      cut: Boolean(cutMap[key]),
      // 段内是否还带着句尾铁律（被 cutToTokens 截断的段落会丢句尾，这是可接受的降级面，
      // 但「情绪段不许提供话题」的边界靠模板本身，不靠这句尾巴）
      tailRule: String(seg[key]).includes(TAIL_RULE),
      // 稳定半段不进这里（走 rules 通道）；这里全是每轮变的
      stable: false,
      // 永不裁的两样：自我意识每轮半段 + 人格锚三件（人格锚在 system 侧，不在这里）
      uncut: key === 'identity',
    }))

  return {
    blocks: segments.map((s) => s.text),
    segments,
    order: segments.map((s) => s.key),
    totalTokens: segments.reduce((sum, s) => sum + s.tokens, 0),
    budget: maxTokens,
    overflow,
    overflowReason: overflow ? `overflow(uncut)：注入 ${tokensOf()} token > 预算 ${maxTokens} token` : '',
    degradation,
    tone,
    taskness,
    residuals,
  }
}

/**
 * 把注入结果拼成「追加到本轮消息尾部的块数组」（宿主的 prompt 钩子要的形状）。
 * @param {object} built buildInjection() 的返回
 * @returns {{type:'text', text:string}[]}
 */
export function toPromptBlocks(built) {
  return (built?.blocks || []).filter(Boolean).map((text) => ({ type: 'text', text }))
}
