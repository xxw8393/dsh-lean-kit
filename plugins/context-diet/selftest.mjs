/**
 * context-diet 自测（`node selftest.mjs`）——不需要 DSH。
 *
 * 覆盖：挑选（只折旧的、留最新 keepRecent 条）、折叠（阈值/幂等/保留非文本块）、
 * 替换协议（`compaction/prune` + `surfaceOp: replace`，形状与 harness 自带 pruner 一致）、
 * 门限、配置校验、出错软降级。
 */

import { strict as assert } from 'node:assert'

const { name, resolveConfig, textOf, foldContent, collectFoldable, runPass, apply } = await import('./index.mjs')

let failures = 0
const ok = (condition, label, detail = '') => {
	if (condition) console.log(`  ✓ ${label}`)
	else {
		failures += 1
		console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
	}
}
const eq = (actual, expected, label) => ok(actual === expected, label, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)

/** Minimal session stub with the surface API the plugin uses. */
function makeSession(results) {
	const events = new Map()
	let seq = 0
	const surface = []
	for (const text of results) {
		seq += 1
		const event = {
			type: 'tool/result',
			seq,
			data: { turn: 1, step: seq, message: { role: 'tool', toolCallId: `call_${seq}`, source: { kind: 'tool', callId: `call_${seq}` }, content: [{ type: 'text', text }] } },
		}
		events.set(seq, event)
		surface.push(seq)
	}
	const appended = []
	return {
		events,
		appended,
		session: {
			surface: { get nodes() { return [...surface] } },
			eventAt: (s) => events.get(s),
			deriveEventMessage: (event) => event.data.message,
			append(type, data, options) {
				seq += 1
				events.set(seq, { type, seq, data })
				if (type === 'compaction/prune') {
					appended.push({ type, data, seq })
					return { seq }
				}
				if (options?.surfaceOp !== undefined) {
					const { startSeq, endSeq } = options.surfaceOp
					const at = surface.indexOf(startSeq)
					assert.ok(at >= 0, `replace must name a current surface node (seq ${startSeq})`)
					assert.equal(endSeq, startSeq, 'single-node replace')
					surface.splice(at, 1, seq)
				} else surface.push(seq)
				appended.push({ type, data, options, seq })
				return { seq }
			},
		},
	}
}

console.log('context-diet / 配置')
eq(name, 'context-diet', '插件名与 profile 挂载 id 一致')
const config = resolveConfig()
eq(config.keepRecent, 15, '默认 keepRecent=15')
eq(config.minChars, 500, '默认 minChars=500')
assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key/, '未知键报错')
assert.throws(() => resolveConfig({ minChars: 300 }), /smaller than minChars/, 'head+tail 必须小于 minChars，否则折叠不会变小')
ok(true, '默认配置自洽')

console.log('context-diet / 挑选与折叠')
const small = { content: [{ type: 'text', text: 'ok' }] }
eq(foldContent(small.content, config), null, '短结果不折')
const big = { content: [{ type: 'text', text: 'x'.repeat(4000) }] }
const folded = foldContent(big.content, config)
const foldedText = textOf({ content: folded })
ok(foldedText.length < config.minChars, '折后长度低于 minChars（保证幂等）', `len=${foldedText.length}`)
ok(foldedText.startsWith('x'.repeat(config.headChars)), '保留头部')
ok(foldedText.endsWith('x'.repeat(config.tailChars)), '保留尾部')
ok(foldedText.includes('context-diet'), '插入可读标记')
ok(foldedText.includes('3680'), '标记里写明省略了多少字符（4000-200-120）')
eq(foldContent(folded, config), null, '折叠结果再次折叠 → 无操作（幂等）')
const withImage = { content: [{ type: 'text', text: 'y'.repeat(3000) }, { type: 'image', data: 'keep-me' }] }
ok(foldContent(withImage.content, config).some((b) => b.type === 'image'), '非文本块原样保留')

const many = makeSession([...Array(20)].map((_, i) => (i < 5 ? 'z'.repeat(3000) : 'small')))
const pick = collectFoldable(many.session, 15)
eq(pick.length, 5, '20 条结果、keepRecent=15 → 只挑最旧 5 条')
eq(pick[0].seq, 1, '从最旧的开始')

console.log('context-diet / 替换协议')
const pass1 = runPass(many.session, { config, meter: undefined })
eq(pass1.folded, 5, '第一遍折 5 条')
const prunes = many.appended.filter((item) => item.type === 'compaction/prune')
const replaces = many.appended.filter((item) => item.type === 'tool/result')
eq(prunes.length, 5, '每条折叠配一个 compaction/prune 影子计价事件')
eq(replaces.length, 5, '每条折叠配一个 tool/result 替换节点')
ok(prunes.every((prune, i) => prunes[i].data.shadowedRange.start === prune.data.shadowedSeqs[0] && prune.data.shadowedSeqs[0] === prune.data.shadowedRange.end), 'shadowedRange 与 shadowedSeqs 一致（harness 不变量要求）')
ok(replaces.every((item) => item.options.surfaceOp.op === 'replace' && item.options.surfaceOp.startSeq === item.options.surfaceOp.endSeq && item.options.sourceEventSeqs.length === 1), 'surfaceOp/sourceEventSeqs 形状正确')
ok(replaces.every((item, i) => many.appended.indexOf(prunes[i]) === many.appended.indexOf(item) - 1), 'prune 紧邻其替换节点（与自带 pruner 同序）')
const kept = replaces[0].data.message
eq(kept.toolCallId, 'call_1', 'toolCallId 保留（工具配对不破）')
eq(kept.source.callId, 'call_1', 'source.callId 保留')
eq(kept.role, 'tool', 'role 保留')
eq(many.session.surface.nodes.length, 20, '替换不改变节点数量')
eq(many.session.surface.nodes.includes(1), false, '旧 seq 已离开 surface')
const pass2 = runPass(many.session, { config, meter: undefined })
eq(pass2.folded, 0, '第二遍无操作（幂等）')

console.log('context-diet / 门限与容错')
const gateSession = makeSession(['a'.repeat(3000), 'b'.repeat(3000), ...Array(15).fill('small')])
const gated = runPass(gateSession.session, { config: { ...config, triggerTokens: 100000 }, meter: { measure: () => ({ totalTokens: 5000 }) } })
eq(gated.folded, 0, '上下文低于 triggerTokens → 不折')
eq(gated.skipped, 'below-threshold', '记录跳过原因')

let preStep
let nextCalls = 0
const ctx = {
	logger: { info: () => {}, warn: () => {} },
	get: () => undefined,
	on: (event, handler) => {
		eq(event, 'agent/pre-step', '监听 agent/pre-step')
		preStep = handler
	},
}
apply(ctx, { enabled: true, debugFile: '' })
ok(typeof preStep === 'function', '注册了 pre-step 处理器')
const failing = {
	session: {
		surface: { nodes: [1] },
		eventAt: () => ({ type: 'tool/result', seq: 1, data: { message: { role: 'tool', content: [{ type: 'text', text: 'q'.repeat(4000) }] } } }),
		deriveEventMessage: (event) => event.data.message,
		append: () => {
			throw new Error('session refuses the replacement')
		},
	},
}
await preStep({ agent: failing, signal: undefined }, async () => {
	nextCalls += 1
	return { kind: 'enter', messages: [] }
})
eq(nextCalls, 1, '出错也照样调用 next()（不阻断这一步）')
let retried = 0
const failing2 = { session: { surface: { nodes: [1] }, eventAt: () => undefined, deriveEventMessage: () => ({ content: [] }), append: () => { retried += 1; return { seq: 2 } } } }
await preStep({ agent: failing2, signal: undefined }, async () => ({ kind: 'enter', messages: [] }))
eq(retried, 0, '同一会话出错后不再尝试')

let disabledOn = 0
apply({ logger: { info: () => {} }, on: () => { disabledOn += 1 }, get: () => undefined }, { enabled: false })
eq(disabledOn, 0, 'enabled:false 时不注册任何钩子')

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
