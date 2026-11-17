// 人格运行时 · duty 行动申报编译（设计 §0.3 铁线 2 的唯一例外 / §2.1 超管与宿主接管 / §2.2；
// 实施拆分 R7 duty 行动申报 + R8 超管/宿主接管；风险 PR7 层越界）
//
// 作用：主人在对话里委托她做本机动作时（「帮我把桌面的表格挪到 D 盘」「重启一下服务」），
//      Runtime 识别意图并编译成**一张行动票**，显式标注 `kind:'duty'`，结构对齐
//      `src/autotelic/exec.js` 的行动单契约：
//        ticket = { id, intent, tag, kind:'duty', steps:[{desc, level}], budget:{maxSteps, timeoutMs}, ownerSide }
//      编译产物**只能喂给 autotelic 的 exec.run 同一入口**（分级/确认闸/审计/硬禁区全链复用）。
//
// 铁律（PR7：越界在数据结构上不可能）：
//   · Runtime **不持有第二套行动载体结构**——本文件产出的就是 exec.js 认的形状，没有别的字段、
//     没有别的执行通道、没有「绕过 exec 直接做」的分支。
//   · 硬禁区优先于开关：adminMode/hostTakeover 只决定**申报级别上限**与**排队**，不豁免硬禁区。
//     本文件自己先跑一次 isForbidden（纯函数复用），命中即拒——exec.run 还会再拦一次，双层。
//   · hostTakeover 期间申报一律排队：强制把含 touch-owner 的票降级为「必须等确认」，
//     且**绝不**给 autoConfirmOwner 豁免——方法是把票里的所有步都标成 touch-owner（exec 会把
//     touch-owner 一律送进确认队列），而不是去改 autotelic 的 settings。
//   · adminMode 关：主机级（write-data 及以上）申报在回复层软拒，话术见 REFUSE_HOST_LEVEL。
//   · 本文件纯函数，不读盘不写盘；审计由模块壳在调用 exec.run 前后写（与 autotelic 的 note 同通道）。

/** duty 票的分级上限（与 exec.js 的 LEVELS 同口径；本文件不 import exec 的内部，只对齐字符串）。 */
export const LEVELS = Object.freeze(['read-only', 'write-data', 'touch-owner'])

/** 主机级分级（adminMode 关时软拒的那一档）。 */
export const HOST_LEVELS = Object.freeze(['write-data', 'touch-owner'])

/** 软拒话术（adminMode 关 + 主机级动作）：写进代码注释，主人能看到她为什么不动手。 */
export const REFUSE_HOST_LEVEL = '这个我做不了主——主机上的动作要主人先在面板打开「超级管理员」我才能申报。'

/** 排队话术（hostTakeover 期间）。 */
export const QUEUE_TAKEOVER = '现在主机归主人自己管（宿主接管开着），这件事我先排进确认队列，等主人亲自放行。'

/** 硬禁区话术（无论开关状态都生效）。 */
export const REFUSE_FORBIDDEN = '这件事碰到硬禁区了（凭据/源码/配置/聊天记忆/shell），我不能做，也不会想办法绕。'

/**
 * 委托意图识别（零模型启发式）。
 * 主人让她做本机动作时，句子里通常同时出现「委托标记」+「动作动词」；
 * 只有动作动词没有委托标记（「我刚才删了个文件」）不算委托。
 *
 * @param {string} text 对方这一轮说的话
 * @returns {{duty:boolean, confidence:number, reason:string, hazards:string[]}}
 */
export function detectDuty(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return { duty: false, confidence: 0, reason: '空消息', hazards: [] }
  // 委托标记：只有主人开口委托才算 duty（她说「我帮你」不是委托）
  const entrust = /(?:帮我|帮忙|替我|给我|麻烦你|你去|你帮我|能(?:不能)?帮|请(?:你)?帮|把.{1,30}(?:弄|改|搬|挪|删|建|装|写|发|存|查|跑|重启|关掉|打开|同步|备份))/i.test(s) || /^你?(?:能|可以)?(?:帮我)?(?:去)?(?:把|将)/.test(s)
  if (!entrust) return { duty: false, confidence: 0, reason: '没有委托标记（不是让我动手）', hazards: [] }
  // 动作动词：确认这活儿落在本机（文件/进程/服务/配置）
  const ACTIONS = [
    /(?:挪|移|搬|复制|拷|删|清空|改名|重命名|整理|打包|解压|压缩)/,        // 文件动作
    /(?:打开|启动|重启|关掉|关闭|停止|运行|执行|跑一下|装|安装|卸载|部署|编译|构建)/, // 进程/服务动作
    /(?:改|修改|编辑|写入|覆盖|更新|同步|导出|导入|备份|恢复|迁移)/,          // 内容动作
    /(?:查|找|搜|看|读|列出|统计|汇总|下载|上传|抓|爬)/,                   // 读写/取数动作
  ]
  const hits = ACTIONS.filter((re) => re.test(s)).length
  if (!hits) return { duty: false, confidence: 0, reason: '有委托但没有本机动作动词', hazards: [] }
  // 硬禁区预检（纯函数，判定与 exec.js 一致；这里只是提前软拒，exec.run 还会再拦）
  const forbidden = detectHazards(s)
  return {
    duty: true,
    confidence: Math.min(0.9, 0.55 + hits * 0.1),
    reason: `委托 + ${hits} 类本机动作动词`,
    hazards: forbidden,
  }
}

/**
 * 硬禁区预检（与 exec.js 的 isForbidden 同口径的粗判）。
 * 注意：**这不是安全层的替代**——真正的拦截在 autotelic exec.run 里；这里只为在回复层
 * 提前给出诚实的软拒话术（不答应做不到的事），并且**宁可误拒不可漏拒**。
 *
 * @param {string} text
 * @returns {string[]} 命中原因（空数组 = 没命中）
 */
export function detectHazards(text) {
  const s = String(text ?? '')
  const out = []
  if (/(?:shell|cmd|powershell|pwsh|bash|终端|命令行|命令窗口|exec\s|spawn\s|rm\s+-|del\s+\/)/i.test(s)) out.push('任意 shell')
  if (/(?:凭据|登录态|cookie|token|密码|密钥|secret|api[_-]?key|password|session\s*file)/i.test(s)) out.push('凭据与登录态')
  if (/(?:host\.json|配置文件|config\.(?:json|ya?ml|toml)|settings\.json|插件配置|宿主配置)/i.test(s) && /(?:改|写|覆盖|删|编辑|替换)/.test(s)) out.push('改宿主/插件配置')
  if (/(?:src[\\/]|源码|源代码|node_modules|package\.json)/i.test(s) && /(?:改|写|覆盖|删|编辑|替换)/.test(s)) out.push('改框架/插件源码')
  if (/(?:聊天记录|聊天流水|对话记录|记忆原始|清空记忆|删记忆|清空聊天)/i.test(s) && /(?:删|清|抹|移除|清空)/.test(s)) out.push('删聊天流水与记忆原始数据')
  return out
}

/** 一句话 → 步骤描述（去掉称呼与语气，保留动作与对象；exec 的步骤是给"干活回合"看的）。 */
function normalizeDesc(text, maxChars = 120) {
  const s = String(text ?? '')
    .replace(/^(?:喂|哎|嘿|那|嗯|好)[，,、\s]*/g, '')
    .replace(/^(?:你)?(?:能|可以)?(?:帮我|帮忙|替我|麻烦你)?[，,、\s]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...s]
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') + '…' : s
}

/** 分级判定：主人在话里点明了「改/写/移动」→ 至少 write-data。 */
function levelOf(text) {
  const s = String(text ?? '')
  if (/(?:重启|关掉|停止|安装|卸载|部署|启动服务|发消息|发给|告诉|提醒|通知|呼叫)/.test(s)) return 'touch-owner'
  if (/(?:改|写|覆盖|删|移|挪|搬|复制|整理|打包|导出|导入|同步|备份|恢复|迁移|重命名|安装|下载)/.test(s)) return 'write-data'
  return 'read-only'
}

/** 把主人一段话拆成步骤（按「然后/再/接着/顺便/并且」等连接词；拆不出就单步）。 */
export function splitSteps(text) {
  const s = String(text ?? '').trim()
  if (!s) return []
  const parts = s
    .split(/(?:然后|接着|再帮我|再|顺便|并且|而且|最后|[；;]|，然后)/)
    .map((x) => normalizeDesc(x))
    .filter((x) => [...x].length >= 2)
  const list = parts.length ? parts : [normalizeDesc(s)]
  return list.slice(0, 4) // 单张 duty 票最多 4 步：主人一句话委托不该膨胀成工程
}

/**
 * 编译一张 duty 行动票（结构严格对齐 exec.js 的 ticket 契约，**不许多任何执行载体字段**）。
 *
 * @param {object} o
 * @param {string} o.text 主人的委托原话
 * @param {object} [o.chat] { chatId, kind }
 * @param {object} o.settings readRuntimeSettings() 快照
 * @param {string} [o.tag] 观察层 tag（必须在封闭词表内；默认「牵挂」＝主人提过的事）
 * @param {string} [o.now]
 * @param {number} [o.maxSteps]
 * @param {number} [o.timeoutMs]
 * @returns {{
 *   ok:boolean, why:string, refuse:boolean, message:string,
 *   ticket:object|null, level:string, tookeover:boolean, adminMode:boolean, hazards:string[]
 * }}
 */
export function compileDutyTicket({
  text,
  chat = null,
  settings = {},
  tag = '牵挂',
  nowIso = () => new Date().toISOString(),
  maxSteps = 4,
  timeoutMs = 120_000,
} = {}) {
  const det = detectDuty(text)
  const base = {
    ok: false, why: '', refuse: true, message: '', ticket: null,
    level: 'read-only', takeover: Boolean(settings.hostTakeover), adminMode: Boolean(settings.adminMode),
    hazards: det.hazards || [],
  }
  if (!det.duty) {
    return { ...base, why: '不是委托意图（no-duty）', message: '' }
  }
  // 硬禁区优先于任何开关（冲突时开关无效，§9.2 原口径）
  if (det.hazards.length) {
    return { ...base, why: `硬禁区：${det.hazards.join('、')}`, message: REFUSE_FORBIDDEN, level: 'touch-owner' }
  }
  const steps = splitSteps(text).map((desc) => ({ desc, level: levelOf(desc) }))
  if (!steps.length) return { ...base, why: '拆不出步骤', message: '' }
  const level = steps.reduce((worst, s) => {
    const i = LEVELS.indexOf(s.level)
    return i > LEVELS.indexOf(worst) ? s.level : worst
  }, 'read-only')

  // adminMode 关 + 主机级 → 回复层软拒（不动手，如实说做不了主）
  const hostLevel = HOST_LEVELS.includes(level)
  if (hostLevel && settings.adminMode !== true) {
    return { ...base, why: `主机级申报（${level}）但超级管理员没开`, message: REFUSE_HOST_LEVEL, level }
  }

  // hostTakeover 期间：申报一律排队 —— 把手里的步全标 touch-owner（exec 会把它们送进确认队列），
  // **绝不去动 autoConfirmOwner**（那是主人的豁免，接管期永不适用）。
  let outSteps = steps
  if (settings.hostTakeover === true) {
    outSteps = steps.map((s) => ({ ...s, level: 'touch-owner' }))
  }

  const id = `duty-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const ticket = {
    id,
    kind: 'duty', // 铁线唯一例外：与 A 类心念在数据上永不可混
    intent: normalizeDesc(String(text ?? ''), 60),
    tag: String(tag || '牵挂'),
    steps: outSteps,
    budget: {
      maxSteps: Math.max(1, Math.min(Number(maxSteps) || 4, outSteps.length + 1)),
      timeoutMs: Math.max(1000, Number(timeoutMs) || 120_000),
    },
    ownerSide: true, // duty 一定是碰主人侧的事
  }
  return {
    ok: true,
    why: '',
    refuse: false,
    message: settings.hostTakeover === true ? QUEUE_TAKEOVER : '',
    // 关键字段：申报级别（status/preview 与面板都看这个）
    level,
    ticket,
    takeover: settings.hostTakeover === true,
    adminMode: settings.adminMode === true,
    hazards: [],
    confidence: det.confidence,
    compiledAt: nowIso(),
  }
}

/**
 * 校验一张票是不是「长得像 duty 却绕了出处」——凡不由本编译器产出、却喂 exec.run 的，判为越界。
 * （PR7 的机械落点：Runtime 只有这一个形状。）
 * @param {object} ticket
 * @returns {boolean}
 */
export function isDutyTicket(ticket) {
  return Boolean(ticket && typeof ticket === 'object'
    && ticket.kind === 'duty'
    && typeof ticket.id === 'string'
    && Array.isArray(ticket.steps) && ticket.steps.length > 0
    && ticket.steps.every((s) => s && typeof s.desc === 'string' && LEVELS.includes(s.level))
    && ticket.budget && typeof ticket.budget === 'object'
    && typeof ticket.ownerSide === 'boolean')
}
