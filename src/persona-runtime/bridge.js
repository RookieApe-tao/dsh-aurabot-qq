// 人格运行时 · 观察桥推送制与 ignite 转发（设计 §2.3 转发 / §2.4 接口表 / §2.2 主动思考；
// 实施拆分 R5 观察桥推送制 + R6 ignite 转发）
//
// 作用：
//   1) **情绪观察推送**：显著波动（emotionTop 键变化 或 nudge |Δ|≥8）→
//      `api.use('autotelic').observe.append({source:'emotion', tag, text, salience})`。
//      autotelic 现有的轮询桥（fetchEmotions 读 mood.state）在本模块上线后退役，数据源换成这里的推送。
//   2) **语气校准经验**：主人纠正一句 → `source:'note'` 走**同一个观察通道**（审查 6：
//      禁止另开直写 skills/memory 的口子，沉淀链归引擎）。
//   3) **ignite 转发**：重要对话结束 → `api.use('autotelic').schedule.ignite(reason)`。
//      Runtime 只传「有件事刚发生」这个事实，**不判断值不值得想**（判断权全在引擎三段决策环）；
//      冷却由 schedule 的 igniteCooldownMinutes 统一管。
//
// 契约：
//   · 单向：**只出不进**（防「越想越委屈」自激回路；观察层的东西不会回流成 Runtime 的输入）。
//   · 宁缺毋假：autotelic 没跑 / append 返回 bad-tag / 显著度不够被门控 → 记为未写入，不重试、不伪造。
//   · tag 必须在观察层封闭词表内（tags.js）；本文件把情绪语气映射到词表内最贴切的项，判不出就用「牵挂」。
//   · 本文件零 IO（真正的落盘在 autotelic 的观察层，含批量写盘纪律）。

/** 情绪键/label → 观察层封闭词表 tag 的映射（词表见 src/autotelic/tags.js）。 */
const TAG_BY_EMOTION = Object.freeze({
  curious: '好奇',
  excited: '得意',
  lonely: '牵挂',
  envious: '牵挂',
  worried: '牵挂',
  proud: '得意',
  affectionate: '陪伴',
  bored: '生活',
  amused: '分享',
  content: '生活',
})

/** 从情绪键/label 猜一个合法 tag（词表内；猜不出给 defaultTag）。 */
export function tagForEmotion(key = '', label = '', defaultTag = '牵挂') {
  const k = String(key || '').toLowerCase()
  if (TAG_BY_EMOTION[k]) return TAG_BY_EMOTION[k]
  const l = String(label || '')
  if (/好奇|新鲜/.test(l)) return '好奇'
  if (/得意|自豪|骄傲/.test(l)) return '得意'
  if (/喜欢|亲近|温柔|陪伴/.test(l)) return '陪伴'
  if (/担心|牵挂|想念|寂寞|孤独/.test(l)) return '牵挂'
  if (/无聊|平静|日常/.test(l)) return '生活'
  if (/开心|兴奋|好笑|分享/.test(l)) return '分享'
  return defaultTag
}

/**
 * 造观察桥（推送制）。
 * @param {object} o
 * @param {()=>object|null} o.getAutotelic api.use('autotelic') 的懒取（模块可能没开/被替换）
 * @param {object} [o.log]
 * @param {()=>number} [o.now]
 */
export function createObservationBridge({ getAutotelic, log = null, now = () => Date.now() } = {}) {
  /** 最近一次推送结果（status 显示用；不落盘）。 */
  let last = { at: 0, ok: false, reason: '', kind: '' }
  /** 推送计数（本次进程内；面板看趋势用）。 */
  const stats = { emotion: 0, note: 0, skipped: 0, failed: 0 }

  function observeOf() {
    try {
      const a = typeof getAutotelic === 'function' ? getAutotelic() : null
      const obs = a && a.observe
      return obs && typeof obs.append === 'function' ? obs : null
    } catch {
      return null
    }
  }

  /** 推一条观察（统一的唯一出口）。 */
  function push({ source = 'emotion', tag = '牵挂', text = '', salience = 0.6 } = {}) {
    const body = String(text || '').trim()
    if (!body) {
      last = { at: now(), ok: false, reason: 'empty-text', kind: source }
      stats.skipped += 1
      return { ok: false, reason: 'empty-text' }
    }
    const obs = observeOf()
    if (!obs) {
      last = { at: now(), ok: false, reason: 'autotelic 没在跑（观察桥 not-wired）', kind: source }
      stats.skipped += 1
      return { ok: false, reason: 'not-wired' }
    }
    try {
      const r = obs.append({ source, tag, text: body, salience })
      if (r && r.ok) {
        stats[source === 'note' ? 'note' : 'emotion'] += 1
        last = { at: now(), ok: true, reason: '', kind: source }
        return { ok: true, row: r.row }
      }
      stats.failed += 1
      last = { at: now(), ok: false, reason: String(r?.reason || 'append 被拒'), kind: source }
      return { ok: false, reason: String(r?.reason || 'append 被拒') }
    } catch (error) {
      stats.failed += 1
      last = { at: now(), ok: false, reason: String(error?.message || error), kind: source }
      log?.debug?.('人格运行时：观察推送出错：', error?.message)
      return { ok: false, reason: String(error?.message || error) }
    }
  }

  /**
   * 情绪波动 → source='emotion' 观察。
   * @param {{changed:boolean, topKey:string, label:string, valueDelta:number}} shift detectShift() 的返回
   * @param {string} text shiftText() 的文本
   * @param {number} salience shiftSalience()
   * @returns {{ok:boolean, reason?:string}}
   */
  function pushEmotion({ shift, text, salience }) {
    if (!shift || !shift.changed) return { ok: false, reason: 'no-shift' }
    const tag = tagForEmotion(shift.topKey, shift.label)
    return push({ source: 'emotion', tag, text, salience: salience ?? 0.6 })
  }

  /**
   * 语气校准经验（主人纠正一句）→ source='note' 观察（同一通道，进引擎沉淀链）。
   * @param {object} o
   * @param {string} o.text 主人纠正的原话
   * @param {string} [o.tag]
   * @param {string} [o.tone] 被纠正时的判读语气（写进正文，便于日后沉淀）
   */
  function pushCalibration({ text, tag = '牵挂', tone = '' } = {}) {
    const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    if (!body) return { ok: false, reason: 'empty-text' }
    const line = `主人纠正了我的语气${tone ? `（当时我判成「${tone}」）` : ''}：${body}`
    return push({ source: 'note', tag, text: line, salience: 0.9 })
  }

  /** 最近一次推送结果 + 计数（status 用）。 */
  function view() {
    return { last: { ...last }, stats: { ...stats }, wired: Boolean(observeOf()) }
  }

  return { push, pushEmotion, pushCalibration, view }
}

/**
 * 造 ignite 转发器（主动思考开关的唯一运行时出口）。
 *
 * 语义（设计 §2.2 / D14）：**只转发不判断**。Runtime 传过去的是「有件事刚发生」，
 * 值不值得想、什么时段想、想几轮，全由 autotelic 的 schedule 判断（含总开关、安静时段、冷却）。
 * 因此这里**不自己判冷却**——重复转发由 schedule 的 igniteCooldownMinutes 统一吃下。
 *
 * @param {object} o
 * @param {()=>object|null} o.getAutotelic
 * @param {object} [o.log]
 * @param {()=>number} [o.now]
 */
export function createIgniter({ getAutotelic, log = null, now = () => Date.now() } = {}) {
  let last = { at: 0, reason: '', outcome: 'never', why: '' }

  /**
   * 转发一次点火。
   * @param {string} reason 事实描述（例如「重要对话结束」「主人托付了一件事」）
   * @returns {Promise<{ok:boolean, outcome:string, why:string}>}
   */
  async function ignite(reason = '重要对话结束') {
    const text = String(reason || '重要对话结束').slice(0, 80)
    let schedule = null
    try {
      const a = typeof getAutotelic === 'function' ? getAutotelic() : null
      schedule = a && a.schedule
    } catch {
      schedule = null
    }
    if (!schedule || typeof schedule.ignite !== 'function') {
      last = { at: now(), reason: text, outcome: 'unavailable', why: 'autotelic 没在跑（点火通道 not-wired）' }
      return { ok: false, outcome: 'unavailable', why: last.why }
    }
    try {
      const r = await schedule.ignite(text)
      const outcome = String(r?.outcome || 'unknown')
      // 全是引擎口径的合法结果：run / skipped-disabled / skipped-quiet / skipped-ignite-cooldown / skipped-busy
      last = { at: now(), reason: text, outcome, why: '' }
      return { ok: outcome === 'run', outcome, why: '' }
    } catch (error) {
      last = { at: now(), reason: text, outcome: 'failed', why: String(error?.message || error) }
      log?.debug?.('人格运行时：ignite 转发失败：', error?.message)
      return { ok: false, outcome: 'failed', why: last.why }
    }
  }

  function view() {
    return { ...last }
  }
  return { ignite, view }
}

/**
 * 重要对话结束判定（零模型启发式）：只有「高显著度交互完成」才点燃一次回味。
 *
 * 判据（设计 §2.2：重要对话结束 = 高显著度交互完成 / 主人托付了事 / 剧烈情绪平息）：
 *   · 主人托付了事（duty 命中）→ 必点；
 *   · 这一轮情绪段被跳过（正经活儿）且消息够长 → 点；
 *   · 语气判读为 upset 且消息够长（情绪波动）→ 点；
 *   · 其余（日常闲聊）→ 不点：「不做事」是一等公民。
 *
 * @param {object} o
 * @param {object} o.taskness tasknessOf() 的返回
 * @param {object} o.tone perceiveTone() 的返回
 * @param {boolean} o.duty 是否识别为主人委托
 * @param {number} o.chars 这一轮对方正文的字数
 * @returns {{ignite:boolean, reason:string}}
 */
export function shouldIgniteAfterTurn({ taskness, tone, duty = false, chars = 0 } = {}) {
  if (duty) return { ignite: true, reason: '主人托付了一件事' }
  const level = String(taskness?.level || 'none')
  const t = String(tone?.tone || 'neutral')
  if (level === 'skip' && Number(chars) >= 24) return { ignite: true, reason: '办完一件正经事' }
  if (t === 'upset' && Number(chars) >= 12) return { ignite: true, reason: '刚有一次明显情绪起伏' }
  return { ignite: false, reason: '' }
}
