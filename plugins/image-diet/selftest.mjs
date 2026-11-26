/**
 * image-diet 自测（`node selftest.mjs`）——不需要 DSH、不需要 sharp、不联网。
 *
 * 覆盖：目标尺寸决策（长边/像素/字节三种超标、下限兜底、只超字节时的纯重压缩、绝不放大）、
 * 表面图像收集（user/message 与 tool/result 两种 data 形状）、替换协议形状、缓存命中、
 * 收益门限、编码/写档失败软降级、dryRun、配置校验、钩子注册与 next() 语义。
 */

import { strict as assert } from 'node:assert'

const { DEFAULTS, resolveConfig, planTarget, cacheKey, collectImages, runPass, createCache } = await import('./index.mjs')

let failures = 0
const ok = (condition, label, detail = '') => {
	if (condition) console.log(`  ✓ ${label}`)
	else {
		failures += 1
		console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
	}
}
const eq = (actual, expected, label) => ok(actual === expected, label, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)

const CONFIG = resolveConfig({ enabled: true, cacheFile: '', debugFile: '' })

/** An image ref as the harness stores it. */
const imageRef = (id, width, height, bytes, name = `${id}.png`) => ({ attachmentId: `sha256:${id}`, mediaType: 'image/png', width, height, bytes, name })

/** Minimal session stub with the surface API the plugin uses. */
function makeSession(entries) {
	const events = new Map()
	const surface = []
	let seq = 0
	for (const entry of entries) {
		seq += 1
		const event = entry.type === 'user/message'
			? { type: 'user/message', seq, data: { role: 'user', content: entry.content } }
			: { type: 'tool/result', seq, data: { turn: 1, step: seq, message: { role: 'tool', toolCallId: `call_${seq}`, content: entry.content } } }
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
			deriveEventMessage: (event) => (event.type === 'user/message' ? event.data : event.data.message),
			append: (type, data, options) => {
				appended.push({ type, data, options })
				// 模拟 harness：替换事件落地后，被遮蔽的节点从 surface 上换成本事件。
				if (options?.surfaceOp?.op === 'replace') {
					seq += 1
					const landing = { type, seq, data }
					events.set(seq, landing)
					const index = surface.indexOf(options.surfaceOp.startSeq)
					if (index !== -1) surface[index] = seq
				}
				return { seq }
			},
		},
	}
}

/** Attachments stub: halve the long edge and report ~¼ the bytes of the source. */
function makeAttachments(overrides = {}) {
	const calls = { read: 0, save: 0 }
	const stub = {
		calls,
		async readImageRequest(ref, target, signal) {
			calls.read += 1
			if (overrides.read !== undefined) return overrides.read(ref, target, signal)
			return {
				data: new Uint8Array(Math.max(1, Math.round((ref.bytes ?? 1000) * 0.25))),
				mediaType: 'image/webp',
				width: target.width,
				height: target.height,
				bytes: Math.max(1, Math.round((ref.bytes ?? 1000) * 0.25)),
			}
		},
		async saveImages(inputs) {
			calls.save += 1
			if (overrides.save !== undefined) return overrides.save(inputs)
			return inputs.map((input, index) => imageRef(`diet-${index}`, 800, 600, input.data.byteLength, input.name))
		},
	}
	return stub
}

console.log('planTarget')
{
	const small = planTarget(imageRef('a', 800, 600, 120_000), CONFIG)
	eq(small, null, '小图不处理')

	const big = planTarget(imageRef('b', 4000, 3000, 3_000_000), CONFIG)
	ok(big !== null, '4K 大图要处理')
	ok(Math.max(big.width, big.height) <= CONFIG.maxLongEdge, `长边收到 ${CONFIG.maxLongEdge} 以内`, JSON.stringify(big))
	ok(big.width * big.height <= CONFIG.targetPixels, '像素收到目标以内')
	eq(Math.abs(big.width / big.height - 4000 / 3000) < 0.01, true, '保持纵横比')

	const wide = planTarget(imageRef('c', 5000, 400, 900_000), CONFIG)
	ok(wide !== null && Math.max(wide.width, wide.height) >= CONFIG.minLongEdge, '长条图不低于 minLongEdge 下限', JSON.stringify(wide))

	const byteOnly = planTarget(imageRef('d', 1000, 800, 2_000_000), CONFIG)
	ok(byteOnly !== null, '只超字节也要处理（纯重压缩）')
	eq(byteOnly.width, 1000, '只超字节时不改尺寸（不缩放、更不放大）')
	eq(byteOnly.height, 800, '只超字节时不改高度')
	ok(byteOnly.maxBytes < 2_000_000 && byteOnly.maxBytes <= CONFIG.targetBytes, 'maxBytes 收紧到目标以内', JSON.stringify(byteOnly))

	eq(planTarget({ attachmentId: 'sha256:x' }, CONFIG), null, '缺 width/height 的引用直接跳过')
	eq(planTarget(null, CONFIG), null, 'null 引用不炸')
	ok(planTarget(imageRef('e', 4000, 3000, 3_000_000), resolveConfig({ maxLongEdge: 2048, minLongEdge: 512, targetPixels: 4_000_000 })).width <= 2048, '配置可调（maxLongEdge 生效）')
}

console.log('collectImages')
{
	const { session } = makeSession([
		{ type: 'user/message', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: imageRef('u1', 4000, 3000, 3e6) }] },
		{ type: 'user/message', content: [{ type: 'text', text: 'no image here' }] },
		{ type: 'tool/result', content: [{ type: 'image', attachment: imageRef('t1', 2000, 1500, 1e6) }, { type: 'image', attachment: imageRef('t2', 1200, 900, 4e5) }] },
	])
	const groups = collectImages(session, 0)
	eq(groups.length, 2, '只收集带图的 2 组')
	eq(groups[0].images[0].index, 1, 'user/message 的图像块位置正确')
	eq(groups[1].images.length, 2, 'tool/result 里的两张图都收集到')
	eq(collectImages(session, 1).length, 1, 'keepRecent=1 时跳过最新一组')
	eq(collectImages(session, 9).length, 0, 'keepRecent 超过总数时全跳过')
}

console.log('runPass')
{
	const { session, appended } = makeSession([
		{ type: 'user/message', content: [{ type: 'text', text: '看这张' }, { type: 'image', attachment: imageRef('u1', 4000, 3000, 3e6) }] },
		{ type: 'tool/result', content: [{ type: 'image', attachment: imageRef('t1', 640, 480, 90_000) }] },
	])
	const attachments = makeAttachments()
	const cache = createCache('')
	const result = await runPass(session, { config: CONFIG, attachments, cache, log: () => {} })
	eq(result.replaced, 1, '只换掉超标的 1 张')
	eq(appended.length, 1, '只追加 1 个替换事件')
	const [event] = appended
	eq(event.type, 'user/message', '替换事件沿用原事件类型')
	eq(event.options.surfaceOp.op, 'replace', 'surfaceOp 是 replace')
	eq(event.options.surfaceOp.startSeq, 1, 'startSeq 指向原节点')
	eq(event.options.surfaceOp.endSeq, 1, 'endSeq 指向原节点')
	eq(JSON.stringify(event.options.sourceEventSeqs), '[1]', 'sourceEventSeqs 声明被遮蔽的节点')
	eq(event.data.role, 'user', 'user/message 的 data 就是 message（role 保留）')
	eq(event.data.content[0].text, '看这张', '文本块原样保留')
	eq(event.data.content[1].type, 'image', '图块类型不变')
	eq(event.data.content[1].attachment.attachmentId, 'sha256:diet-0', '图块指向新的附件引用')
	eq(Object.isFrozen(event.data.content), true, '新 content 冻结（防下游改写）')
}

console.log('runPass · tool/result 形状与缓存')
{
	const { session, appended } = makeSession([
		{ type: 'tool/result', content: [{ type: 'image', attachment: imageRef('t1', 3000, 2000, 2e6) }] },
	])
	const attachments = makeAttachments()
	const cache = createCache('')
	await runPass(session, { config: CONFIG, attachments, cache, log: () => {} })
	eq(appended[0].data.message.toolCallId, 'call_1', 'toolCallId 原样保留（否则替换被拒）')
	eq(appended[0].data.turn, 1, '事件其他字段保留')
	eq(appended[0].data.message.content[0].attachment.attachmentId, 'sha256:diet-0', 'tool/result 的图块也换掉')
	eq(attachments.calls.read, 1, '一次编码')
	await runPass(session, { config: CONFIG, attachments, cache, log: () => {} })
	eq(attachments.calls.read, 1, '第二次走缓存，不再编码')
	eq(appended.length, 1, '缓存命中也就不再追加替换')
}

console.log('runPass · 软降级')
{
	const { session, appended } = makeSession([{ type: 'user/message', content: [{ type: 'image', attachment: imageRef('u1', 4000, 3000, 3e6) }] }])

	const throwing = makeAttachments({ read: () => { throw new Error('sharp blew up') } })
	const r1 = await runPass(session, { config: CONFIG, attachments: throwing, cache: createCache(''), log: () => {} })
	eq(r1.replaced, 0, '编码抛错时这一张跳过')
	eq(appended.length, 0, '编码抛错不写表面')

	const tooSmallGain = makeAttachments({ save: (inputs) => inputs.map((input) => imageRef('same', 4000, 3000, 3e6)) })
	const r2 = await runPass(session, { config: CONFIG, attachments: tooSmallGain, cache: createCache(''), log: () => {} })
	eq(r2.replaced, 0, '收益不足（新图不比旧图小 10%）跳过')
	eq(appended.length, 0, '收益不足不写表面')

	const noService = await runPass(session, { config: CONFIG, attachments: undefined, cache: createCache(''), log: () => {} })
	eq(noService.replaced, 0, '没有 attachments 服务时安静跳过')
	const legacy = await runPass(session, { config: CONFIG, attachments: { saveImages: async () => [] }, cache: createCache(''), log: () => {} })
	eq(legacy.replaced, 0, '旧版附件服务（无 readImageRequest）也安静跳过')
}

console.log('runPass · 单组被拒不影响其他组')
{
	const { session, appended } = makeSession([
		{ type: 'user/message', content: [{ type: 'image', attachment: imageRef('u0', 4000, 3000, 3e6) }] },
		{ type: 'user/message', content: [{ type: 'image', attachment: imageRef('u1', 4000, 3000, 3e6) }] },
	])
	const refused = []
	const guarded = {
		...session,
		append(type, data, options) {
			// 模拟 node 0（system 头）保护：第一组替换被 session 拒绝。
			if (options?.surfaceOp?.startSeq === 1) {
				refused.push(options.surfaceOp.startSeq)
				throw new Error('surface replace: node 0 holds the system prompt')
			}
			return session.append(type, data, options)
		},
	}
	const attachments = makeAttachments()
	const result = await runPass(guarded, { config: CONFIG, attachments, cache: createCache(''), log: () => {} })
	eq(refused.length, 1, '第一组被拒一次')
	eq(appended.length, 1, '第二组照常替换')
	eq(result.replaced, 1, '计数只算真正落地的 1 张')
	eq(result.savedBytes > 0, true, '节省字节计数>0')
}

console.log('runPass · dryRun')
{
	const { session, appended } = makeSession([{ type: 'user/message', content: [{ type: 'image', attachment: imageRef('u1', 4000, 3000, 3e6) }] }])
	const lines = []
	const attachments = makeAttachments()
	const dry = resolveConfig({ enabled: true, dryRun: true, cacheFile: '', debugFile: '' })
	const result = await runPass(session, { config: dry, attachments, cache: createCache(''), log: (line) => lines.push(line) })
	eq(result.replaced, 1, 'dryRun 计数报出会被压的图')
	eq(appended.length, 0, 'dryRun 不写表面')
	eq(attachments.calls.save, 0, 'dryRun 不写附件')
	ok(lines.some((line) => line.startsWith('dryRun:')), 'dryRun 有日志')
}

console.log('resolveConfig')
{
	eq(resolveConfig({}).maxLongEdge, DEFAULTS.maxLongEdge, '默认值可用')
	eq(resolveConfig({ enabled: false }).enabled, false, 'enabled:false 生效')
	let threw = false
	try {
		resolveConfig({ minLongEdge: 2000, maxLongEdge: 1600 })
	} catch {
		threw = true
	}
	eq(threw, true, 'minLongEdge > maxLongEdge 直接报错')
	threw = false
	try {
		resolveConfig({ targetPixels: 0 })
	} catch {
		threw = true
	}
	eq(threw, true, '非正整数参数报错')
}

console.log('cacheKey')
{
	eq(cacheKey(imageRef('a', 1, 1, 1), CONFIG) === cacheKey(imageRef('b', 1, 1, 1), CONFIG), false, '不同图不同键')
	eq(cacheKey(imageRef('a', 1, 1, 1), CONFIG) === cacheKey(imageRef('a', 9, 9, 9), CONFIG), true, '同一图同键（与尺寸无关）')
	eq(cacheKey(imageRef('a', 1, 1, 1), CONFIG) === cacheKey(imageRef('a', 1, 1, 1), resolveConfig({ maxLongEdge: 2048 })), false, '策略变了键也变')
}

console.log('apply')
{
	const { apply } = await import('./index.mjs')
	const hooks = []
	const registered = { ctx: { logger: { info: () => {} }, on: (event, handler) => hooks.push([event, handler]), get: () => undefined } }
	apply(registered.ctx, { enabled: true, cacheFile: '', debugFile: '' })
	eq(hooks.length, 1, '注册了一个钩子')
	eq(hooks[0][0], 'agent/pre-step', '钩子挂在 agent/pre-step')
	const preStep = hooks[0][1]

	let nextCalls = 0
	const { session } = makeSession([{ type: 'user/message', content: [{ type: 'image', attachment: imageRef('u1', 4000, 3000, 3e6) }] }])
	const attachments = makeAttachments()
	const ctxWithService = { logger: { info: () => {} }, on: (event, handler) => { preStepHandler = handler }, get: (name) => (name === 'attachments' ? attachments : undefined) }
	let preStepHandler
	apply(ctxWithService, { enabled: true, cacheFile: '', debugFile: '' })
	await preStepHandler({ agent: { session }, signal: undefined }, async () => {
		nextCalls += 1
		return { kind: 'enter', messages: [] }
	})
	eq(nextCalls, 1, '始终调用 next()')
	eq(attachments.calls.read, 1, '通过 ctx.get("attachments") 拿到服务并用上了')

	// 同一会话出错后不再动它（黑名单），但 next() 仍要调用。
	const failing = { session: { surface: { nodes: [1] }, eventAt: () => ({ type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'image', attachment: imageRef('u1', 4000, 3000, 3e6) }] } }), deriveEventMessage: (event) => event.data, append: () => { throw new Error('session refuses the replacement') } } }
	let readAfterFailure = 0
	let handler
	apply({ logger: { info: () => {} }, on: (event, fn) => { handler = fn }, get: (name) => (name === 'attachments' ? { readImageRequest: async () => { readAfterFailure += 1; return null }, saveImages: async () => [] } : undefined) }, { enabled: true, cacheFile: '', debugFile: '' })
	await handler({ agent: failing, signal: undefined }, async () => ({}))
	const first = readAfterFailure
	await handler({ agent: failing, signal: undefined }, async () => ({}))
	eq(first, 1, '第一次会尝试')
	eq(readAfterFailure, first, '出错后同会话不再重试')

	let disabledHooks = 0
	apply({ logger: { info: () => {} }, on: () => { disabledHooks += 1 }, get: () => undefined }, { enabled: false })
	eq(disabledHooks, 0, 'enabled:false 时不注册任何钩子')
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
