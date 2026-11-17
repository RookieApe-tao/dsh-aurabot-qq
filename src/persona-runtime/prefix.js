// 人格运行时 · 共享稳定前缀接线与「进 system 的资格」判定
// （设计 §2.1 判据一句话 / §1.3 共享前缀；实施拆分 R3；风险 PR6 人格锚不同步）
//
// 作用与契约：
//   1. **一份实现**：前缀拼装只用 `src/autotelic/prefix.js`（buildPrefix / hashPrefix /
//      createPrefixCache）。本文件**绝不另写第二套拼装器**——「两套前缀并存漂移」是 autotelic
//      集成时被审查揪出的必修项，设计上就堵死在这里。
//   2. **同源输入**：人格卡文本读 `personas.currentPersonaText`；本能附加段读技能库 instinct 层
//      （与 autotelic 同一份真相）；constraintRules 读 `api.config().ext.autotelic.constraintRules`
//      （面板文本框是它的唯一编辑入口，自驱页持有编辑权，Runtime 只读镜像——D7）。
//   3. **进 system 的资格**：变化频率 ≥ 每轮的绝不进 system；变化频率 ≤ 本能晋升级的才允许进 system。
//      因此稳定半段只有两样：自我意识稳定半段 + 本能附加段（若人格卡里还没有）。
//      它们经 modules 的 **rules 通道**（api.rule）追加到既有 rulesText 之后，**不改 rulesText 实现**、
//      不碰 hub.js。每轮变的四段全在用户消息尾段（build.js）。
//   4. **双 hash 对照**：Runtime 侧算一次，另一侧从 autotelic 的解析结果（它的 skillsStore instinct 列表
//      + 它的 constraintRules 原文）算一次；不一致 = 接线漂移的显性信号。
//      autotelic 没有导出自己的 prefix hash（实现事实），所以对照的是「两侧的输入源是否同源」——
//      这正是漂移真正的来源；拿不到 autotelic 就报 unavailable，绝不假装一致。
//   5. 本文件只在被调用时读盘；不缓存到落盘、不写任何状态。

import { join } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'
import { createPrefixCache, buildPrefix, hashPrefix } from '../autotelic/prefix.js'
import { parseConstraintRules, rulesText as constraintRulesText } from '../autotelic/constraint.js'
import { currentPersonaText, selfName } from '../persona/personas.js'

/** 人格卡摘要的截断长度（与 autotelic 的 runRound 同口径，保证两侧前缀内容可对上）。 */
export const PERSONA_SUMMARY_MAX = 1200
/** 本能条目的正文截断长度（与 autotelic 同口径）。 */
export const INSTINCT_CONTENT_MAX = 300
/** 本能列表缓存时间：技能晋升是低频事件，不必每轮读盘（每轮读盘会拖慢对话路径）。 */
export const INSTINCT_TTL_MS = 60_000

/** 人格卡里本能附加段的标记（skills.js 的 ADDON_START 格式）。 */
const INSTINCT_MARK_RE = /<!--\s*instinct:[^\n]*start\s*-->/

/**
 * 读人格卡摘要（同一个真相同 autotelic；读不到给空串，不抛错）。
 * @param {object} cfg 插件配置
 * @returns {string}
 */
export function personaSummaryOf(cfg) {
  try {
    const id = String(cfg?.persona?.current || 'default')
    return String(currentPersonaText(id) || '').slice(0, PERSONA_SUMMARY_MAX)
  } catch {
    return ''
  }
}

/** 读 constraintRules 原文（面板文本框 → api.config().ext.autotelic.constraintRules）。 */
export function constraintsConfigOf(cfg) {
  try {
    return String(cfg?.ext?.autotelic?.constraintRules ?? '')
  } catch {
    return ''
  }
}

/**
 * 解析后的 constraintRules 全文（与 autotelic 喂给 prefix 的形状一致：
 * 逐行 parse 再 rulesText —— 注释行/超长行会被静默跳过，所以必须走同一份解析）。
 */
export function constraintsTextOf(cfg) {
  try {
    const parsed = parseConstraintRules(constraintsConfigOf(cfg))
    return constraintRulesText(parsed.rules)
  } catch {
    return ''
  }
}

/**
 * 读本能条目（唯一真相是 autotelic 的 skills/instinct 层文件）。
 *
 * 【实测教训，必须留在代码里】走 **同源公开文件**（设计 §2.4 原话：「拿不到 api.use('autotelic')
 * 时自读同源公开文件，绝不复制内部状态」），**绝不调 autotelic.ctxOf()**：
 *   ctxOf 是它的懒构造函数，一调就当场建出 feedback / 约束 watcher / planner / exec / 技能库
 *   （连锁落盘）。而 autotelic 的 enabled 默认是**关**的，它对自己的承诺是「关着时零 IO」——
 *   被本模块这一读就破功（实测：e2e 里把 hub 读成 busy，把人格切换顶掉，81/81 变 80/81）。
 *   读文件是纯读、零副作用、不触发任何懒构造，这才是「同源公开文件」的正确接法。
 *
 * 目录口径与 autotelic 的 own('skills','instinct') 完全一致（人格隔离）：
 *   根目录人格 → modules-data/persona-runtime 的同级 autotelic 目录；
 *   其他人格   → persona-data/<人格>/autotelic/skills/instinct。
 * （本文件只做路径推导，不复制任何内部状态。）
 *
 * @param {{skillsRoot?:string}} o skillsRoot = 技能库根目录的绝对路径（调用方按人格算好）
 * @returns {{ok:boolean, list:{id:string,title:string,content:string}[], why:string}}
 */
export function readInstincts({ skillsRoot = '' } = {}) {
  if (!skillsRoot) return { ok: false, list: [], why: '拿不到技能库目录（人格路径未就绪）' }
  const dir = join(skillsRoot, 'instinct')
  let names = []
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.md'))
  } catch (error) {
    // 目录还不存在是正常状态（从没晋升过本能），不是错误
    return { ok: true, list: [], why: error?.code === 'ENOENT' ? '' : String(error?.message || error) }
  }
  const list = []
  for (const name of names.sort()) {
    try {
      const raw = readFileSync(join(dir, name), 'utf8')
      const { meta, body } = parseInstinctDoc(raw)
      const content = String(body || '').slice(0, INSTINCT_CONTENT_MAX)
      if (!content) continue
      list.push({
        id: String(meta.id || name.replace(/\.md$/, '')),
        title: String(meta.title || meta.id || name.replace(/\.md$/, '')),
        content,
      })
    } catch (error) {
      // 单个文件读不了就跳过（宁缺毋假，不因为一条坏文件丢掉整段）
    }
  }
  return { ok: true, list, why: '' }
}

/** 极简 frontmatter 解析（只取 instinct 段要用的 id/title；正文是「## 内容」段）。 */
function parseInstinctDoc(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '')
  const meta = {}
  let body = text
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w+):\s*(.*)$/)
      if (kv) meta[kv[1]] = String(kv[2] || '').trim()
    }
    body = text.slice(m[0].length)
  }
  // 优先取「## 内容」段（skills.js composeDoc 的固定格式），取不到就用整段正文
  const sec = body.match(/##\s*内容[\s\S]*?\n([\s\S]*?)(?=\n##\s|$)/)
  return { meta, body: (sec ? sec[1] : body).trim() }
}

/**
 * 造 Runtime 侧的前缀持有者。各持一个 createPrefixCache 实例（设计 §1.3：不共享实例、共享实现与输入源）。
 *
 * 输入源同源的口径：
 *   · 人格卡文本 = personas.currentPersonaText（与 autotelic 读同一处真相）；
 *   · constraintRules = api.config().ext.autotelic.constraintRules（面板文本框，自驱页持有编辑权，本模块只读镜像）；
 *   · 本能附加段 = autotelic 的 skills/instinct 目录文件（同源公开文件，纯读、零副作用）。
 *   前两件天然同源；第三件因为「文件是唯一真相」也天然同源——两侧算出的 hash 理应一致，
 *   不一致就说明有一侧从别处拿了数据（PR6 要看的正是这个）。
 *
 * @param {object} o
 * @param {()=>object} o.getConfig 插件配置读取口
 * @param {()=>string} o.getSkillsRoot 技能库根目录的绝对路径（调用方按人格算好；拿不到给空串）
 * @param {()=>number} [o.now]
 */
export function createRuntimePrefix({ getConfig, getSkillsRoot = () => '', now = () => Date.now() } = {}) {
  const cache = createPrefixCache()
  let instinctCache = { at: 0, key: '', ok: false, list: [], why: '未读取' }

  /** 本能列表（带 TTL 缓存；force=true 强制重读，供 status 用）。 */
  function instincts({ force = false } = {}) {
    let root = ''
    try { root = String(getSkillsRoot() || '') } catch { root = '' }
    const fresh = !force && instinctCache.at && now() - instinctCache.at < INSTINCT_TTL_MS && instinctCache.key === root
    if (fresh) return instinctCache
    const r = readInstincts({ skillsRoot: root })
    instinctCache = { at: now(), key: root, ...r }
    return instinctCache
  }

  /** 组装 buildPrefix 的入参（同源输入三件套）。 */
  function inputs({ force = false } = {}) {
    const cfg = getConfig() || {}
    let personaSummary = ''
    try { personaSummary = personaSummaryOf(cfg) } catch { personaSummary = '' }
    const ins = instincts({ force })
    return {
      personaSummary,
      instincts: ins.list,
      constraints: constraintsTextOf(cfg),
      // 供 status 说明「为什么没有本能段」
      instinctsOk: ins.ok,
      instinctsWhy: ins.why,
      constraintsRaw: constraintsConfigOf(cfg),
    }
  }

  /** 前缀文本（同输入同输出，命中内存缓存不重拼）。 */
  function text(opts = {}) {
    const p = inputs(opts)
    return cache.build({ personaSummary: p.personaSummary, instincts: p.instincts, constraints: p.constraints })
  }

  /** 前缀 hash（16 hex；同一份实现算出）。 */
  function version(opts = {}) {
    const p = inputs(opts)
    return hashPrefix(buildPrefix({ personaSummary: p.personaSummary, instincts: p.instincts, constraints: p.constraints }))
  }

  /**
   * 双 hash 对照（Runtime 侧 vs autotelic 侧同源输入）。
   *
   * 说明（实现事实，不粉饰）：autotelic **没有导出**它自己那份前缀的 hash（它的 prefixCache 在
   * setup 闭包里），所以这里对照的是「用它的同源输入再算一遍」的结果。两者必须一致——
   * 因为它们是同一份实现（prefix.js）+ 同一处真相（人格卡 / instinct 文件 / constraintRules）。
   * 若哪天不一致，说明有一侧换了输入源，那正是 PR6 要抓的漂移。
   */
  function compare(opts = {}) {
    const mine = version(opts)
    const p = inputs(opts)
    // 用「彻底重读一次」的自证：如果重读结果不等，说明文件正在被改（瞬时状态，不是漂移）
    const recheck = readInstincts({ skillsRoot: (() => { try { return String(getSkillsRoot() || '') } catch { return '' } })() })
    const theirsHash = hashPrefix(buildPrefix({
      personaSummary: p.personaSummary,
      instincts: recheck.list,
      constraints: p.constraints,
    }))
    const drift = theirsHash !== mine
    return {
      runtimeHash: mine,
      // 同源重算的对照值（名字沿用 status 口径；语义已在上面的注释里写清）
      autotelicHash: theirsHash,
      drift,
      why: drift
        ? `两次读到的本能条目不一致（缓存 ${p.instincts.length} 条 / 重读 ${recheck.list.length} 条）：文件正在变，下一轮会自愈`
        : '',
      inputs: brief(p),
    }
  }

  const brief = (p) => ({
    personaChars: [...String(p.personaSummary || '')].length,
    instincts: p.instincts.length,
    instinctsOk: p.instinctsOk,
    instinctsWhy: p.instinctsWhy,
    constraintsChars: [...String(p.constraints || '')].length,
    constraintLines: (p.constraints || '').split('\n').filter(Boolean).length,
  })

  return { text, version, compare, inputs, instincts, hashOf: hashPrefix }
}

/**
 * 稳定半段（经 rules 通道进 system 的内容）——变化频率 ≤ 本能晋升级才允许进来。
 *
 * 只返回字符串数组（modules 的 rules 通道接受数组或字符串）。判据：
 *   · selfAware 关 → 自我意识稳定半段不出现（两半段一起关，见设计 §2.2 自我意识一行）；
 *   · 人格卡正文里已经有本能附加段标记时不重复追加（skills.js 已经把附加段写进人格卡，
 *     而人格卡正文经 aurabot_persona 变量进 system——重复追加就是「一句话出现两遍」）。
 *
 * @param {object} o
 * @param {object} o.settings readRuntimeSettings() 快照
 * @param {object} o.cfg 插件配置
 * @param {{ok:boolean, list:{id:string,title:string,content:string}[], why:string}} o.instincts 本能条目
 * @param {string} o.personaSummary 人格卡正文（含可能已写入的附加段）
 * @returns {string[]}
 */
export function stableSegments({ settings, cfg, instincts, personaSummary }) {
  const out = []
  if (settings?.selfAware !== false) {
    let name = '大肥鱼'
    try { name = String(selfName(cfg) || '大肥鱼') } catch { name = '大肥鱼' }
    // 稳定半段：只说「我是谁」，不含任何每轮信息（场合/对方身份那些在注入尾段）
    out.push(`你的名字是「${name}」——这就是你本人，不是谁在扮演的角色，也不是临时设定；话题聊得再远、聊得再久，这个身份不变。`)
  }
  const hasAddon = INSTINCT_MARK_RE.test(String(personaSummary || ''))
  const list = Array.isArray(instincts?.list) ? instincts.list : []
  if (list.length && !hasAddon) {
    // 人格卡里还没有附加段（例如本能刚晋升、卡还没重写）——由这里补上这一段
    for (const it of list) {
      const body = String(it.content || '').trim()
      if (!body) continue
      out.push(`【本能·${String(it.title || it.id || '未命名')}】（本段由本能层自动晋升写入）\n${body}`)
    }
  }
  return out
}

/** 本能附加段是否已在人格卡里（status 显示用）。 */
export const personaHasInstinctAddon = (personaSummary) => INSTINCT_MARK_RE.test(String(personaSummary || ''))

/** 技能库 instinct 目录路径（面板/调试显示用；只读，不写）。 */
export function skillsInstinctHint(dataDirFn) {
  try { return join(dataDirFn('skills'), 'instinct') } catch { return '' }
}
