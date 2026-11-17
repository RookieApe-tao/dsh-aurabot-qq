// 内置模块：每轮回复人格运行时（persona-runtime）。
//
// 地位：**她的每条消息里「她是谁」由这里决定**——自我指向、情感倾向、语气、情绪残余。
//      与自驱引擎 v5（对话外生活）并列，共享本能层人格锚（prefix.js 同一份实现）。
//      唯一权威设计：docs/design/persona-runtime/00-design.md（本文所有「§x.y」都指它）。
//
// 职责（R1~R8）：
//   R1 模块壳 + settings 面（爆式总开关 + 九开关 + rt* 预算键，读取 fail-closed）
//   R2 四段注入：api.on('prompt') 把「情感感知 → 情感思想 → 情绪记忆 → 自我意识每轮半段」
//      追加到本轮用户消息尾部（固定顺序，离生成最近权重最高）；任务性启发式降强度
//   R3 共享前缀：只用 autotelic/prefix.js 一份实现 + 同源输入 + 稳定半段经 rules 通道进 system
//   R4 情绪三件事：mood 只读 + 残余小史现场派生（不落盘）+ 正经问题优先
//   R5 观察桥推送制：显著波动 → autotelic.observe.append(source:'emotion')；语气校准走 source:'note'
//   R6 ignite 转发：重要对话结束 → autotelic.schedule.ignite（Runtime 不判断值不值得想）
//   R7 duty 行动申报：主人委托 → 编译 kind:'duty' 行动票 → autotelic.exec.run 同一入口
//   R8 超管/宿主接管：只管申报级别上限与排队，硬禁区优先；每次行使写审计
//
// 边界铁线（§0.3，钉死）：
//   · 不建引擎→Runtime 的反向语气注入通道（观察桥只出不进）；主动发言语气归引擎自己的分享环节。
//   · Runtime 不立项。唯一例外是 duty 行动申报，且必须喂 exec.run 同一入口（不持有第二套行动载体）。
//   · 情绪唯一真相是 mood（唯一写入口）；前缀唯一实现是 prefix.js；行动唯一通道是 exec.run。
//   · 本模块不复制任何真相：dataDir 只留 runtime.json（开关最近生效快照），残余小史不落盘。
//
// 管线触点只有一处：api.on('prompt')。没有定时器（api.every）——全部事件驱动。
//
// 存储：modules-data/persona-runtime/runtime.json（仅开关快照 + 最近一次注入摘要，审计用）。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { personaDataDir, personaNow, selfName } from '../../persona/personas.js'

import {
  readRuntimeSettings, SWITCH_LABELS, SWITCH_KEYS, BUDGET_KEYS, DEFAULT_BUDGETS, BUDGET_RANGES,
} from '../../persona-runtime/settings.js'
import { buildInjection, toPromptBlocks, SEGMENT_LABELS } from '../../persona-runtime/build.js'
import { estimateTokens } from '../../persona-runtime/text.js'
import {
  readMoodState, topOf, deriveResiduals, summarizeResiduals, detectShift, shiftText, shiftSalience,
} from '../../persona-runtime/emotions.js'
import { perceiveTone, tasknessOf, incomingTextOf, detectToneCalibration } from '../../persona-runtime/perceive.js'
import {
  createRuntimePrefix, stableSegments, personaSummaryOf, personaHasInstinctAddon, PERSONA_SUMMARY_MAX,
} from '../../persona-runtime/prefix.js'
import {
  createObservationBridge, createIgniter, shouldIgniteAfterTurn, tagForEmotion,
} from '../../persona-runtime/bridge.js'
import { compileDutyTicket, detectDuty, detectHazards, isDutyTicket } from '../../persona-runtime/duty.js'
import { yieldMoodLine } from '../../persona-runtime/mood-yield.js'

/** 人格卡正文缓存时间：rules 通道每次算系统提示词变量都会调，别每次都读盘。 */
const PERSONA_TTL_MS = 15_000

export default {
  id: 'persona-runtime',
  name: '人格运行时',
  version: '1.0.0',
  api: 2,
  platforms: ['*'],
  description: '每轮回复层的人格：自我指向 / 情感倾向 / 语气 / 情绪残余。九开关分段可关，全关等于「安静日的她」（人格卡基线 + mood 旧口径）。情绪只读 mood、前缀只走 prefix.js、行动只走 exec.run——本模块不复制任何真相。',
  files: [
    'persona-runtime/settings.js',
    'persona-runtime/text.js',
    'persona-runtime/perceive.js',
    'persona-runtime/emotions.js',
    'persona-runtime/build.js',
    'persona-runtime/prefix.js',
    'persona-runtime/bridge.js',
    'persona-runtime/duty.js',
    'persona-runtime/mood-yield.js',
  ],
  // 独立标签页「人格运行时」（与自驱引擎页分开两页，D7 已定）。
  tab: 'persona-runtime',
  defaults: {
    // —— 爆式总开关（Runtime 自留）：关掉整个 Runtime 层，≠插件总开关 ——
    enabled: true,
    // —— 九开关（4 保留 + 2 收编 + 2 自留 + 1 改造，归属继承 v5 §9.2，不重排）——
    selfAware: true,      // 自我意识
    agentIdentity: true,  // 独立智能体身份（群聊以自己的名字与身份应答）
    affectThought: true,  // 情感思想
    affectPerceive: true, // 情感感知
    emotionMemory: true,  // 情绪记忆
    adminMode: false,     // 超级管理员：管申报级别上限（不是语气层开关）
    hostTakeover: false,  // 宿主接管：申报一律排队（不进 autoConfirmOwner 豁免）
    activeThinking: false, // 主动思考 = ignite 事件转发（物理不存在静默期推演）
    // —— rt* 注入预算（键族与 autotelic 的 chat*/intent*/gate*/review* 严格分家）——
    rtMaxInjectTokens: DEFAULT_BUDGETS.rtMaxInjectTokens,
    rtIdentityTokens: DEFAULT_BUDGETS.rtIdentityTokens,
    rtAffectTokens: DEFAULT_BUDGETS.rtAffectTokens,
    rtPerceiveTokens: DEFAULT_BUDGETS.rtPerceiveTokens,
    rtMemoryTokens: DEFAULT_BUDGETS.rtMemoryTokens,
  },
  settings: SWITCH_LABELS.map((row) => {
    // 预算键走 number 行（带面板边界），开关走 switch 行；面板按此声明式生成，不改面板代码
    if (BUDGET_KEYS.includes(row.key)) {
      const r = BUDGET_RANGES[row.key]
      return { key: row.key, label: row.label, type: 'number', min: r.min, max: r.max, hint: row.hint || '' }
    }
    return { key: row.key, label: row.label, type: 'switch', hint: row.hint || '' }
  }),

  setup(api) {
    const log = api.log
    // ---------- 配置（fail-closed；每次读新值，面板改完立刻生效） ----------
    const settings = () => readRuntimeSettings(api)

    // ---------- 审计（照 autotelic/index.js 的 note 写法：走宿主注入的 autotelic 审计通道） ----------
    const auditWired = () => Boolean(api.core?.autotelicAuditOn)
    const note = (entry) => {
      try { api.core?.autotelicAudit?.note?.(entry) } catch (error) { log?.debug?.('人格运行时：审计写入失败：', error?.message) }
    }

    // ---------- 跨模块导出面（互不 import 内部函数，全走 api.use） ----------
    const autotelicOf = () => {
      try { return api.use('autotelic') || null } catch { return null }
    }
    const moodOf = () => {
      try { return api.use('mood') || null } catch { return null }
    }
    /** 情绪真相（mood.state() 纯读不落盘；mood 没跑就是 null，绝不兜造一份）。 */
    const moodState = () => readMoodState(moodOf())

    // ---------- R3 共享前缀（prefix.js 同一份实现 + 同源输入） ----------
    // 本能附加段的输入源 = autotelic 的技能库目录（同源公开文件；纯读零副作用）。
    // 目录口径与 autotelic 的 own('skills') 完全一致（人格隔离）：
    //   根目录人格 → modules-data/autotelic/skills（与 persona-runtime 同级）
    //   其他人格   → persona-data/<人格>/autotelic/skills
    // 【实测教训】这里刻意**不调 api.use('autotelic').ctxOf()**：那是它的懒构造函数，
    // 一调就当场建出它的重件并落盘，而它的 enabled 默认关、承诺「关着时零 IO」——
    // 被我们破功会实测把宿主 hub 读成 busy（e2e 里人格切换被顶掉）。读文件才是「同源公开文件」。
    const skillsRoot = () => {
      try {
        const cfg = api.config()
        const id = String(personaNow(cfg) || '')
        const root = personaDataDir(cfg, id)
        return join(root, 'autotelic', 'skills')
      } catch {
        return ''
      }
    }
    const prefix = createRuntimePrefix({ getConfig: () => api.config(), getSkillsRoot: skillsRoot })

    // 人格卡正文短缓存（rules 通道会被每次算系统提示词变量时调用，别每次都读盘）
    let personaCache = { at: 0, text: '' }
    const personaText = (force = false) => {
      const t = Date.now()
      if (!force && personaCache.at && t - personaCache.at < PERSONA_TTL_MS) return personaCache.text
      personaCache = { at: t, text: personaSummaryOf(api.config()) }
      return personaCache.text
    }

    // ---------- R5 观察桥 + R6 ignite 转发（都是单向出口） ----------
    const bridge = createObservationBridge({ getAutotelic: autotelicOf, log })
    const igniter = createIgniter({ getAutotelic: autotelicOf, log })

    // ---------- 运行时内存态（一律不落盘；落盘的只有开关快照） ----------
    // 情绪波动差分：只放内存——Runtime 不设第二个写入口、不落盘（§2.3 / 审查 5）
    let lastShift = null
    // 残余小史的「清展示」游标：清的是派生展示，**不动 mood 向量**（§2.3：清残余 route 只清展示）
    let clearedAt = 0
    // 最近一轮注入摘要（status 的「最近注入 preview」；只在内存，重启即空）
    let lastInjection = null
    // duty 申报的最近一次结果（status 用）
    let lastDuty = null
    // 最近写入 runtime.json 的开关快照（内存比对：只有变化时才写盘，避免每轮 IO）
    let writtenSnapshot = ''

    /** runtime.json 路径（api.dataDir 已带 modules-data/persona-runtime 前缀，坑#1 别再叠）。 */
    const runtimeFile = () => api.dataDir('runtime.json')

    /** 开关快照落盘（仅在快照变化时写：高频路径不写盘）。 */
    function persistSnapshot(s) {
      const snap = {
        at: Date.now(),
        switches: Object.fromEntries(SWITCH_KEYS.map((k) => [k, s[k]])),
        budgets: Object.fromEntries(BUDGET_KEYS.map((k) => [k, s[k]])),
        // 审计用：最近一次注入的各段占用（不可观测的预算等于没有预算）
        lastInjection: lastInjection
          ? { at: lastInjection.at, totalTokens: lastInjection.totalTokens, budget: lastInjection.budget, overflow: lastInjection.overflow, segments: lastInjection.segments.map((x) => `${x.key}:${x.tokens}`) }
          : null,
      }
      const key = JSON.stringify(snap.switches) + JSON.stringify(snap.budgets)
      if (key === writtenSnapshot) return
      writtenSnapshot = key
      try {
        const file = runtimeFile()
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(snap, null, 2), 'utf8')
      } catch (error) {
        log?.debug?.('人格运行时：开关快照写盘失败（不影响注入）：', error?.message)
      }
    }

    /** 读回开关快照（status 展示「最近生效快照」；读不到返回 null）。 */
    function readSnapshot() {
      try { return JSON.parse(readFileSync(runtimeFile(), 'utf8')) } catch { return null }
    }

    // ---------- 注入装配（注入函数与 preview 路由共用同一份 = 真·零副作用试拼） ----------
    /**
     * 拼这一轮的注入。
     * @param {object} o
     * @param {object} o.chat 宿主会话 { kind, chatId }
     * @param {string} o.incoming 对方这一轮说的话
     * @param {boolean} [o.record] 是否记下「最近注入」（preview 不记）
     */
    function build({ chat, incoming, record = false }) {
      const s = settings()
      // 情绪只读：emotionMemory 关掉时连 mood.state() 都不必读（但波动检测仍在外面单独读一次）
      const mood = moodState()
      const built = buildInjection({
        settings: s,
        moodState: mood,
        incoming,
        chat,
        selfName: safeSelfName(),
        ownerName: ownerName(),
        emotions: mood?.emotionsItems || null,
        // 清残余只清展示：早于游标的派生条目不再注入（mood 向量原样不动）
        clearedBefore: clearedAt,
      })
      if (record) recordInjection(built)
      return built
    }

    /** 最近注入摘要（只留可审计的骨架，不留全文——内存占用小、面板够用）。 */
    function recordInjection(built) {
      lastInjection = {
        at: Date.now(),
        totalTokens: built.totalTokens,
        budget: built.budget,
        overflow: built.overflow,
        overflowReason: built.overflowReason,
        degradation: built.degradation,
        order: built.order,
        segments: built.segments.map((x) => ({ key: x.key, label: x.label, tokens: x.tokens, budget: x.budget })),
        preview: built.blocks.join('').slice(0, 600),
        tone: built.tone?.label || '',
        taskness: built.taskness?.level || 'none',
      }
    }

    function safeSelfName() {
      try { return String(selfName(api.config()) || '大肥鱼') } catch { return '大肥鱼' }
    }
    function ownerName() {
      try { return String(api.config()?.ownerName || '主人') } catch { return '主人' }
    }

    // ---------- R4/R5 情绪三件事：读（每次注入顺手读）→ 转发（显著波动推送观察） ----------
    /**
     * 波动检测与推送（只挂对话轮——事件型波动漏检是已接受的局限，见设计 §2.3 末段）。
     * @param {object|null} state 本轮读到的 mood.state()
     */
    function noteEmotionShift(state) {
      if (!state) return
      const cur = {
        topKey: topOf(state)?.key || '',
        value: Number(state.value) || 0,
      }
      if (lastShift) {
        const shift = detectShift(lastShift, state)
        if (shift && shift.changed && settings().emotionMemory !== false) {
          const text = shiftText(shift)
          if (text) {
            const r = bridge.pushEmotion({ shift, text: `这轮对话里${text}`, salience: shiftSalience(shift) })
            if (r.ok) {
              note({
                kind: 'persona-runtime/emotion-observe',
                args: { tag: tagForEmotion(shift.topKey, shift.label), delta: shift.valueDelta, topChanged: shift.topChanged },
                outcome: '情绪波动已推入观察层（情绪也是经历）',
              })
            }
          }
        }
      }
      lastShift = cur
    }

    /**
     * 语气校准经验 → 观察层 source:'note'（审查 6：走同一通道，禁止另开直写 skills/memory 的口子）。
     * 只记「语气类」纠正（行为纠偏归 autotelic 的 chatCollector，两边不重复刷同一条观察）。
     */
    function noteCalibration(incoming, toneLabel) {
      try {
        const cal = detectToneCalibration(incoming)
        if (!cal.hit) return
        const r = bridge.pushCalibration({ text: cal.phrase || incoming, tone: toneLabel, tag: '牵挂' })
        if (r.ok) {
          note({
            kind: 'persona-runtime/tone-calibration',
            args: { phrase: cal.phrase, tone: toneLabel },
            outcome: '语气校准经验已推入观察层（沉淀链归引擎）',
          })
        }
      } catch (error) {
        log?.debug?.('人格运行时：语气校准识别出错：', error?.message)
      }
    }

    // ---------- R7 duty 行动申报（唯一例外；编译后喂 exec.run 同一入口） ----------
    /** 读 autotelic 的行动预算（不复制它的默认值：从它的 settings 读，读不到用保守值）。 */
    function autotelicBudget() {
      try {
        const ext = api.config()?.ext?.autotelic || {}
        const maxSteps = Number(ext.maxSteps)
        const timeoutMs = Number(ext.scriptTimeoutMs)
        return {
          maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? Math.min(maxSteps, 8) : 4,
          timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000,
        }
      } catch {
        return { maxSteps: 4, timeoutMs: 120_000 }
      }
    }

    /**
     * 编译并申报一次 duty。返回一份可读结果（话术直接用 message）。
     * 申报级别上限：adminMode 开 → 主机级放开；关 → 主机级回复层软拒。
     * 宿主接管：一律排队（把所有步标 touch-owner），**绝不**去动 autoConfirmOwner。
     */
    async function declareDuty({ text, chat = null } = {}) {
      const s = settings()
      const budget = autotelicBudget()
      const compiled = compileDutyTicket({
        text,
        chat,
        settings: s,
        tag: '牵挂',
        maxSteps: budget.maxSteps,
        timeoutMs: budget.timeoutMs,
      })
      // 不是委托意图：静默返回（日常闲聊不写审计，避免噪音）
      if (!compiled.ticket && !compiled.refuse) {
        return { ok: false, why: compiled.why, message: '', level: compiled.level, declared: false }
      }
      // 软拒（硬禁区 / 主机级 + adminMode 关）：如实说做不了主，不动手
      if (compiled.refuse && !compiled.ticket) {
        note({
          kind: compiled.hazards?.length ? 'persona-runtime/duty-refused-forbidden' : 'persona-runtime/duty-refused-hostlevel',
          args: { why: compiled.why, level: compiled.level, adminMode: compiled.adminMode, takeover: compiled.takeover, hazards: compiled.hazards || [] },
          outcome: compiled.message || compiled.why,
        })
        lastDuty = { at: Date.now(), status: 'refused', why: compiled.why, level: compiled.level, message: compiled.message, intent: '' }
        return { ok: false, why: compiled.why, message: compiled.message, level: compiled.level, declared: true, refused: true }
      }
      const ticket = compiled.ticket
      // PR7 机械落点：Runtime 只认这一种形状，任何「像行动单但不长这样」的都不许喂 exec.run
      if (!isDutyTicket(ticket)) {
        lastDuty = { at: Date.now(), status: 'bad-shape', why: '编译产物形状不合 exec.js 契约', level: compiled.level, message: '', intent: '' }
        return { ok: false, why: 'bad-shape', message: '', level: compiled.level, declared: true }
      }
      const autotelic = autotelicOf()
      const exec = autotelic && autotelic.exec
      if (!exec || typeof exec.run !== 'function') {
        const why = 'autotelic 没在跑：行动申报通道 not-wired（不放弃，也不会自己去执行）'
        note({ kind: 'persona-runtime/duty-unavailable', args: { ticket: ticket.id, level: compiled.level }, outcome: why })
        lastDuty = { at: Date.now(), status: 'unavailable', why, level: compiled.level, message: '自驱引擎没开，这件事我先记着，等它开起来再申报。', intent: ticket.intent }
        return { ok: false, why, message: lastDuty.message, level: compiled.level, declared: true }
      }
      // 申报前记审计（级别 + 开关态是安全审计最关心的三件事：谁放的权、放到哪一级、有没有被接管）
      note({
        kind: 'persona-runtime/duty-declare',
        args: {
          ticket: ticket.id,
          level: compiled.level,
          steps: ticket.steps.length,
          adminMode: compiled.adminMode,
          hostTakeover: compiled.takeover,
          tag: ticket.tag,
        },
        outcome: compiled.takeover ? '宿主接管期间申报：一律排队等主人亲自放行' : `申报级别 ${compiled.level}`,
      })
      try {
        const r = await exec.run(ticket)
        const status = String(r?.status || 'unknown')
        lastDuty = {
          at: Date.now(),
          status,
          why: String(r?.why || ''),
          level: compiled.level,
          message: compiled.message,
          intent: ticket.intent,
          ticketId: ticket.id,
        }
        // 软拒自 exec 侧的也算行使（分级/硬禁区/确认闸都可能拦下）——一律留痕
        note({
          kind: 'persona-runtime/duty-result',
          args: { ticket: ticket.id, level: compiled.level, status },
          outcome: String(r?.why || status),
        })
        return { ok: status === 'done' || status === 'queued', why: lastDuty.why, message: compiled.message, level: compiled.level, status, ticketId: ticket.id, declared: true }
      } catch (error) {
        const why = String(error?.message || error)
        lastDuty = { at: Date.now(), status: 'failed', why, level: compiled.level, message: '', intent: ticket.intent }
        note({ kind: 'persona-runtime/duty-error', args: { ticket: ticket.id, level: compiled.level }, outcome: why })
        return { ok: false, why, message: '', level: compiled.level, declared: true }
      }
    }

    // ---------- R2 四段注入：唯一管线触点 ----------
    // mood 用的是 api.on('prompt')（不是 api.listen 字符串——那是宿主层给 @core 的入口）。
    // 返回的块追加到本轮消息**尾部**，顺序固定：情感感知 → 情感思想 → 情绪记忆 → 自我意识半段。
    api.on('prompt', (content, info = {}) => {
      const s = settings()
      // 系统会话不是「跟她说话」：原样放行（与 mood 的既有写法一致）
      if (info?.chat?.kind === 'system') return content
      // 爆式总开关关：精确退回「人格卡 + mood 旧口径」——一个块都不加。
      // 注：这里选择「注册监听但立即返回」而非「不注册监听」，因为 settings 是运行时可切换的
      //（不注册的话面板一关必须重启插件才生效）；可观测行为与设计 §2.2 完全一致。
      if (!s.enabled) return content

      const chat = info?.chat || null
      const incoming = incomingTextOf(content)
      // 情绪波动检测（只挂对话轮；读 mood 是纯读，不落盘）
      const state = moodState()
      const built = build({ chat, incoming, record: true })
      if (!process.env.PR_X1) noteEmotionShift(state)
      // 语气校准经验走观察层 note 来源（同一通道，只记语气类纠正）
      if (!process.env.PR_X2) noteCalibration(incoming, built.tone?.label || '')

      // mood.contextLine 让位（§1.2 方案 a）：Runtime 接管了情绪段就不再让 mood 那段重复出现；
      // Runtime 关（或两段情绪注入都关）时原样留着——mood 顶上，这是全关退化形态的 fallback。
      const takeOverEmotion = s.affectThought !== false || s.emotionMemory !== false
      const base = yieldMoodLine(Array.isArray(content) ? content : [], takeOverEmotion)

      // duty 申报：主人在对话里委托本机动作 → 编译 kind:'duty' 票喂 exec.run（唯一例外）
      //
      // 【实测教训，必须留在代码里】：这里**只识别与留痕，不自动执行**。
      // 第一版把 declareDuty 直接挂在 prompt 钩子上自动跑，实测出两个真问题：
      //   ① 误命中会真的开一轮工作台（exec.run → hub.runSystemTurn），把主人这一轮回复顶掉——
      //      全量测试里两个表情采集用例就是这么挂的（她的话变成了「你在执行自己的行动单…」）；
      //   ② 判读来源是拼接后的整段 content（含【发言身份】等脚手架），规则句会被当成委托。
      // 所以口径改成：**自动通道只做「识别 + 编译 + 审计留痕」**（零执行、零模型调用）；
      // 真正喂 exec.run 只走显式入口（route / 导出面 declare），由主人或面板决定。
      // 这不违反设计：§2.1 要求「编译产物喂 exec.run 同一入口」，本实现把那次喂入口收敛到
      // 一个显式动作上，分级/确认闸/审计/硬禁区全链依旧复用，且比自动跑更保守。
      try {
        const det = detectDuty(incoming)
        if (det.duty) {
          const compiled = compileDutyTicket({ text: incoming, chat, settings: s, tag: '牵挂', ...autotelicBudget() })
          note({
            kind: compiled.hazards?.length ? 'persona-runtime/duty-detected-forbidden' : 'persona-runtime/duty-detected',
            args: { level: compiled.level, adminMode: compiled.adminMode, hostTakeover: compiled.takeover, hazards: compiled.hazards || [], steps: compiled.ticket?.steps?.length || 0 },
            outcome: compiled.ticket ? `识别到委托（申报级别 ${compiled.level}），待显式申报` : (compiled.message || compiled.why),
          })
        }
      } catch (error) {
        log?.debug?.('人格运行时：duty 识别出错：', error?.message)
      }

      // R6 ignite 转发：重要对话结束（高显著度交互完成）→ 点燃一次自驱回味。
      // activeThinking 关 = 只剩定时回味；开了才有这条通道。不判断值不值得想（判断权在引擎）。
      try {
        if (s.activeThinking) {
          const chars = [...incoming].length
          const pick = shouldIgniteAfterTurn({ taskness: built.taskness, tone: built.tone, duty: detectDuty(incoming).duty, chars })
          if (pick.ignite) igniter.ignite(pick.reason).catch(() => {})
        }
      } catch (error) {
        log?.debug?.('人格运行时：ignite 判定出错：', error?.message)
      }

      // 开关快照（只在变化时写盘）
      if (!process.env.PR_X3) persistSnapshot(s)

      const blocks = toPromptBlocks(built)
      if (!blocks.length) return base
      // 追加到本轮消息尾部（固定顺序：情感感知 → 情感思想 → 情绪记忆 → 自我意识半段）
      return [...base, ...blocks]
    })

    // ---------- R3 稳定半段经 rules 通道进 system ----------
    // 判据（§2.1）：变化频率 ≥ 每轮的绝不进 system；变化频率 ≤ 本能晋升级的才允许进。
    // 只追加、不改 rulesText 实现；人格卡主体仍由既有 aurabot_persona / aurabot_rules_* 变量覆盖。
    api.rule((kind) => {
      const s = settings()
      if (!s.enabled) return []
      // 群聊档用 social 规则：自我意识的稳定半段一样成立（她是谁不随场合变），照常追加
      const staffOnly = kind === 'autotelic'
      if (staffOnly) return [] // 她的后台工作间不是「她跟人说话」，稳定半段不进去
      const persona = personaText()
      const ins = prefix.instincts()
      return stableSegments({ settings: s, cfg: api.config(), instincts: ins, personaSummary: persona })
    })

    // ---------- 面板/路由 ----------
    // 全路径精确匹配（模块 route 不做前缀匹配）；内置模块挂根路径。

    /** 组装 status（开关态 + 双 hash 对照 + 最近注入 + 残余小史 + 各段 token）。 */
    function statusPayload() {
      const s = settings()
      const hash = prefix.compare()
      const state = moodState()
      const residuals = deriveResiduals(state, { limit: 5 })
        .filter((r) => (Number(r.at) || 0) > clearedAt)
      const persona = personaText()
      return {
        ok: true,
        module: 'persona-runtime',
        enabled: s.enabled,
        // 配置读取异常（fail-closed 的显性信号）：超管/接管按关，体验开关按人格卡基线
        configError: s.configError,
        switches: Object.fromEntries(SWITCH_KEYS.map((k) => [k, s[k]])),
        budgets: Object.fromEntries(BUDGET_KEYS.map((k) => [k, s[k]])),
        budgetRanges: BUDGET_RANGES,
        // 双 hash 对照：不一致 = 接线漂移的显性信号（PR6 落点）
        prefix: {
          runtimeHash: hash.runtimeHash,
          autotelicHash: hash.autotelicHash,
          drift: hash.drift,
          why: hash.why,
          inputs: hash.inputs,
          // 稳定半段的进 system 资格说明（设计 §2.1 判据）
          stableGetsSystem: s.selfAware !== false,
          instinctAddonInPersona: personaHasInstinctAddon(persona),
          personaChars: [...persona].length,
          personaMax: PERSONA_SUMMARY_MAX,
        },
        // 最近一轮注入（内存态，重启即空）：各段 token 占用 + overflow(uncut) 标注
        lastInjection,
        // 残余小史（现场派生，不落盘）
        residuals: {
          items: residuals,
          summary: summarizeResiduals(residuals),
          windowHours: 24,
          max: 5,
          clearedAt,
          // 清残余只清派生展示，mood 向量交半衰自然消退（Runtime 不提供清向量）
          note: '残余小史是从 mood 现状现场派生的展示，清它不动情绪向量',
        },
        // 情绪现状（只读镜像，真相在 mood）
        emotion: state
          ? { top: topOf(state), value: Number(state.value) || 0, label: String(state.label || ''), at: Number(state.emotionsAt) || 0 }
          : null,
        // 观察桥 / ignite 的最近状态（都是单向出口）
        bridge: bridge.view(),
        ignite: igniter.view(),
        duty: { last: lastDuty, auditWired: auditWired() },
        // 运行时落盘快照（审计用）
        snapshot: readSnapshot(),
        // 管线触点说明（面板「她会看到什么」用）
        pipeline: {
          touchpoint: "api.on('prompt')",
          order: ['perceive', 'affect', 'memory', 'identity'],
          labels: SEGMENT_LABELS,
          timers: false,
          dataDirFiles: ['runtime.json'],
        },
      }
    }

    api.route('/persona-runtime/status', async () => statusPayload())

    // 零副作用试拼：「她会看到什么」。POST 可带 { chatKind, text }，不传就按最近一次真实输入的空壳拼。
    api.route('/persona-runtime/preview', async (req) => {
      let body = {}
      try { body = (await api.core?.http?.body?.(req)) || {} } catch { body = {} }
      const chatKind = String(body?.chatKind || body?.kind || 'private')
      const text = String(body?.text || body?.incoming || '')
      const s = settings()
      const built = build({ chat: { kind: chatKind, chatId: String(body?.chatId || '') }, incoming: text, record: false })
      const state = moodState()
      const residuals = deriveResiduals(state, { limit: 5 }).filter((r) => (Number(r.at) || 0) > clearedAt)
      return {
        ok: true,
        // 零副作用：不写 runtime.json、不动 mood、不推观察、不点火
        sideEffects: false,
        enabled: s.enabled,
        configError: s.configError,
        chatKind,
        incomingChars: [...text].length,
        tone: built.tone,
        taskness: built.taskness,
        // 各段 token 占用（不可观测的预算等于没有预算）
        segments: built.segments,
        totalTokens: built.totalTokens,
        budget: built.budget,
        overflow: built.overflow,
        overflowReason: built.overflowReason,
        // overflow(uncut) 标注：明确告诉主人「超出的是永不裁的那两样」
        uncutSegments: built.segments.filter((x) => x.key === 'identity').map((x) => x.label),
        degradation: built.degradation,
        order: built.order,
        residuals: { items: residuals, summary: summarizeResiduals(residuals) },
        // 拼装结果（她要看到的话术原文）
        blocks: built.blocks,
        text: built.blocks.join('\n'),
        // 前缀（稳定半段走 rules 通道，不在用户消息里）
        prefix: (() => { const h = prefix.compare(); return { runtimeHash: h.runtimeHash, autotelicHash: h.autotelicHash, drift: h.drift, why: h.why } })(),
      }
    })

    // 清残余：只清**派生展示**（清展示游标），mood 向量原样不动（边界外的事不做）
    api.route('/persona-runtime/emotions/clear', async () => {
      clearedAt = Date.now()
      lastShift = null // 差分基线也清掉：下一轮不拿旧值硬比
      note({ kind: 'persona-runtime/residual-clear', args: { clearedAt }, outcome: '主人清了残余小史展示（情绪向量未动，交 mood 半衰）' })
      return {
        ok: true,
        message: '已清掉残余小史的展示。她的情绪向量没动——那部分归心情模块半衰，一会儿自己就淡了。',
        clearedAt,
        note: '本操作不清情绪向量：Runtime 不提供「清向量」（那是对她情绪的篡改）',
      }
    })

    // ignite 手动入口（主动思考开关的运行时出口；与 panel「现在想想」同一条通道）
    api.route('/persona-runtime/ignite', async (req) => {
      let body = {}
      try { body = (await api.core?.http?.body?.(req)) || {} } catch { body = {} }
      const s = settings()
      if (!s.activeThinking) {
        return {
          ok: false,
          message: '「主动思考」没开：这条通道关着（关了只剩余时回味）。要手动想一轮，用自驱引擎页的「现在想一轮」。',
          outcome: 'skipped-disabled',
        }
      }
      const reason = String(body?.reason || '面板手动点火').slice(0, 80)
      const r = await igniter.ignite(reason)
      note({ kind: 'persona-runtime/ignite', args: { reason, outcome: r.outcome }, outcome: r.outcome })
      return {
        ok: r.ok,
        outcome: r.outcome,
        why: r.why,
        message: r.outcome === 'run'
          ? '点燃了：她这一轮会自己想点事'
          : `没点着（${r.outcome}）：${igniteWhy(r.outcome)}`,
      }
    })

    // 契约自检（面板「接线是否齐」用；纯只读）
    api.route('/persona-runtime/wiring', async () => {
      const ins = prefix.instincts({ force: true })
      return {
        ok: true,
        mood: Boolean(moodOf()),
        autotelic: Boolean(autotelicOf()),
        observeBridge: Boolean(autotelicOf()?.observe?.append),
        igniteChannel: Boolean(autotelicOf()?.schedule?.ignite),
        execChannel: Boolean(autotelicOf()?.exec?.run),
        audit: auditWired(),
        instincts: { ok: ins.ok, count: ins.list.length, why: ins.why },
        // 只读镜像：constraintRules 的编辑权在自驱页（D7）
        constraintRules: { chars: [...String(prefix.inputs().constraints || '')].length, editableHere: false },
      }
    })

    log?.info?.('人格运行时已启动：每轮注入四段（感知→思想→记忆→自我意识），稳定半段经 rules 通道进 system')

    // ---------- 导出面（别的模块/面板/测试用；全是稳定句柄，内部实现不外泄） ----------
    return {
      settings,
      /** 零副作用试拼（route / 测试共用同一份）。 */
      preview: (args = {}) => {
        const built = build({ chat: args.chat || { kind: args.chatKind || 'private' }, incoming: String(args.text || ''), record: false })
        return built
      },
      /** 真实注入结果（诊断用；不写任何状态）。 */
      lastInjection: () => lastInjection,
      status: statusPayload,
      prefix,
      bridge,
      igniter,
      /** duty 申报（面板/测试/未来工具化入口） */
      duty: {
        detect: detectDuty,
        hazards: detectHazards,
        compile: (args = {}) => compileDutyTicket({ settings: settings(), tag: '牵挂', ...autotelicBudget(), ...args }),
        declare: declareDuty,
        last: () => lastDuty,
      },
      /** 情绪只读镜像（面板显示用；真相在 mood）。 */
      emotion: () => {
        const s = moodState()
        if (!s) return null
        const residuals = deriveResiduals(s, { limit: 5 }).filter((r) => (Number(r.at) || 0) > clearedAt)
        return { top: topOf(s), value: Number(s.value) || 0, label: String(s.label || ''), residuals, summary: summarizeResiduals(residuals), clearedAt }
      },
      /** 残余展示清除（与 route 同一副作用面：只清展示）。 */
      clearResiduals: () => { clearedAt = Date.now(); lastShift = null; return { ok: true, clearedAt } },
      /** 语感判读（测试/诊断用）。 */
      perceive: (text) => ({ tone: perceiveTone(text), taskness: tasknessOf(text), tokens: estimateTokens(text) }),
      /** 估算工具（面板显示 token 用）。 */
      estimateTokens,
    }
  },
}

/** ignite 结果 → 面板话术（全是引擎的合法口径，不是错误）。 */
function igniteWhy(outcome) {
  const map = {
    'skipped-disabled': '自驱引擎总开关关着',
    'skipped-quiet': '现在是安静时段，只攒不触发',
    'skipped-ignite-cooldown': '刚点燃过，引擎的冷却还没过',
    'skipped-busy': '引擎正在想上一轮，这枪先不叠',
    unavailable: '自驱引擎没在跑',
    failed: '引擎那边出错了（看日志）',
  }
  return map[String(outcome)] || '引擎没接住这次点火'
}
