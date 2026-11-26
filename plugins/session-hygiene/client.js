/**
 * session-hygiene · 浏览器半边（classic script，经 `/plugins/dsh-session-hygiene/client.js` 下发）
 *
 * WHY: 「切换会话」是浏览器侧动作。宿主半边（`index.mjs`）能把提醒注入会话，但宿主→浏览器
 * 没有通用推送通道（`dsh-api-remotes` 的转发白名单是编译期固定的），浏览器也不会因为
 * 宿主新建了会话就自己跳过去。所以「提醒 → 我确认 → 直接切到新会话」必须在这里完成：
 * 读当前会话事件流里那条 `source.kind === 'session-hygiene'` 的提醒 → 弹一条常驻确认条
 * → 用户点「切换并继续」→ **先让旧会话把 handoff 落盘**（下面「交接轮」）→ `sessions.create`
 *   + `uiWorkspace.openSession` + 把 handoff 路径与下一步转交给新会话（首句）。
 * → 并让新会话**继承旧会话标题**（`ctx.sessions.rename`，旧标题 `… N` → `… N+1`）；rename 不可用时
 *   由首句 `继续会话｜<新标题>` 兜底（宿主标题 LLM 会据此起同主题标题）。否则续接会话全叫
 *   「继续会话」，在会话列表里必然认错任务（2026-10-15 实际踩过）。
 *
 * 交接轮（2026-10-28）：点「切换并继续」不再只是丢一句「继续会话」——
 *   1. 先向**旧会话**发一条落盘指令（`handoffInstruction`），等它这一轮跑完；
 *   2. 从它最后一条 assistant 文本里读机器标记 `HANDOFF:/MODE:/NEXT:`
 *      （模型没按标记给路径时退化为正文里捞 `.dsh/handoff/**.md`）；
 *   3. 新会话首句按 MODE 分三种写法（`composeFirstPrompt`）：
 *      continue → `继续会话｜…` + `handoff: <路径>` + `下一步`；
 *      wait     → 「会话交接（无未完任务）」+ 只读文件后等新任务，**不**用「继续会话」开头
 *                 （那句会命中 session-handoff-resume 规则，把新会话拖去执行假想任务）；
 *      未落盘   → `继续会话｜…` + 「交接没能自动落盘」+ 旧会话最后一句人类请求，让新会话先确认再动。
 *
 * 契约（与宿主半边共享，改一边必须改另一边）：
 *   - 提醒消息：`user/message` 事件，`data.source = { kind:'session-hygiene', form:'notice', summary, key }`；
 *     `key` 形如 `warn#3`（`tier#turnBucket`），是「忽略」的作用域；退化识别用文本标记
 *     `session-hygiene 插件自动注入`（见 index.mjs 的 NOTICE_MARKER）。
 *   - 交接标记：`HANDOFF: <路径>` / `MODE: continue|wait` / `NEXT: <一句话>`（`index.mjs` 的注入文本要求同三行）。
 *   - 只对**当前主会话**生效；子代理会话不算。
 *   - 「继续会话」的第一句触发 session-handoff-resume 规则 → 读 `.dsh/handoff/LATEST.md` 续做。
 *
 * 只 require 平台静态 seed 词（react / primitives），不需要 `dsh.client.external`。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-hygiene',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement
    const { Toast, IconWarningOutlineRegular } = primitives

    /** 宿主半边注入消息的来源标识（与 index.mjs 的 SOURCE_KIND 一致）。 */
    const SOURCE_KIND = 'session-hygiene'
    /** 退化识别标记（与 index.mjs 的 NOTICE_MARKER 一致）。 */
    const TEXT_MARKER = 'session-hygiene 插件自动注入'
    /** 新会话第一条消息：固定短语，命中 user-global 的 session-handoff-resume 规则。 */
    const FIRST_PROMPT = '继续会话'
    /** 交接轮：等旧会话写 handoff 的最长时长（超时不再阻塞切换，用退化首句）。 */
    const HANDOFF_TIMEOUT_MS = 90_000
    /** 交接轮：prompt 发出后 `running` 一直没翻真的宽限（说明这一轮没起来，别干等）。 */
    const HANDOFF_START_GRACE_MS = 6_000
    /** 交接轮：turn 结束后再等一小会，让最后一条 assistant 事件落盘。 */
    const HANDOFF_SETTLE_MS = 400
    /** 旧会话最后一句人类请求带进新会话的长度上限（只作锚点，不当上下文）。 */
    const HINT_MAX_CHARS = 120
    /** NEXT 进首句的长度上限：首屏只留一句任务，长出的事让新会话读 handoff。 */
    const NEXT_MAX_CHARS = 80
    /** 交接末三行的机器标记（与 index.mjs 注入文本要求的格式一致）。 */
    const HANDOFF_MARK_RE = /^\s*HANDOFF\s*[:：]\s*([^\n]+)$/im
    const MODE_MARK_RE = /^\s*MODE\s*[:：]\s*(continue|wait)\b/im
    const NEXT_MARK_RE = /^\s*NEXT\s*[:：]\s*([^\n]+)$/im
    /** 模型没按标记给路径时，从回复正文里捞 `.dsh/handoff/**.md`。 */
    const HANDOFF_PATH_RE = /([^\s`'"()]*\.dsh\/handoff\/[^\s`'"()]*\.md)/i
    /** 「没有未完任务」的措辞特征：MODE 缺失时用它从 NEXT 推断。 */
    const NO_TASK_RE = /无(未完)?任务|没有待办|等待新任务|无待续/
    /** 「忽略」的记忆前缀（localStorage，按会话隔离）。 */
    const DISMISS_PREFIX = 'dsh-session-hygiene:dismissed:'
    /** 最近一次「切换并继续」的继承留痕（localStorage 单键覆盖，供误接续时定位）。 */
    const INHERIT_KEY = 'dsh-session-hygiene:last-inherit'
    /** 确认条常驻时长（确认条本身不该自己消失，由用户处理）。 */
    const BAR_HOLD_MS = 24 * 60 * 60 * 1000
    /** 泛化标题（旧会话本身就叫「继续会话」）不继承，避免把噪音传给下一号。 */
    const GENERIC_TITLE_RE = /^继续(会话|上次)?([\s·]+\d+)?$/

    /**
     * 旧标题 → 续接会话标题：形如 `… 2` 则递增，否则追加 ` 2`；
     * 旧标题缺失或是泛化短语时返回 null（调用方退回无标题路径）。
     */
    function nextTitle(prev) {
      const t = typeof prev === 'string' ? prev.trim() : ''
      if (t === '' || GENERIC_TITLE_RE.test(t)) return null
      const m = /^(.*?)[\s·]+(\d+)$/.exec(t)
      if (m !== null && m[1].trim() !== '') return `${m[1].trim()} ${Number(m[2]) + 1}`
      return `${t} 2`
    }

    /** 空白折叠成单行（prompt 的锚点行必须是一行，不然第一句会被 history 截断成多行）。 */
    function oneLine(value, maxChars) {
      const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
      return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
    }

    /** 截断到上限并尽量落在分句边界：避免把 `（ComposeComponentHost.ets:105、…）` 切成半截括号。 */
    function clipTask(value) {
      const text = oneLine(value, NEXT_MAX_CHARS * 2)
      if (text.length <= NEXT_MAX_CHARS) return text
      const head = text.slice(0, NEXT_MAX_CHARS)
      const cut = Math.max(head.lastIndexOf('；'), head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf(' '))
      const kept = (cut > NEXT_MAX_CHARS / 2 ? head.slice(0, cut) : head).replace(/[（(，、；\s]+$/, '')
      const opened = (kept.match(/（/g) ?? []).length - (kept.match(/）/g) ?? []).length
      return `${kept}${opened > 0 ? '）'.repeat(opened) : ''}…`
    }

    /** 去掉模型爱加的引号/反引号/尖括号、行尾注释与句末标点；不像 `.md` 路径则返回 null。 */
    function cleanPath(value) {
      if (typeof value !== 'string') return null
      // 只取第一个「像路径」的 token：模型常在路径后面跟一句说明（「，新会话继续」）。
      const trimmed = value
        .replace(/[`'"<>]/g, '')
        .split(/[\s，。；、]+/)[0]
        .split('（')[0]
        .trim()
        .replace(/[,:：]+$/, '')
      return trimmed.includes('.md') ? trimmed : null
    }

    /** 正则的第一个捕获组（不匹配返回 null）。 */
    function capture(re, text) {
      const m = re.exec(typeof text === 'string' ? text : '')
      return m === null ? null : m[1].trim()
    }

    /**
     * 交接轮的落盘指令：明确「下一步」必须写在文末、没有待办就写明等新任务，
     * 并要求回复末三行机器标记（旧会话模型与宿主注入文本用同一套标记）。
     */
    function handoffInstruction(title) {
      const topic = typeof title === 'string' && title.trim() !== '' ? `（记录键=会话标题「${title.trim()}」）` : ''
      return [
        '【会话卫生 · 交接】正在记录本会话状态并转交新会话；只做这一步，不要探索仓库、不要执行其它任务：',
        `1. 按 session-handoff skill / AGENTS.md §6 落盘 handoff${topic}；本会话近期已写过就复用那篇并给出它的路径。`,
        '2. 文末最后一段必须是「下一步」（新会话照它执行）：还有待办→写可执行步骤（文件:行号、验收）；没有待办（只是本会话到期）→ 明写「无未完任务：新会话不要执行任何任务，只等待用户输入新任务」。',
        '3. 回复只给下面三行，不要复述交接正文、不要再总结或解释：',
        'HANDOFF: <handoff 绝对路径>',
        'MODE: continue 或 wait',
        'NEXT: <一句话任务；wait 时写「等待新任务」>',
      ].join('\n')
    }

    /**
     * 解析旧会话回复里的交接标记。
     * @returns `{ path, mode, next }`：mode 缺失时用 NEXT 的措辞推断，仍不确定则 null。
     */
    function parseHandoff(text) {
      const marker = capture(HANDOFF_MARK_RE, text)
      const loose = capture(HANDOFF_PATH_RE, text)
      const path = cleanPath(marker ?? loose)
      const mode = (capture(MODE_MARK_RE, text) ?? '').toLowerCase()
      const rawNext = capture(NEXT_MARK_RE, text)
      const next = rawNext === null ? null : clipTask(rawNext)
      const inferred =
        mode === 'continue' || mode === 'wait'
          ? mode
          : next !== null
            ? (NO_TASK_RE.test(next) ? 'wait' : 'continue')
            : null
      return { path, mode: inferred, next }
    }

    /**
     * 新会话第一句。
     * @param info - `{ title, path, mode, next, hint, lastReply }`（path 为 null 表示交接没落盘）。
     *
     * 三种写法与「交接轮」一一对应；wait 分支刻意**不用**「继续会话」开头 ——
     * 那句会命中 session-handoff-resume 规则，让新会话去执行一个并不存在的任务。
     */
    function composeFirstPrompt(info) {
      const title = info?.title ?? null
      const named = title === null || title === undefined ? '' : `｜${title}`
      const path = typeof info?.path === 'string' && info.path.length > 0 ? info.path : null
      const next = typeof info?.next === 'string' ? clipTask(info.next) : ''
      const hint = typeof info?.hint === 'string' ? info.hint.trim() : ''
      const lastReply = typeof info?.lastReply === 'string' ? info.lastReply.trim() : ''
      if (info?.mode === 'wait') {
        return [
          `会话交接${named}（没有未完任务）`,
          path === null ? '' : `handoff: ${path}`,
          path === null
            ? '先看 .dsh/handoff/LATEST.md 末尾的「下一步」，确认无未完任务后只回一行「已读交接，等待新任务」，不要执行任何任务。'
            : '只看上面这份 handoff 末尾的「下一步」，确认「无未完任务」后只回一行「已读交接，等待新任务」，不要执行任何任务。',
        ]
          .filter((line) => line.length > 0)
          .join('\n')
      }
      if (path === null) {
        return [
          `${FIRST_PROMPT}${named}`,
          '上一会话的交接没能自动落盘：先看 .dsh/handoff/LATEST.md；与本任务无关就用一句话问我要做什么，不要自行开工。',
          hint.length === 0 ? '' : `上一会话最后的请求（仅供参考）：${hint}`,
          lastReply.length === 0 ? '' : `上一会话最后一条回复（截断，仅供参考）：${lastReply}`,
        ]
          .filter((line) => line.length > 0)
          .join('\n')
      }
      return [
        `${FIRST_PROMPT}${named}`,
        `handoff: ${path}`,
        '读它末尾「下一步」直接做（不要复述 handoff、不要先给计划）；若写的是「无未完任务」，只回一行「已读交接，等待新任务」，不要执行任何任务。',
        next.length === 0 ? '' : `一句话任务：${next}`,
      ]
        .filter((line) => line.length > 0)
        .join('\n')
    }


    /** 依赖的客户端 cordis 服务。 */
    const inject = ['slots', 'sessions', 'uiSession', 'uiWorkspace', 'workspaces']

    /** 一条消息的正文文本（content 里所有 text 块拼接；兼容 `message.content` 形状）。 */
    function textOf(data) {
      const content = data?.content ?? data?.message?.content
      if (!Array.isArray(content)) return ''
      let text = ''
      for (const block of content) if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') text += block.text
      return text
    }

    /** 会话事件窗口（取不到返回空数组，永不抛）。 */
    function entriesOf(session) {
      try {
        const entries = session?.eventSource?.getSnapshot?.().entries
        return Array.isArray(entries) ? entries : []
      } catch {
        return []
      }
    }

    /** 一条 assistant 事件的正文（`data.content` 为主，`data.text` 兜底）。 */
    function assistantTextOf(event) {
      const data = event?.data
      if (data === null || typeof data !== 'object') return ''
      const text = textOf(data)
      if (text.length > 0) return text
      return typeof data.text === 'string' ? data.text : ''
    }

    /** 快照条目有两种形状：`{type:'event', event}` 与裸事件；统一取出事件对象。 */
    function eventOf(entry) {
      if (entry === null || typeof entry !== 'object') return null
      if (entry.type === 'event' && entry.event !== null && typeof entry.event === 'object') return entry.event
      return typeof entry.type === 'string' ? entry : null
    }

    /** 窗口里 assistant 消息的条数（交接轮用它判断「我这一轮有没有产出」）。 */
    function assistantCount(entries) {
      if (!Array.isArray(entries)) return 0
      let count = 0
      for (const entry of entries) if (eventOf(entry)?.type === 'assistant/message') count += 1
      return count
    }

    /** 窗口里最后一条 assistant 正文（倒序找，不遍历全文）。 */
    function lastAssistantText(entries) {
      if (!Array.isArray(entries)) return ''
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const event = eventOf(entries[index])
        if (event?.type !== 'assistant/message') continue
        const text = assistantTextOf(event)
        if (text.length > 0) return text
      }
      return ''
    }

    /**
     * 交接回复所在的 assistant 文本：一轮里可能有多条 assistant 消息，
     * 优先取**末尾带 `HANDOFF:` 标记**的那条，找不到才退回到最后一条。
     */
    function handoffText(entries) {
      if (!Array.isArray(entries)) return ''
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const event = eventOf(entries[index])
        if (event?.type !== 'assistant/message') continue
        const text = assistantTextOf(event)
        if (text.length === 0) continue
        if (HANDOFF_MARK_RE.test(text) || MODE_MARK_RE.test(text) || HANDOFF_PATH_RE.test(text)) return text
      }
      return lastAssistantText(entries)
    }

    /** 窗口里最后一条人类请求（只认 `source.kind === 'user'`，插件注入不算）。 */
    function lastHumanText(entries) {
      if (!Array.isArray(entries)) return ''
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const event = eventOf(entries[index])
        if (event?.type !== 'user/message') continue
        const data = event.data
        if (data === null || typeof data !== 'object') continue
        const kind = data.source !== null && typeof data.source === 'object' ? data.source.kind : undefined
        if (kind !== undefined && kind !== 'user') continue
        const text = oneLine(textOf(data), HINT_MAX_CHARS)
        if (text.length > 0) return text
      }
      return ''
    }

    /**
     * 事件窗口里**最新**一条会话卫生提醒。
     * @param entries - `session.eventSource.getSnapshot().entries`。
     * @returns `{ key, summary }`，没有则 null。
     */
    function noticeOf(entries) {
      if (!Array.isArray(entries)) return null
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]
        if (entry === null || typeof entry !== 'object' || entry.type !== 'event') continue
        const event = entry.event
        if (event === null || typeof event !== 'object' || event.type !== 'user/message') continue
        const data = event.data
        if (data === null || typeof data !== 'object') continue
        const source = data.source !== null && typeof data.source === 'object' ? data.source : {}
        const key = typeof source.key === 'string' && source.key.length > 0 ? source.key : undefined
        const summary = typeof source.summary === 'string' ? source.summary : ''
        if (source.kind === SOURCE_KIND) return { key: key ?? `seq@${String(event.seq)}`, summary }
        // 退化路径：来源字段被链路剥掉时，按注入文本里的稳定标记识别。
        if (textOf(data).includes(TEXT_MARKER)) return { key: key ?? `text@${String(event.seq)}`, summary }
      }
      return null
    }

    /**
     * 从列表快照里取宿主持久标题：兼容 `byId`（真实形状）与 `items`（降级形状）。
     * 纯函数（工厂作用域，供 `apply` 与 selftest 复用）。
     * @param snapshot - `sessions.list.getSnapshot()` / `manager.getListSnapshot()` 的返回。
     * @param sessionId - 目标会话。
     * @returns 非空标题文本，取不到为 null（不抛）。
     */
    function titleFromSnapshot(snapshot, sessionId) {
      const rows = Array.isArray(snapshot?.items) ? snapshot.items : []
      const row = snapshot?.byId?.[sessionId] ?? rows.find((entry) => entry?.sessionId === sessionId)
      const title = row?.title
      return typeof title === 'string' && title.trim() !== '' ? title.trim() : null
    }

    /** 该会话已被「忽略」的提醒 key 集合。 */
    function readDismissed(sessionId) {
      try {
        const raw = window.localStorage.getItem(DISMISS_PREFIX + sessionId)
        const parsed = raw === null ? [] : JSON.parse(raw)
        return new Set(Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [])
      } catch {
        return new Set()
      }
    }

    /** 记住「忽略」，只保留最近 50 条，避免无限增长。 */
    function addDismissed(sessionId, key) {
      try {
        const keys = readDismissed(sessionId)
        keys.add(key)
        window.localStorage.setItem(DISMISS_PREFIX + sessionId, JSON.stringify([...keys].slice(-50)))
      } catch {
        // 存不下就只是下次还会提醒，不影响功能。
      }
    }

    /** 续接决定留痕：旧标题读到没有、继承成什么、有没有改名成功。 */
    function noteInherit(entry) {
      try {
        window.localStorage.setItem(INHERIT_KEY, JSON.stringify(entry))
      } catch {
        // 存储不可用不影响切换。
      }
    }

    /** 错误对象 → 一行短文本。 */
    function messageOf(error) {
      if (error === null || error === undefined) return '未知错误'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message.length > 0) return error.message
      return String(error)
    }

    /** 路径的文件名（flash 里只贴最后一段，路径太长会撑爆提示条）。 */
    function baseNameOf(path) {
      const text = typeof path === 'string' ? path.replace(/[\\/]+$/, '') : ''
      const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
      return index < 0 ? text : text.slice(index + 1)
    }

    /** 简短休眠（等新会话的 binding 就绪）。 */
    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    /** 注册确认条与检测逻辑。 */
    function apply(ctx) {
      /** 当前视图状态：`{ bar, flash }`，整体替换以驱动 React 重渲染。 */
      let state = { bar: null, flash: null }
      let flashSeq = 0
      /** 切换动作进行中（禁止重复点击）。 */
      let busy = false
      /**
       * 确认条所处阶段：`idle`（等待用户决定）→ `handoff`（旧会话正在写交接）→ `switching`（建会话/切视图）。
       * 开关切换轮要几十秒，期间必须让条子显示进度、隐藏按钮，否则用户会重复点。
       */
      let phase = 'idle'
      /** 交接轮点「跳过」时置真：不再等模型写完，直接按退化首句切换。 */
      let skipHandoff = false
      /** 本轮未收尾时点了交接：记住意图，收尾后自动执行（保证「一次点击」）。 */
      let pendingSwitch = false
      /** 当前绑定的会话事件源解绑函数。 */
      let detach = null

      const listeners = new Set()
      const publish = () => {
        for (const listener of [...listeners]) listener()
      }
      const emit = (patch) => {
        state = { ...state, ...patch }
        publish()
      }
      const flash = (text, tone) => {
        flashSeq += 1
        emit({ flash: { id: flashSeq, text, tone } })
      }

      /** 当前主会话 id（无会话时 undefined）。 */
      const currentSessionId = () => ctx.uiSession.current.getSnapshot()?.key

      /** 当前会话所属 workspace id（找不到则 undefined，退化为默认 cwd 新建）。 */
      const workspaceOf = (sessionId) => {
        try {
          const list = ctx.workspaces.list.getSnapshot()
          const hit = Array.isArray(list?.items) ? list.items.find((item) => Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId)) : undefined
          return hit === undefined ? undefined : hit.workspaceId
        } catch {
          return undefined
        }
      }

      /** 提醒摘要 → 确认条文案。`session-hygiene alarm: turn 42, 输入 ≈ 150k tokens` */
      const barText = (bar) => {
        const matched = /^session-hygiene\s+(\S+):\s*(.*)$/.exec(bar.summary ?? '')
        const tier = matched === null ? '' : `（${matched[1]}）`
        const evidence = matched === null || matched[2].length === 0 ? '本会话历史已到交接阈值' : matched[2]
        if (bar.phase === 'handoff') return '正在让当前会话写 handoff（完成后自动切到新会话）…'
        if (bar.phase === 'switching') return '正在新建会话并切换…'
        if (bar.running) return `${evidence}${tier} · 本轮结束后可一键交接`
        return `${evidence}${tier} · 交接到新会话并继续？（先写 handoff 再切）`
      }

      /** 重新绑定当前会话的事件流（会话切换 / 首次挂载时调用），并在每次窗口变化时重扫提醒。 */
      function rebind() {
        // 换了会话就别再执行别的会话里记下的交接意图。
        pendingSwitch = false
        if (detach !== null) {
          try {
            detach()
          } catch {
            // 解绑失败不影响重绑。
          }
          detach = null
        }
        const sessionId = currentSessionId()
        if (typeof sessionId !== 'string') {
          emit({ bar: null })
          return
        }
        const session = ctx.sessions.binding(sessionId)?.session
        if (session === undefined || session === null) {
          emit({ bar: null })
          return
        }
        const rescan = () => {
          let notice = null
          try {
            notice = noticeOf(session.eventSource.getSnapshot().entries)
          } catch {
            notice = null
          }
          if (notice === null || readDismissed(sessionId).has(notice.key)) {
            emit({ bar: null })
            return
          }
          let running = false
          try {
            running = session.getSnapshot()?.running === true
          } catch {
            running = false
          }
          emit({
            bar: {
              sessionId,
              key: notice.key,
              summary: notice.summary,
              running,
              phase: busy ? phase : 'idle',
            },
          })
          // 上次点击因「本轮未收尾」被记住的意图：收尾后自动接着切，不必再点。
          if (pendingSwitch && !running && !busy) {
            pendingSwitch = false
            setTimeout(() => {
              void confirmSwitch(true)
            }, 0)
          }
        }
        const offEntries = session.eventSource.subscribe(rescan)
        const offSession = session.subscribe(rescan)
        detach = () => {
          offEntries()
          offSession()
        }
        rescan()
      }

      /**
       * 读旧会话标题。真实契约：`ClientSessions.list` 是列表投影快照店，
       * `list.getSnapshot().byId[id].title` 才是宿主持久标题（无标题的会话该键缺失）。
       *
       * WHY 改写：旧实现读 `sessions.get(id)`，而 `ClientSessions` 上没有 `get`
       * （只有 list/manager/scope/binding/search），于是恒为 null → 首句退化成裸
       * 「继续会话」→ 新会话标题泛化 → 跨会话续接丢主题（2026-10-15 误接续事故）。
       * 依次尝试 list 投影、manager 原始列表、旧形状，全失败返回 null（不抛）。
       */
      function titleOf(sessionId) {
        const readers = [
          () => titleFromSnapshot(ctx.sessions?.list?.getSnapshot?.(), sessionId),
          () => titleFromSnapshot(ctx.sessions?.manager?.getListSnapshot?.(), sessionId),
          () => {
            const title = ctx.sessions?.get?.(sessionId)?.title
            return typeof title === 'string' && title.trim() !== '' ? title.trim() : null
          },
        ]
        for (const read of readers) {
          try {
            const found = read()
            if (found !== null && found !== undefined) return found
          } catch (error) {
            // 形状不符：换下一种读法。
          }
        }
        return null
      }

      /**
       * 精确改名。真实契约：`sessions.rename(sessionId, title)` → `{ ok, value:{ title, seq } }`
       * （**位置参数**；旧实现先试对象形式，永远打不中，只能靠首句兜底）。
       * 先按位置参数调用，再退对象形式；都失败返回 false。
       */
      async function tryRename(sessionId, title) {
        const service = ctx.sessions
        const fn = service?.rename
        if (typeof fn !== 'function') return false
        for (const args of [[sessionId, title], [{ sessionId, title }]]) {
          try {
            const result = await fn.apply(service, args)
            if (result !== null && typeof result === 'object' && result.ok === false) continue
            return true
          } catch (error) {
            // 形状不符：换下一种调用方式。
          }
        }
        return false
      }

      /** 等 binding 就绪后发一条消息（默认「继续会话」）。 */
      async function promptSession(sessionId, text = FIRST_PROMPT) {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const session = ctx.sessions.binding(sessionId)?.session
          if (session !== undefined && session !== null) {
            const result = await session.prompt([{ type: 'text', text }], 'queue')
            if (result !== null && typeof result === 'object' && result.ok === false) throw new Error(messageOf(result.error))
            return true
          }
          await sleep(50)
        }
        return false
      }

      /**
       * 等旧会话把交接这一轮跑完。
       * 三种收尾任一条即返回：`running` 由真转假、assistant 消息数增加、或超时。
       * 先给 `HANDOFF_START_GRACE_MS` 宽限等 `running` 翻真 —— 模型可能 1 秒内就写完，
       * 探针看不到 running 时靠「assistant 条数增加」这条退路收尾，避免白等 90 秒。
       * @returns 是否确认这一轮跑完（false=超时/取不到快照，调用方照旧去读现有文本）。
       */
      async function waitTurn(session, baseline, timeoutMs) {
        const started = Date.now()
        let seen = false
        while (Date.now() - started < timeoutMs) {
          if (skipHandoff) return false
          let running = false
          let entries = []
          try {
            running = session.getSnapshot()?.running === true
            entries = session.eventSource.getSnapshot().entries
          } catch {
            return false
          }
          if (running) seen = true
          else if (seen || assistantCount(entries) > baseline) return true
          else if (Date.now() - started > HANDOFF_START_GRACE_MS) return false
          await sleep(200)
        }
        return false
      }

      /**
       * 交接轮：让旧会话把 handoff 落盘，再从它最后一条回复里解析标记。
       * 失败只降级（返回空 `path`），不阻断切换 —— 用户点的是「切走」，交接是尽力而为。
       * @returns `{ path, mode, next, text }`。
       */
      async function writeHandoff(session, title) {
        // 快路径：触发确认条的那条回复里通常已经有 HANDOFF/MODE/NEXT 三行（模型刚写完），
        // 直接复用即可零等待切换。否则就得发一条 queue 指令让旧会话补写，而旧会话已 idle 时
        // 那条指令要等下一轮调度（实测等满宽限），用户看到的就是「点了没反应、还要再点一次」。
        const current = handoffText(entriesOf(session))
        const ready = parseHandoff(current)
        if (ready.path !== null) return { ...ready, text: current }
        const baseline = assistantCount(entriesOf(session))
        const result = await session.prompt([{ type: 'text', text: handoffInstruction(title) }], 'queue')
        if (result !== null && typeof result === 'object' && result.ok === false) throw new Error(messageOf(result.error))
        await waitTurn(session, baseline, HANDOFF_TIMEOUT_MS)
        await sleep(HANDOFF_SETTLE_MS)
        const entries = entriesOf(session)
        const text = handoffText(entries)
        return { ...parseHandoff(text), text }
      }

      /** 用户确认：先落盘交接 → 新建会话 → 切过去 → 发带 handoff 的首句 → 忽略旧会话这条提醒。 */
      async function confirmSwitch(force = false) {
        const bar = state.bar
        if (bar === null || busy) return
        if (bar.running && !force) {
          // 单次点击即生效：本轮还在收尾时只记下意图，收尾后由 rescan 自动接着切，
          // 不再要求用户点第二次（旧实现直接 return，点击被静默吞掉）。
          pendingSwitch = true
          flash('本轮结束后自动交接', 'success')
          return
        }
        pendingSwitch = false
        busy = true
        phase = 'handoff'
        skipHandoff = false
        emit({ bar: { ...bar, phase } })
        const oldTitle = titleOf(bar.sessionId)
        const oldSession = ctx.sessions.binding(bar.sessionId)?.session
        // 首句锚点要在发落盘指令**之前**取：之后最后一条 user/message 会是插件自己的指令。
        let hint = ''
        let lastReply = ''
        try {
          const entries = entriesOf(oldSession)
          hint = lastHumanText(entries)
          // 退化兜底用：交接没落盘时，把旧会话最后一条回复的截断片段也带过去。
          lastReply = oneLine(lastAssistantText(entries), HINT_MAX_CHARS)
        } catch {
          hint = ''
          lastReply = ''
        }
        let handoff = { path: null, mode: null, next: null }
        let handoffError = ''
        try {
          if (oldSession === undefined || oldSession === null || typeof oldSession.prompt !== 'function') {
            handoffError = '旧会话不可用'
          } else {
            try {
              handoff = await writeHandoff(oldSession, oldTitle)
            } catch (error) {
              handoffError = messageOf(error)
            }
          }
          phase = 'switching'
          emit({ bar: { ...bar, phase } })
          const workspaceId = workspaceOf(bar.sessionId)
          const nextName = nextTitle(oldTitle)
          const firstPrompt = composeFirstPrompt({ title: nextName, path: handoff.path, mode: handoff.mode, next: handoff.next, hint, lastReply })
          const created = await ctx.sessions.create(workspaceId === undefined ? {} : { workspaceId })
          const renamed = nextName === null ? false : await tryRename(created, nextName)
          ctx.uiWorkspace.openSession(created)
          // 新会话已建好并切过去了：首句发不出去也只降级提示，不要回滚成「切换失败」。
          let sent = false
          try {
            sent = await promptSession(created, firstPrompt)
          } catch {
            sent = false
          }
          // 交接轮本身会推进 turn，旧会话可能在这期间被注入**新的** key（桶变了）；
          // 两条都记下，否则切走后旧会话还会再冒一次确认条。
          addDismissed(bar.sessionId, bar.key)
          if (state.bar !== null && state.bar.sessionId === bar.sessionId && state.bar.key !== bar.key) addDismissed(bar.sessionId, state.bar.key)
          noteInherit({
            from: bar.sessionId,
            to: created,
            oldTitle,
            next: nextName,
            renamed,
            handoff: handoff.path,
            mode: handoff.mode,
            handoffError,
            at: Date.now(),
          })
          phase = 'idle'
          emit({ bar: null })
          // 不再静默退化：读不到/泛化标题时明说，用户可手动命名，避免下一号继续泛化（链条失效）。
          const named =
            nextName === null
              ? '（未继承标题：旧会话标题缺失或泛化，建议手动命名）'
              : renamed
                ? `（标题：${nextName}）`
                : `（标题：${nextName}，改名未生效，仅首句携带）`
          const carried =
            handoff.path === null
              ? `handoff 未落盘${handoffError.length > 0 ? `（${handoffError}）` : ''}，已让新会话先确认任务`
              : handoff.mode === 'wait'
                ? `已交接：${baseNameOf(handoff.path)}（无未完任务，新会话只等新任务）`
                : `正在继续会话：${baseNameOf(handoff.path)}${handoff.mode === null ? '（未标 MODE，按继续处理）' : ''}`
          flash(sent ? `已切到新会话${named} · ${carried}` : `已切到新会话${named} · ${carried}（未能自动发首句，请手动输入）`, sent ? 'success' : undefined)
        } catch (error) {
          phase = 'idle'
          emit({ bar: { ...bar, phase } })
          flash(`切换失败：${messageOf(error)}`, undefined)
        } finally {
          busy = false
          phase = 'idle'
        }
      }

      /** 「忽略」：本会话该档不再提醒（新档位/新桶仍会提示）。 */
      function ignore() {
        const bar = state.bar
        if (bar === null || busy) return
        addDismissed(bar.sessionId, bar.key)
        emit({ bar: null })
      }

      /** 确认条组件（挂在 shell.overlay 上；Toast 走 portal，不受覆盖层布局影响）。 */
      function HygieneBar() {
        const [current, setCurrent] = React.useState(state)
        React.useEffect(() => {
          const listener = () => setCurrent(state)
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        }, [])
        const bar = current.bar
        const currentFlash = current.flash
        const barKey = bar === null ? '' : `${bar.sessionId}|${bar.key}|${bar.running ? 'r' : 'i'}|${bar.phase}`
        const actions = []
        if (bar !== null && bar.phase === 'idle' && !bar.running) {
          actions.push({ label: '切换并继续', onClick: () => confirmSwitch() })
        }
        if (bar !== null && bar.phase === 'handoff') {
          actions.push({
            label: '跳过交接直接切换',
            onClick: () => {
              skipHandoff = true
              flash('不再等交接写完，直接切换（handoff 可能不完整）')
            },
          })
        }
        if (bar !== null && bar.phase === 'idle') actions.push({ label: '忽略', onClick: ignore })
        return h(
          React.Fragment,
          null,
          bar === null
            ? null
            : h(Toast, {
                key: `bar:${barKey}`,
                text: barText(bar),
                icon: h(IconWarningOutlineRegular, { size: 18 }),
                holdMs: BAR_HOLD_MS,
                actions,
              }),
          currentFlash === null
            ? null
            : h(Toast, {
                key: `flash:${currentFlash.id}`,
                text: currentFlash.text,
                tone: currentFlash.tone,
                onDone: () => {
                  if (state.flash !== null && state.flash.id === currentFlash.id) emit({ flash: null })
                },
              }),
        )
      }

      ctx.effect(
        () =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              {
                name: 'shell.overlay',
                id: 'session-hygiene.bar',
                order: 10,
              },
              HygieneBar,
            ),
          ),
        'session-hygiene: 交接确认条',
      )

      ctx.effect(() => {
        const offCurrent = ctx.uiSession.current.subscribe(() => rebind())
        rebind()
        return () => {
          offCurrent()
          if (detach !== null) {
            try {
              detach()
            } catch {
              // 卸载期的解绑失败无需上报。
            }
            detach = null
          }
        }
      }, 'session-hygiene: 当前会话订阅')
    }

    const exported = {}
    exported.name = 'session-hygiene-client'
    exported.inject = inject
    exported.apply = apply
    /** 供 selftest.mjs 复用的纯函数（loader 只使用 name / inject / apply）。 */
    exported.__internals = {
      SOURCE_KIND,
      TEXT_MARKER,
      FIRST_PROMPT,
      INHERIT_KEY,
      HANDOFF_TIMEOUT_MS,
      nextTitle,
      composeFirstPrompt,
      handoffInstruction,
      parseHandoff,
      lastAssistantText,
      handoffText,
      lastHumanText,
      assistantCount,
      baseNameOf,
      titleFromSnapshot,
      noticeOf,
      textOf,
    }
    return exported
  },
})