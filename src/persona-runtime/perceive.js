// 人格运行时 · 情感感知（对方语气零模型判读）与「正经问题优先」的任务性启发式
// （设计 §1.3 防线 1 / §2.2 情感感知 / 审查 4 的机制判据；实施拆分 R2/R4）
//
// 作用：一句话判读「对方此刻是什么语气、回的时候注意什么」，以及判「这句话是不是正经活儿」——
//      后者决定本轮情绪段要不要降强度（任务动词/求助句式/长指令 → 情绪段减半或跳过），
//      让「正经问题优先」有机制判据，而不是悬在模型自觉上。
//
// 契约：
//   · 纯函数、零 IO、零模型调用（不花 token、不打网络），可单测可复算。
//   · 判不准就少说：confidence 低时调用方不出手（不出手是合法状态，不是失败）。
//   · 傲娇/亲昵白名单优先于负面词表（「讨厌~」「笨蛋」「哼」判成轻松互动）——口径继承
//     mood.judge 的 system 提示词（2026-11-17 合并时已验证），负面判读绝不反向污染。

import { clipText } from './text.js'

/** 傲娇 / 亲昵 / 玩笑白名单：命中即按轻松互动，且优先级高于一切负面词（PR1 语气误判螺旋防线）。 */
const PLAYFUL_RES = [
  /讨厌[~～啦嘛]?/,
  /笨蛋|坏蛋|傻[瓜蛋子]|大猪蹄子/,
  /^哼+|哼[~～]?$/,
  /[哈呵嘿]{2,}/, // 哈哈哈 / 呵呵 / 嘿嘿
  /欺负|逗你|骗你的/,
  /摸摸|抱抱|贴贴|亲亲|捏捏/,
]

/** 抱怨 / 委屈：先共情、别急着讲道理。 */
const UPSET_RES = [
  /难受|难过|伤心|委屈|烦死|烦人|讨厌死了|好烦|心累|累死|太累|好累|很累|累啊|撑不住|崩溃|疲惫|没力气/,
  /吵架|生气|气了|火大|无语|服了|离谱/,
  /哭了|想哭|呜呜|嘤嘤/,
]

/** 撒娇 / 求安慰：接住情绪，不要字面处理（注意「陪我聊两句」这类不算撒娇，别抢 upset 的判读）。 */
const COQUETTISH_RES = [/撒娇|人家|哄我|要抱|不想动|求求|拜托啦|陪我玩/]

/** 求助 / 托付：正经活儿，情绪段要降强度。 */
const ASK_FOR_HELP_RES = [
  /帮我|帮忙|替我|麻烦你|你能(?:不能)?(?:帮我)?|请(?:你)?帮/,
  /把.{1,20}(?:弄|改|搬|挪|删|建|装|写|发|存|查|跑|重启|关掉|打开)/,
  /(?:怎么|如何|为什么|是不是|能不能|可不可以).{0,40}[？?]/,
]

/** 任务动词：出现即视为「这条消息里有活儿」。 */
const TASK_VERB_RE = /(?:修改|改掉|改成|写成|导出|导入|安装|卸载|部署|编译|构建|运行|执行|修复|排查|检查|测试|配置|同步|备份|恢复|迁移|上传|下载|整理|归纳|复制|粘贴|移动|重命名|删除|清空|统计|汇总|列出|生成|抓取|爬取|解析|转换|格式化)/

/** 情绪词（含傲娇白名单里被排除后的残余判断用）。 */
const EMOTION_WORD_RE = /(?:开心|高兴|兴奋|期待|激动|喜欢|爱你|想你|太好了|棒|绝了|笑死|尴尬|紧张|焦虑|担心|害怕|难受|无聊|寂寞|孤独)/

/**
 * 语气判读（零模型）。
 * @param {string} text 对方这一轮说的话（来自 prompt 钩子的用户正文，可为纯消息段之外的拼接文本）
 * @returns {{tone:string, label:string, confidence:number, advice:string, keys:string[]}}
 *   tone ∈ playful/upset/coquettish/asking/neutral；confidence 0~1；advice 是给她的回应提示。
 */
export function perceiveTone(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  const empty = { tone: 'neutral', label: '平常', confidence: 0, advice: '', keys: [] }
  if (!s) return empty
  const hit = (res) => (Array.isArray(res) ? res : [res]).filter((re) => re.test(s)).length
  const playful = hit(PLAYFUL_RES)
  // 白名单优先：出现玩笑/亲昵标记时，负面词一律不作数（口径继承 mood.judge）
  if (playful > 0) {
    return {
      tone: 'playful',
      label: '轻松玩笑',
      confidence: Math.min(0.85, 0.55 + playful * 0.1),
      advice: '按轻松互动接，别较真、别道歉过度',
      keys: ['playful'],
    }
  }
  const upset = hit(UPSET_RES)
  const coq = hit(COQUETTISH_RES)
  const ask = hit(ASK_FOR_HELP_RES)
  const emotion = hit(EMOTION_WORD_RE)
  // 抱怨优先于撒娇：委屈的人在讲道理之前需要先被听见
  if (upset > 0) {
    return {
      tone: 'upset',
      label: '有点不开心',
      confidence: Math.min(0.85, 0.5 + upset * 0.15),
      advice: '先接住情绪再谈事，别急着分析对错',
      keys: ['upset'],
    }
  }
  if (coq > 0) {
    return {
      tone: 'coquettish',
      label: '在撒娇',
      confidence: Math.min(0.8, 0.45 + coq * 0.15),
      advice: '顺着软一点接，不要字面处理',
      keys: ['coquettish'],
    }
  }
  if (ask > 0) {
    return {
      tone: 'asking',
      label: '在求助/问事',
      confidence: Math.min(0.85, 0.5 + ask * 0.12),
      advice: '这条是正经事，先把事说清楚',
      keys: ['asking'],
    }
  }
  if (emotion > 0) {
    return {
      tone: 'playful',
      label: '情绪外露',
      confidence: 0.45,
      advice: '顺着语气的热度接',
      keys: ['emotion'],
    }
  }
  return { ...empty, confidence: 0.2 }
}

/** 任务性等级：none（正常情绪强度）/ half（情绪段减半）/ skip（本轮跳过情绪段）。 */
export const TASK_LEVELS = Object.freeze(['none', 'half', 'skip'])

/**
 * 「这条是不是正经活儿」的零成本启发式（审查 4：任务动词 / 求助句式 / 长指令三档）。
 * @param {string} text 对方这一轮说的话
 * @returns {{level:'none'|'half'|'skip', why:string, signals:string[]}}
 */
export function tasknessOf(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  const signals = []
  if (!s) return { level: 'none', why: '空消息', signals }
  const chars = [...s].length
  const verbs = (s.match(new RegExp(TASK_VERB_RE.source, 'g')) || []).length
  const ask = ASK_FOR_HELP_RES.some((re) => re.test(s))
  const numbered = /(?:^|\n)\s*(?:\d+[.、)]|[①②③④⑤⑥⑦⑧⑨⑩])/.test(s) // 编号清单 = 长指令
  const hasPath = /[A-Za-z]:[\\/]|\/[\w.-]+\/|\\\\[\w.$-]+\\/.test(s) // 本地路径 = 让我动本机文件
  if (verbs) signals.push(`任务动词×${verbs}`)
  if (ask) signals.push('求助句式')
  if (numbered) signals.push('编号指令')
  if (chars >= 80) signals.push(`长指令(${chars}字)`)
  if (hasPath) signals.push('本机路径')

  // 跳过：明确的活儿 + 不短 —— 这种轮次她该像同事不像恋人
  if ((verbs >= 2 || (verbs >= 1 && ask) || (numbered && chars >= 40) || (hasPath && ask)) && chars >= 16) {
    return { level: 'skip', why: `正经活儿（${signals.join('/')}），本轮情绪段跳过`, signals }
  }
  // 减半：有活儿或很长的指令
  if (verbs >= 1 || ask || chars >= 80) {
    return { level: 'half', why: `偏任务（${signals.join('/') || '较长'}），情绪段减半`, signals }
  }
  return { level: 'none', why: '日常闲聊', signals }
}

/**
 * 从 prompt 钩子的 content 块数组里取「对方这一轮真正说的话」。
 *
 * 这一步是本模块最容易踩的坑：宿主会在同一轮里拼进大量**脚手架文本**——
 *   【发言身份】…（身份提示）、【当前本机时间】…、【这个聊天刚才发生的事】…、
 *   【你之前在这个聊天里主动说过】…、【同一人格、同一聊天的对话资料】…、【私聊】某某(账号)：…
 * 拿整段拼接文本去判读 / 判 duty，会把「不能把别人被问到的作品…认成自己的」这种规则句
 * 误判成「主人在委托我干活」（实测踩过：duty 误命中后真的开了一轮工作台）。
 *
 * 取法（保守优先）：
 *   1) 优先取带【私聊】/【群聊 …】前缀的块——那是宿主标注的真实用户消息格式；
 *   2) 找不到就退回最后一个块，但逐行剔掉以【】开头、以 - 开头的脚手架行；
 *   3) 仍为空 → 返回空串（判读层见到空串就什么都不做，这是合法状态）。
 *
 * @param {Array<{type?:string,text?:string}>|string} content
 * @returns {string}
 */
export function incomingTextOf(content) {
  if (typeof content === 'string') return clipText(content, 600, '')
  if (!Array.isArray(content)) return ''
  const texts = []
  for (const block of content) {
    if (!block || block.type !== 'text') continue
    const t = String(block.text ?? '')
    if (t) texts.push(t)
  }
  if (!texts.length) return ''
  // 1) 宿主标注的真实用户消息（【私聊】/【群聊 群名】开头）
  const userBlocks = texts.filter((t) => /^【(?:私聊|群聊)[^\n]*】/.test(t.trim()))
  const pick = userBlocks.length ? userBlocks[userBlocks.length - 1] : texts[texts.length - 1]
  // 2) 逐行剔脚手架（【】包头 / 「- 」开头的规则清单行）
  const cleaned = pick
    .split(/\r?\n/)
    .filter((line) => {
      const s = line.trim()
      if (!s) return false
      if (/^【[^\n]*】/.test(s)) {
        // 【私聊】/【群聊 …】这一行本身带正文，保留（去掉包头前缀）；其余【xxx】脚手架整行丢
        return /^【(?:私聊|群聊)/.test(s)
      }
      if (/^[-•]\s/.test(s)) return false
      return true
    })
    .join('\n')
    // 去掉【私聊】某某(账号)：这类前缀，只留正文（判读与 duty 都只该看正文）
    .replace(/^【(?:私聊|群聊[^】]*)】[^：:\n]{0,40}[：:]\s*/g, '')
    .trim()
  return clipText(cleaned, 600, '')
}

/**
 * 语气校准识别（审查 6：校准经验经观察层 note 来源流入引擎沉淀链，**禁止另开直写 skills/memory 的口子**）。
 *
 * 为什么要单独一条：autotelic 的 chatCollector 只识别「行为纠偏」（别做X / 别再X，进抑制表），
 * 认不出「语气纠偏」——而语气误判正是本模块头号风险（PR1）。所以这里只挑**语气类**纠正，
 * 与引擎的行为纠偏互补、不重复刷同一条观察（同一句话两边各写一条会污染观察层）。
 *
 * @param {string} text 对方这一轮说的话
 * @returns {{hit:boolean, phrase:string}} 命中时 phrase = 纠正原话片段
 */
export function detectToneCalibration(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return { hit: false, phrase: '' }
  const RES = [
    // 「别这么小心翼翼」「说话别那么冲」「语气太硬了」「你可以随意一点」
    /(?:别|不要|不用)(?:这么|那么|太)?(?:小心翼翼|客气|生分|疏远|冷淡|生硬|凶|冲|严肃|拘谨|见外)/,
    /(?:语气|说话|口气|口吻)(?:太|有点|别|不要)(?:硬|冲|凶|冷|客气|生分|拘谨|严肃|软|黏)/,
    /(?:可以|你)(?:再)?(?:随意|自然|放开|亲昵|黏|撒娇|凶|硬)(?:一点|点儿|些)/,
    /(?:别|不要)(?:再)?(?:跟我)?(?:客气|见外|端着)/,
    /你(?:刚才|刚刚|上一句)?(?:怎么|为什么)(?:那么|这么)(?:说|回|凶|冷)/,
  ]
  for (const re of RES) {
    const m = re.exec(s)
    if (m) return { hit: true, phrase: clipText(m[0], 40, '') }
  }
  return { hit: false, phrase: '' }
}
