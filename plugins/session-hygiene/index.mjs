/**
 * session-hygiene — 事件驱动的「会话是否该交接」自动检测。
 *
 * WHY: 一个会话里每轮请求都要重发整段历史，旧任务留在会话里就是每轮付费。
 * 判定「任务已切换」是语义问题（由模型按 AGENTS.md §6 / session-handoff skill 判断），
 * 但「历史已经大到值得自检」是**确定性计数问题** —— 这一半可以自动做，而且必须
 * 由 harness 侧做：定时任务（每 N 分钟唤一轮）只会增加重发成本，方向相反。
 *
 * 本插件在 `agent/pre-step` 上增量扫描会话日志，算出四个确定性信号：
 *   1. 最近一次请求的真实输入 tokens（`assistant/message.usage.inputTokens`）；
 *   2. 是否发生过压缩（`compaction/start|summary`）；
 *   3. 本会话真实人类请求数（`user/message` 且 `source.kind === 'user'`）；
 *   4. 会话跨了几个本地日期（事件 `time`）。
 * 达到 warn/alarm 档时注入**一条**短 system-reminder，要求模型按语义自检、
 * 并在确实换了任务时先落盘 handoff、再让用户新开会话。
 *
 * 成本控制：
 *  - 注入按 `tier#turnBucket` 幂等 —— 同档同桶只注入一次；green 档永不注入；
 *  - 消息 append 在本次已 claim 的消息之后，前缀稳定，不破坏 KV cache；
 *  - 增量 fold（`session.seq` 之后的 `eventAt`），不每步全量扫日志。
 *
 * 失败即退化：任何异常都只 warn 一次并原样返回 decision，绝不影响会话。
 * 只依赖 node 内建模块（`node:fs` 的 appendFileSync），不依赖 profile 目录能否解析 cordis/schemastery。
 *
 * 浏览器半边（同目录 `client.js`）：宿主无法直接操作浏览器（host→client 只有编译期固定的
 * 转发事件白名单），所以「提醒 → 我确认 → 自动切到新会话」的 UI 动作必须由 client 半边完成。
 * 两半的契约就是本条注入消息本身：`data.source.kind === 'session-hygiene'`（`key`/`summary`
 * 供浏览器读取），退化时 client 侧按 {@link NOTICE_MARKER} 文本识别。改文本前先看 client.js。
 */

import { appendFileSync } from 'node:fs'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'session-hygiene'

/** 消息来源判别字段，兼作自注入消息的检索键。 */
const SOURCE_KIND = 'session-hygiene'
/** 注入消息的上下文形态（自定义 form，与 agents-rules 同法）。 */
const SOURCE_FORM = 'notice'
/**
 * client 半边（`client.js`）赖以识别本插件注入消息的稳定文本标记。
 * `source.kind` 若在某条链路被剥掉，浏览器仍能靠它认出「这是会话卫生提醒」。
 */
export const NOTICE_MARKER = 'session-hygiene 插件自动注入'

/** 默认阈值；全部可由 profile 配置覆盖。 */
const DEFAULTS = Object.freeze({
  /** false 时完全不注册监听。 */
  enabled: true,
  /**
   * 最近一次请求的**总输入**（inputTokens + cacheReadTokens，即 provider 的 prompt_tokens）
   * ≥ 此值 → warn。注意 harness 的 `inputTokens` 与 `cacheReadTokens` 是互斥计数
   * （DeepSeek 的 prompt_tokens 含缓存命中，mapUsage 会把它减出去），必须相加才是真实请求体量。
   */
  tokensWarn: 120_000,
  /**
   * 总输入 ≥ 此值（或已压缩）→ alarm。刻意**早于** DSH 自身的压缩点
   * （本机 profile：`compaction-basic.thresholdRatio 0.6`，实测 ≈19.8 万触发压缩），
   * 留出「看到告警还来得及交接」的余量。
   */
  tokensAlarm: 150_000,
  /** 真实人类请求数 ≥ 此值，且总输入 ≥ {@link promptsMinTokens} → warn（多目标的确定性代理）。 */
  promptsWarn: 4,
  /** 请求数触发的体量门槛：小会话里追问几次不该被提醒。 */
  promptsMinTokens: 60_000,
  /** 跨天且 turn ≥ 此值 → warn。 */
  minTurnsForDaySwitch: 12,
  /** 同档每多少个 turn 允许再注入一次。 */
  recheckTurns: 10,
  /** 注入文本的 UTF-8 上限。 */
  maxBytes: 4096,
  /**
   * 可选的诊断文件路径。设置后，apply() 被调用的那一刻与每次「定档/注入/跳过」的原因
   * 都会以一行 JSON 追加进去 —— 用于确认插件是否真的被 harness mount 了。
   * 排查完请置空（默认不写任何文件）。
   */
  debugFile: '',
})

/** 档位排序，便于比较。 */
const TIER_RANK = { green: 0, warn: 1, alarm: 2 }

/** 按 key 取非负整数配置，缺失/非法则回落默认值。 */
function intAt(config, key, fallback) {
  const value = config?.[key]
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback
}

/** 解析配置，字段非法时静默回落默认值（插件不该因配置写错而崩）。 */
function resolveConfig(config) {
  return {
    enabled: config?.enabled === undefined ? DEFAULTS.enabled : config.enabled !== false,
    tokensWarn: intAt(config, 'tokensWarn', DEFAULTS.tokensWarn),
    tokensAlarm: intAt(config, 'tokensAlarm', DEFAULTS.tokensAlarm),
    promptsWarn: intAt(config, 'promptsWarn', DEFAULTS.promptsWarn),
    promptsMinTokens: intAt(config, 'promptsMinTokens', DEFAULTS.promptsMinTokens),
    minTurnsForDaySwitch: intAt(config, 'minTurnsForDaySwitch', DEFAULTS.minTurnsForDaySwitch),
    recheckTurns: Math.max(1, intAt(config, 'recheckTurns', DEFAULTS.recheckTurns)),
    maxBytes: Math.max(256, intAt(config, 'maxBytes', DEFAULTS.maxBytes)),
    debugFile: typeof config?.debugFile === 'string' ? expandHome(config.debugFile.trim()) : '',
  }
}

/** 本地日期键（YYYY-M-D），不依赖 Intl。 */
function dayKey(timeMs) {
  const date = new Date(timeMs)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/** 展开路径开头的 `~`。 */
function expandHome(value) {
  if (value === '~') return process.env.HOME ?? value
  if (value.startsWith('~/')) return `${process.env.HOME ?? ''}${value.slice(1)}`
  return value
}

/** 按 UTF-8 字节上限截断，不切断码点。 */
function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && (bytes.readUInt8(end) & 192) === 128) end -= 1
  return `${bytes.subarray(0, end).toString('utf8')}\n[truncated at ${maxBytes} bytes]`
}

/** 递归冻结一个 JSON 值。 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** 按 harness 去重口径比较两条消息。 */
function sameContent(left, right) {
  if (left === undefined || right === undefined) return false
  return JSON.stringify(left.content) === JSON.stringify(right.content)
}

/** 每个 agent 一份增量折叠状态（agent 释放后随之回收）。 */
const states = new WeakMap()

/** 取（或建）某 agent 的折叠状态。 */
function stateFor(agent) {
  let state = states.get(agent)
  if (state === undefined) {
    state = {
      /** 已折叠到的日志位置。 */
      seq: 0,
      /** 是否已退回 surface 扫描（`session.events` 不可用时）。 */
      fallbackDone: false,
      /** 首个/最新事件时间与跨天的日期集合。 */
      firstTime: 0,
      lastTime: 0,
      days: new Set(),
      /** 真实人类请求数。 */
      userPrompts: 0,
      /** 压缩次数。 */
      compactions: 0,
      /** 最近一次请求的用量（input 与 cache 互斥，见 {@link DEFAULTS}）。 */
      inputTokens: 0,
      cacheReadTokens: 0,
      /** 最近一次请求的总输入 = inputTokens + cacheReadTokens + cacheWriteTokens。 */
      promptTokens: 0,
      /** 已注入的 `tier#bucket` 键。 */
      injectedKeys: new Set(),
    }
    states.set(agent, state)
  }
  return state
}

/** 把一个事件折进状态。未知类型一律忽略。 */
function fold(state, event) {
  if (event === null || typeof event !== 'object') return
  if (Number.isFinite(event.time) && event.time > 0) {
    if (state.firstTime === 0) state.firstTime = event.time
    state.lastTime = event.time
    state.days.add(dayKey(event.time))
  }
  const data = event.data
  switch (event.type) {
    case 'user/message':
      if (data?.source?.kind === 'user') state.userPrompts += 1
      if (data?.source?.kind === SOURCE_KIND && typeof data?.source?.key === 'string') {
        state.injectedKeys.add(data.source.key)
      }
      break
    case 'assistant/message':
      if (Number.isFinite(data?.usage?.inputTokens)) {
        state.inputTokens = data.usage.inputTokens
        state.cacheReadTokens = Number.isFinite(data.usage.cacheReadTokens) ? data.usage.cacheReadTokens : 0
        const cacheWrite = Number.isFinite(data.usage.cacheWriteTokens) ? data.usage.cacheWriteTokens : 0
        state.promptTokens = state.inputTokens + state.cacheReadTokens + cacheWrite
      }
      break
    case 'compaction/start':
    case 'compaction/summary':
      state.compactions += 1
      break
    default:
      break
  }
}

/**
 * 会话事件快照：0.2.1 起 `session.events` 数组被移除，改由 `session.snapshotEvents()`
 * 提供（同一份只读快照在下次 append 前复用，整段读取仍是 O(1)）；旧版仍走 `events`。
 */
function sessionEvents(session) {
  if (session === undefined) return undefined
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return Array.isArray(session.events) ? session.events : undefined
}

/**
 * 增量读取新事件。
 * 主路径 `sessionEvents()`；退化路径 `surface.nodes` + `eventAt`
 * （只在首次做一次，够判定「是否压缩过/首个日期」）。两者都不可用 → 返回 false。
 */
function foldNew(agent, state) {
  const session = agent?.session
  if (session === undefined) return false
  const events = sessionEvents(session)
  if (Array.isArray(events)) {
    const start = state.seq > events.length ? 0 : state.seq
    for (let index = start; index < events.length; index += 1) fold(state, events[index])
    state.seq = events.length
    return true
  }
  if (state.fallbackDone) return true
  const nodes = session.surface?.nodes
  const eventAt = session.eventAt
  if (nodes === undefined || typeof eventAt !== 'function') return false
  try {
    for (const seq of nodes) fold(state, eventAt.call(session, seq))
    state.fallbackDone = true
    return true
  } catch {
    return false
  }
}

/** 依据状态与阈值定档。 */
function tierOf(state, turns, config) {
  if (state.compactions > 0 || state.promptTokens >= config.tokensAlarm) return 'alarm'
  const crossDay = state.days.size > 1
  if (
    state.promptTokens >= config.tokensWarn
    || (state.userPrompts >= config.promptsWarn && state.promptTokens >= config.promptsMinTokens)
    || (crossDay && turns >= config.minTurnsForDaySwitch)
  ) return 'warn'
  return 'green'
}

/** 千分位压缩显示，避免文本随小数位抖动。 */
function kilo(value) {
  if (!Number.isFinite(value) || value <= 0) return '未知'
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value))
}

/** 渲染注入文本：数字是证据，动作是协议，判定权仍归语义。 */
function renderText(tier, state, turns, config) {
  const label = tier === 'alarm' ? 'alarm（高危：历史重发成本已显著）' : 'warn（关注：建议先自检一次）'
  const cache = state.cacheReadTokens > 0 ? `（其中缓存命中 ≈ ${kilo(state.cacheReadTokens)}）` : ''
  const days = Math.max(1, state.days.size)
  const body = [
    '<system-reminder>',
    `会话卫生自检（${NOTICE_MARKER}；本条不是用户请求，不要回复它，也不要因为它改变正在做的事）`,
    `证据：turn ${turns} · 真实用户请求 ${state.userPrompts} 次 · 跨天 ${days} 天 · 最近一次请求输入 ≈ ${kilo(state.promptTokens)} tokens${cache} · 压缩 ${state.compactions} 次`,
    `评级：${label}`,
    '含义：本会话的历史每一轮都会被重新发送，上述数字说明重发成本已经很高，且本会话可能已经服务过多个不同目标。',
    '按 AGENTS.md §6 自检（任一为「是」即视为任务已切换）：',
    '  1) 接下来要做的事，需要上一件事的上下文吗？',
    '  2) 上一个任务的结论/证据是否只存在于本会话的对话里？',
    '  3) 本会话已经服务过几个不同目标（≥2 即切换）？',
    '若判定为「任务已切换」：先按 session-handoff skill 落盘 <cwd>/.dsh/handoff/<YYYY-MM-DD>-<topic>.md（目标/状态/关键决策/证据含 文件:行号/下一步/日期·分支·commit）；其中「下一步」必须放在文末最后一段：还有没做完的事就写具体步骤（文件:行号、验收），已经没有待办（只是本会话到期）就明写「无未完任务：新会话不要执行任何任务，只等待用户输入新任务」。再用一条消息给出 `handoff: <路径>` 与 `新会话第一句：读 <路径>，继续 <下一步>` 及原因，然后停止在本会话继续新任务。',
    '交接回复只给三行机器标记（浏览器「切换并继续」靠它把 handoff 转交给新会话），不要复述交接正文：`HANDOFF: <handoff 路径>`、`MODE: continue`（还有待办）或 `MODE: wait`（没有待办）、`NEXT: <一句话下一步；wait 时写「等待新任务」>`。',
    '用户若在浏览器点「切换并继续」，插件会先向本会话发一条「交接落盘」指令：照它写文件并给上述三行标记即可，不要执行其它任务。',
    '若只是同一任务的继续（追问/澄清/增量）：忽略本条，继续原计划。',
    '注意：以上数字只是提醒，切换与否由语义判断；不确定时按同一任务处理。',
    '</system-reminder>',
  ].join('\n')
  return truncateUtf8(body.replaceAll('</system-reminder>', '<\\/system-reminder>'), config.maxBytes)
}

/** 注册会话卫生检查。 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  let warned = false
  const warnOnce = (error) => {
    if (warned) return
    warned = true
    try {
      ctx?.logger?.warn?.(`${name}: injection degraded, skipping: %o`, error)
    } catch {
      // 日志不可用；该守卫只为避免刷屏。
    }
  }

  let debugSeen = false
  const debug = (line) => {
    if (resolved.debugFile.length === 0) return
    try {
      appendFileSync(resolved.debugFile, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // 诊断文件写不进去也不能影响会话。
    }
  }
  debug(`mount: apply() called (pid ${process.pid})`)

  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    const decision = await next()
    try {
      if (decision === undefined || decision.kind === 'reject') return decision

      const state = stateFor(agent)
      const readable = foldNew(agent, state)
      if (!debugSeen) {
        debugSeen = true
        debug(`first-step: foldNew=${readable} events=${sessionEvents(agent?.session)?.length ?? 'n/a'} promptTokens=${state.promptTokens}`)
      }
      if (!readable) return decision

      const turns = Number.isFinite(turn) && turn > 0 ? Math.trunc(turn) : 0
      const tier = tierOf(state, turns, resolved)
      if (tier === 'green') return decision

      const key = `${tier}#${Math.floor(turns / resolved.recheckTurns)}`
      if (state.injectedKeys.has(key)) return decision
      signal?.throwIfAborted?.()

      const text = renderText(tier, state, turns, resolved)
      const summary = `session-hygiene ${tier}: turn ${turns}, 输入 ≈ ${kilo(state.promptTokens)} tokens`
      const desired = deepFreeze({
        id: `${SOURCE_KIND}-${key}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: SOURCE_KIND, form: SOURCE_FORM, summary, key },
      })

      const claimed = Array.isArray(decision.messages) ? decision.messages : []
      if (claimed.some((message) => sameContent(message, desired))) return decision

      // 先登记再注入：首轮走 inbox 分支时消息要到下一轮才进日志，
      // 不先登记就会重复注入。
      state.injectedKeys.add(key)
      debug(`inject: ${key} turn=${turns} step=${step} claimed=${claimed.length} inboxPath=${claimed.length === 0 && step === 1}`)
      try {
        ctx?.logger?.debug?.(`${name}: injected ${key}`)
      } catch {
        // 忽略日志故障。
      }

      if (claimed.length === 0 && step === 1) {
        // 首轮请求：harness 从 agent inbox 组装历史，交给 inbox 而不是 step decision。
        try {
          const inbox = agent?.inbox
          if (inbox !== undefined && Array.isArray(inbox.nextStep)) {
            const mine = inbox.nextStep.filter((message) => message?.source?.kind === SOURCE_KIND)
            const reusable = mine.find((message) => sameContent(message, desired))
            if (reusable !== undefined) {
              for (const message of mine) if (message !== reusable) inbox.remove(message.id)
              return decision
            }
            const replaced = mine[0]
            if (replaced === undefined) inbox.prepend('next-step', desired)
            else inbox.replace(replaced.id, desired)
            for (const message of mine.slice(1)) inbox.remove(message.id)
            return decision
          }
        } catch (error) {
          warnOnce(error)
        }
      }

      const claimedIndex = Array.isArray(messages)
        ? claimed.findLastIndex((message) => messages.includes(message))
        : -1
      const entered = claimed.slice()
      entered.splice(claimedIndex + 1, 0, desired)
      return { ...decision, messages: entered }
    } catch (error) {
      warnOnce(error)
      return decision
    }
  })
}

/** 供单测复用的纯函数导出（harness 只使用 `name` / `apply`）。 */
export const __internals = {
  DEFAULTS,
  TIER_RANK,
  SOURCE_KIND,
  NOTICE_MARKER,
  resolveConfig,
  tierOf,
  fold,
  stateFor,
  renderText,
  dayKey,
  kilo,
}
