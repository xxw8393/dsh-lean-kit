/**
 * context-diet — fold OLD tool results on the session surface into a short
 * head/tail summary, so every later step stops re-sending them.
 *
 * WHY: an agent step re-sends the whole surface. Measured on this machine
 * (71 session logs, 991M cumulative input tokens): the surface of a long
 * session is ~70% accumulated `tool/result` text (405KB of a 147k-token
 * request in the worst case). DSH already ships
 * `@deepseek-ai/dsh-compaction-tool-result-pruner`, but it only runs *at the
 * compaction threshold* (~240k here) and only trims the middle of results
 * larger than `thresholdChars`. Between 0 and 240k nothing trims, so old
 * output is re-sent hundreds of times. This plugin closes that gap: it folds
 * aged-out results continuously, far below the compaction threshold, and
 * touches nothing the model is still working with.
 *
 * Behavior:
 *  - On every `agent/pre-step`, walks the current surface and takes the
 *    `tool/result` nodes *older* than the newest `keepRecent` of them.
 *  - Skips nodes whose text is at most `minChars` (cheap, still readable).
 *  - Rewrites the rest to `headChars` head + a marker + `tailChars` tail,
 *    using the harness's own replacement protocol (a `compaction/prune`
 *    shadow-price event followed by a `tool/result` node that replaces the
 *    old seq) — the same sequence `dsh-compaction-tool-result-pruner` uses.
 *  - Idempotent: the folded size is below `minChars`, so a replacement is
 *    never folded again. Tool-call/result pairing and `toolCallId` survive
 *    untouched; only `content` changes.
 *  - Fails soft: any error (including a session that refuses the replacement)
 *    is logged once and disables the plugin for that session; it can never
 *    break a turn.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'context-diet'

/** Defaults; every key is overridable from the profile patch config. */
const DEFAULTS = Object.freeze({
	enabled: true,
	/** How many of the newest tool results stay untouched. */
	keepRecent: 15,
	/** Fold only results whose text is longer than this (code points). */
	minChars: 500,
	/** Characters kept from the head of a folded result. */
	headChars: 200,
	/** Characters kept from the tail of a folded result. */
	tailChars: 120,
	/** Skip the whole pass below this measured surface size (0 = no gate). */
	triggerTokens: 20000,
	/** Optional diagnostic log; empty string means "logger only". */
	debugFile: '',
})

/** Expand a leading `~` so the patch can use `~/.dsh/...` on any machine. */
function expandHome(path) {
	if (typeof path !== 'string' || !path.startsWith('~')) return path
	return `${process.env.HOME ?? ''}${path.slice(1)}`
}

const CONFIG_KEYS = new Set(Object.keys(DEFAULTS))

/** Resolve and validate plugin configuration. */
export function resolveConfig(config = {}) {
	for (const key of Object.keys(config)) {
		if (!CONFIG_KEYS.has(key)) throw new Error(`context-diet: unknown config key "${key}" (allowed: ${[...CONFIG_KEYS].join(', ')})`)
	}
	const resolved = {
		enabled: config.enabled ?? DEFAULTS.enabled,
		keepRecent: config.keepRecent ?? DEFAULTS.keepRecent,
		minChars: config.minChars ?? DEFAULTS.minChars,
		headChars: config.headChars ?? DEFAULTS.headChars,
		tailChars: config.tailChars ?? DEFAULTS.tailChars,
		triggerTokens: config.triggerTokens ?? DEFAULTS.triggerTokens,
		debugFile: expandHome(config.debugFile ?? DEFAULTS.debugFile),
	}
	for (const key of ['keepRecent', 'minChars', 'headChars', 'tailChars', 'triggerTokens']) {
		const value = resolved[key]
		if (!Number.isInteger(value) || value < 0) throw new Error(`context-diet: ${key} must be a non-negative integer`)
	}
	if (resolved.headChars + resolved.tailChars >= resolved.minChars) {
		throw new Error('context-diet: headChars + tailChars must be smaller than minChars, or folding would not shrink a result')
	}
	if (typeof resolved.enabled !== 'boolean') throw new Error('context-diet: enabled must be a boolean')
	if (typeof resolved.debugFile !== 'string') throw new Error('context-diet: debugFile must be a string')
	return resolved
}

/** Text of one message's content blocks, in order (non-text blocks cost zero). */
export function textOf(message) {
	let text = ''
	for (const block of message?.content ?? []) if (block?.type === 'text' && typeof block.text === 'string') text += block.text
	return text
}

/** Count Unicode code points, never splitting a surrogate pair. */
function points(value) {
	return Array.from(value)
}

/** Marker inserted where the removed middle used to be. */
function marker(removedChars, totalChars) {
	return `\n\n[... context-diet：此处省略 ${removedChars} 字符旧工具输出（原文 ${totalChars} 字符）。内容未丢失，只需重跑上面那条工具调用，或对文件用 offset/limit 分段重读 ...]\n\n`
}

/**
 * Fold one tool-result content array.
 *
 * @param blocks - original content blocks.
 * @param config - resolved configuration.
 * @returns folded content array, or `null` when the result is small enough.
 */
export function foldContent(blocks, config) {
	if (!Array.isArray(blocks)) return null
	const total = textOf({ content: blocks })
	if (points(total).length <= config.minChars) return null
	const head = points(total).slice(0, config.headChars).join('')
	const tail = config.tailChars === 0 ? '' : points(total).slice(-config.tailChars).join('')
	const removed = points(total).length - points(head).length - points(tail).length
	const preserved = blocks.filter((block) => block?.type !== 'text')
	return [{ type: 'text', text: head + marker(removed, points(total).length) + tail }, ...preserved]
}

/**
 * Pick the tool-result nodes this pass should fold, oldest first.
 *
 * @param session - session whose surface is inspected.
 * @param keepRecent - how many newest tool results to leave alone.
 * @returns surface seqs with their events, excluding the recent window.
 */
export function collectFoldable(session, keepRecent) {
	const found = []
	for (const seq of [...session.surface.nodes]) {
		const event = session.eventAt(seq)
		if (event?.type === 'tool/result') found.push({ seq, event })
	}
	const cut = Math.max(0, found.length - keepRecent)
	return found.slice(0, cut)
}

/** Deep-freeze one replacement message, mirroring the harness's own messages. */
function frozen(message) {
	const freeze = (value) => {
		if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
		for (const child of Array.isArray(value) ? value : Object.values(value)) freeze(child)
		return Object.freeze(value)
	}
	return freeze(message)
}

/**
 * Run one fold pass over a session.
 *
 * @param session - session whose surface is rewritten.
 * @param options - `{config, meter, log}`; meter is optional.
 * @returns `{folded, charsRemoved}`.
 */
export function runPass(session, options) {
	const { config, meter, log } = options
	if (config.triggerTokens > 0 && meter !== undefined) {
		const measured = meter.measure?.(session)
		const total = measured?.totalTokens
		if (typeof total === 'number' && total < config.triggerTokens) return { folded: 0, charsRemoved: 0, skipped: 'below-threshold' }
	}
	let folded = 0
	let charsRemoved = 0
	for (const { seq, event } of collectFoldable(session, config.keepRecent)) {
		const original = session.deriveEventMessage(event)
		const content = foldContent(original?.content, config)
		if (content === null) continue
		const before = points(textOf(original)).length
		const after = points(textOf({ content })).length
		const message = frozen({ ...original, content })
		session.append(
			'compaction/prune',
			{ shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: meter?.estimateMessage?.(original) ?? Math.ceil(before / 3.7) },
		)
		session.append('tool/result', { ...event.data, message }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
		folded += 1
		charsRemoved += before - after
	}
	if (folded > 0) log?.(`folded ${folded} tool result(s), removed ${charsRemoved} chars`)
	return { folded, charsRemoved }
}

/** Cordis plugin entry point. */
export function apply(ctx, config = {}) {
	const resolved = resolveConfig(config)
	if (!resolved.enabled) {
		ctx.logger?.info?.('context-diet: disabled by config')
		return
	}
	ctx.logger?.info?.(`context-diet: enabled (keepRecent ${resolved.keepRecent}, >${resolved.minChars} chars -> ${resolved.headChars}+${resolved.tailChars})`)
	/** Sessions that already failed once; they stay untouched for this process. */
	const broken = new WeakSet()
	const debug = (line) => {
		const text = `[${new Date().toISOString()}] ${line}`
		ctx.logger?.info?.(`context-diet: ${line}`)
		if (resolved.debugFile === '') return
		void import('node:fs/promises').then((fs) => fs.appendFile(resolved.debugFile, `${text}\n`)).catch(() => {})
	}
	ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
		const session = agent?.session
		if (session !== undefined && !broken.has(session) && signal?.aborted !== true) {
			try {
				const result = runPass(session, { config: resolved, meter: ctx.get?.('tokenMeter'), log: debug })
				if (result.folded > 0) debug(`surface=${session.surface.nodes.length} nodes, folded=${result.folded}, removed=${result.charsRemoved} chars`)
			} catch (error) {
				broken.add(session)
				debug(`disabled for this session after an error: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		return next()
	})
}

/** Test seam; the loader only consumes `name` / `apply`. */
export const __internals = { DEFAULTS, CONFIG_KEYS, resolveConfig, textOf, foldContent, collectFoldable, runPass }
