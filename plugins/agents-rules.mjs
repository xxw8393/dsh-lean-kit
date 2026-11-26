/**
 * agents-rules — inject user-global rule files (`~/.agents/rules/*.mdc`) into
 * every agent request.
 *
 * WHY: DSH's `dsh-agent-instructions` reads exactly one user-global file
 * (`$DSH_HOME/AGENTS.md`) and never interprets `@path` imports or arbitrary
 * directories, so a Claude-style `~/.agents/rules/` tree stays invisible to the
 * model. This host plugin closes that gap: it renders the rules into one
 * `<system-reminder>` user message on the first request of a session and keeps
 * it identical across steps, so the request prefix stays KV-cache stable.
 *
 * Behavior:
 *  - Reads every `*.mdc` / `*.md` file in `dir` (default `~/.agents/rules`),
 *    sorted by file name, skipping YAML frontmatter and any file whose
 *    frontmatter says `alwaysApply: false`.
 *  - Emits ONE durable user message per session; re-injected only when the
 *    rendered text changes (its identity is the SHA-1 of that text).
 *  - Fails soft: any filesystem or API error degrades to no injection and a
 *    single warning; this plugin can never break a session.
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'agents-rules'

/** Rendered text budget, in UTF-8 bytes. */
const DEFAULT_MAX_BYTES = 12288
/** Candidate file extensions, matched as suffixes. */
const DEFAULT_INCLUDE = ['.mdc', '.md']
/** Header line of the injected block. */
const DEFAULT_HEADER =
	'User-global rules (always apply). Project AGENTS.md and any more specific instruction take precedence.'
/** Message source discriminator; also used to find our own earlier messages. */
const SOURCE_KIND = 'agents-rules'
const SOURCE_FORM = 'rules'

/** Expand a leading `~`, then resolve to an absolute path. */
function expandPath(value) {
	if (value === '~') return homedir()
	if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
	return isAbsolute(value) ? value : resolve(value)
}

/** Split optional `---` YAML frontmatter from a rule body. */
function splitFrontmatter(raw) {
	const text = raw.replace(/^\uFEFF/, '')
	if (!text.startsWith('---')) return { front: '', body: text }
	const end = text.indexOf('\n---', 3)
	if (end < 0) return { front: '', body: text }
	const after = text.indexOf('\n', end + 1)
	return { front: text.slice(3, end), body: after < 0 ? '' : text.slice(after + 1) }
}

/** Read `alwaysApply` from frontmatter; absent means "apply". */
function alwaysApply(front) {
	const match = /^[ \t]*alwaysApply[ \t]*:[ \t]*(\S+)[ \t]*$/m.exec(front)
	if (match === null) return true
	return !/^(false|no|off|0)$/i.test(match[1])
}

/** Truncate to a UTF-8 byte budget without splitting a code point. */
function truncateUtf8(value, maxBytes) {
	const bytes = Buffer.from(value, 'utf8')
	if (bytes.length <= maxBytes) return value
	let end = Math.max(0, Math.trunc(maxBytes))
	while (end > 0 && (bytes.readUInt8(end) & 192) === 128) end -= 1
	return `${bytes.subarray(0, end).toString('utf8')}\n[truncated at ${maxBytes} bytes]`
}

/** Recursively freeze a plain JSON-ish value. */
function deepFreeze(value) {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value)
		for (const child of Object.values(value)) deepFreeze(child)
	}
	return value
}

/** Compare two messages by the payload the harness uses for deduplication. */
function sameContent(left, right) {
	if (left === undefined || right === undefined) return false
	return JSON.stringify(left.content) === JSON.stringify(right.content)
}

/** Report whether an equal payload is already durable in this session. */
function alreadyInSession(agent, source, text) {
	try {
		const surface = agent?.session?.surface
		if (surface === undefined) return false
		for (const seq of surface.nodes) {
			const event = agent.session.eventAt(seq)
			if (event?.type !== 'user/message') continue
			const data = event.data
			if (data?.source?.kind !== source.kind) continue
			if (JSON.stringify(data.content) === JSON.stringify([{ type: 'text', text }])) return true
		}
	} catch {
		// Unknown session API — fall through to injection.
	}
	return false
}

/** Register the user-global rules injector. */
export function apply(ctx, config = {}) {
	const dir = expandPath(typeof config.dir === 'string' && config.dir.length > 0 ? config.dir : '~/.agents/rules')
	const maxBytes = Number.isFinite(config.maxBytes) && config.maxBytes > 0 ? config.maxBytes : DEFAULT_MAX_BYTES
	const include = Array.isArray(config.include) && config.include.length > 0 ? config.include : DEFAULT_INCLUDE
	const header = typeof config.header === 'string' && config.header.length > 0 ? config.header : DEFAULT_HEADER

	let warned = false
	const warnOnce = (error) => {
		if (warned) return
		warned = true
		try {
			ctx.logger.warn(`${name}: rules injection degraded, skipping: %o`, error)
		} catch {
			// Logger unavailable — the guard exists only to avoid spamming.
		}
	}

	/** Last rendered payload, keyed by its content digest. */
	let cached = { digest: '', text: '' }

	let loading
	const load = async () => {
		let names
		try {
			names = (await readdir(dir)).filter((entry) => include.some((extension) => entry.endsWith(extension)))
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error
			return { digest: '', text: '' }
		}
		const sections = []
		for (const fileName of names.sort()) {
			let raw
			try {
				raw = await readFile(join(dir, fileName), 'utf8')
			} catch {
				continue
			}
			const { front, body } = splitFrontmatter(raw)
			if (!alwaysApply(front)) continue
			const body_ = body.trim()
			if (body_.length === 0) continue
			sections.push(`## ${fileName}\n\n${body_}`)
		}
		if (sections.length === 0) return { digest: '', text: '' }
		const body = sections.join('\n\n')
		const intro = `${header}\nRules directory: ${dir}`
		const framed = `<system-reminder>\n${intro}\n\n${body}\n</system-reminder>`
		const text = truncateUtf8(framed.replaceAll('</system-reminder>', '<\\/system-reminder>'), maxBytes)
		return { digest: createHash('sha1').update(text).digest('hex'), text }
	}

	const current = async () => {
		if (loading === undefined) loading = load()
		try {
			const next = await loading
			cached = next
			return next
		} finally {
			loading = undefined
		}
	}

	ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
		const decision = await next()
		try {
			if (decision === undefined || decision.kind === 'reject') return decision
			const { digest, text } = await current()
			if (text.length === 0) return decision
			signal?.throwIfAborted?.()

			const desired = deepFreeze({
				id: `${SOURCE_KIND}-${digest}`,
				role: 'user',
				content: [{ type: 'text', text }],
				source: { kind: SOURCE_KIND, form: SOURCE_FORM, digest },
			})
			const claimed = Array.isArray(decision.messages) ? decision.messages : []
			if (claimed.some((message) => sameContent(message, desired))) return decision
			if (alreadyInSession(agent, desired.source, text)) return decision

			if (claimed.length === 0 && step === 1) {
				// First request: the harness assembles history from the agent inbox,
				// so hand the message to the inbox instead of the step decision.
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
