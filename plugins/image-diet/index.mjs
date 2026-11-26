/**
 * image-diet — 图片「节食」：把会话表面上过重（长边/像素/字节超标）的图片，在**模型请求**里换成
 * 更小的附件引用。只改写请求投影，不动会话日志、不动人类可见的 transcript。
 *
 * 为什么做：宿主的路由预算是「一个模型路由一个尺⼨」，管所有图；图多图少、截图还是照片，都用同一条
 * 长边上限。结果是要么整体偏大（图少时不去压），要么被 image/offload 整张丢弃（图多时）。
 * 本插件按**每张图自己的**长边/像素/字节超标程度决定目标尺寸，并在 `minLongEdge` 处兜底保住可读性。
 *
 * 技术选择：编码复用宿主附件服务的 `readImageRequest(ref, target, signal)`（sharp 实现、带磁盘
 * 变体缓存、目标未满足时回落到最小档），**不启子进程**、不依赖 sips/magick，跨平台一致。
 * 写档复用 `saveImages()`（内容寻址、与直接上传同一套准入），旧图仍然留在 attachments 里。
 *
 * 触发：`agent/pre-step`（host-only）。替换协议与 harness 自带 pruner / context-diet 同形：
 * `session.append(type, data, { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs })`。
 */

export const name = 'image-diet'

export const DEFAULTS = {
	/** 总开关。 */
	enabled: true,
	/** 只记日志、不真正替换（对比真实截图前后用）。 */
	dryRun: false,
	/** 目标：长边上限（像素）。 */
	maxLongEdge: 1600,
	/** 目标：总像素上限。 */
	targetPixels: 1_200_000,
	/** 下限：长边不低于该值（防小字糊），只有比它还大的图才会被裁到这个下限。 */
	minLongEdge: 1024,
	/** 目标：单图编码字节上限。 */
	targetBytes: 900_000,
	/** 最近 N 组带图消息保持原样（正在读的图先别动）；0 = 全都参与。 */
	keepRecent: 0,
	/** 旧图 → 新图引用的落盘缓存（避免重启后重复编码）。 */
	cacheFile: '~/.dsh/cache/image-diet.json',
	/** 诊断日志；留空则只走 ctx.logger。 */
	debugFile: '',
}

export const CONFIG_KEYS = Object.keys(DEFAULTS)

const MESSAGE_TYPES = new Set(['user/message', 'tool/result'])

/** 单图「节食」至少要省这么多字节才值得换（避免每步来回抖）。 */
const MIN_GAIN_RATIO = 0.9

function assertPositiveInteger(value, label) {
	if (!Number.isInteger(value) || value < 1) throw new Error(`image-diet: ${label} must be a positive integer, got ${JSON.stringify(value)}`)
}

/** Normalize and validate plugin config; throws on values that cannot work. */
export function resolveConfig(config = {}) {
	const resolved = { ...DEFAULTS, ...config }
	resolved.enabled = resolved.enabled !== false
	resolved.dryRun = resolved.dryRun === true
	assertPositiveInteger(resolved.maxLongEdge, 'maxLongEdge')
	assertPositiveInteger(resolved.targetPixels, 'targetPixels')
	assertPositiveInteger(resolved.minLongEdge, 'minLongEdge')
	assertPositiveInteger(resolved.targetBytes, 'targetBytes')
	if (!Number.isInteger(resolved.keepRecent) || resolved.keepRecent < 0) throw new Error(`image-diet: keepRecent must be a non-negative integer, got ${JSON.stringify(resolved.keepRecent)}`)
	if (resolved.minLongEdge > resolved.maxLongEdge) throw new Error(`image-diet: minLongEdge (${resolved.minLongEdge}) must not exceed maxLongEdge (${resolved.maxLongEdge})`)
	if (typeof resolved.cacheFile !== 'string') throw new Error('image-diet: cacheFile must be a string')
	if (typeof resolved.debugFile !== 'string') throw new Error('image-diet: debugFile must be a string')
	return resolved
}

function scaleBy(width, height, scale) {
	// 用 floor：宁可少一两像素，也不让结果越过目标预算（round 会把 1.2MP 变成 1.2005MP）。
	return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}

/**
 * Decide the request size one image deserves, or null when it is already small enough.
 * @param ref - durable image attachment reference (`{width,height,bytes,...}`).
 * @param config - resolved plugin config.
 * @returns `{width,height,maxBytes}` for `readImageRequest`, or null to leave the image alone.
 */
export function planTarget(ref, config) {
	if (ref === null || typeof ref !== 'object') return null
	const { width, height } = ref
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null
	const bytes = Number.isFinite(ref.bytes) && ref.bytes > 1 ? ref.bytes : undefined
	const pixels = width * height
	const longEdge = Math.max(width, height)
	const overLongEdge = longEdge > config.maxLongEdge
	const overPixels = pixels > config.targetPixels
	const overBytes = bytes !== undefined && bytes > config.targetBytes
	if (!overLongEdge && !overPixels && !overBytes) return null

	const ceiling = bytes === undefined ? config.targetBytes : Math.max(1, Math.min(config.targetBytes, bytes - 1))
	// 已经不比下限大的图：只重压缩，不再裁尺寸（否则越压越糊且收益递减）。
	if (longEdge <= config.minLongEdge) return { width, height, maxBytes: ceiling }

	let scale = 1
	if (overLongEdge) scale = Math.min(scale, config.maxLongEdge / longEdge)
	if (overPixels) scale = Math.min(scale, Math.sqrt(config.targetPixels / pixels))
	if (overBytes) scale = Math.min(scale, Math.sqrt(config.targetBytes / bytes))

	let target = scaleBy(width, height, scale)
	// 下限兜底：字要还能看清，宁可多花一点字节。
	if (Math.max(target.width, target.height) < config.minLongEdge) target = scaleBy(width, height, config.minLongEdge / longEdge)
	if (target.width > width || target.height > height) target = { width, height }
	return { width: target.width, height: target.height, maxBytes: ceiling }
}

/** Stable cache key: one entry per (source attachment, effective policy). */
export function cacheKey(ref, config) {
	return [ref?.attachmentId, config.maxLongEdge, config.targetPixels, config.targetBytes, config.minLongEdge].join('|')
}

/**
 * Collect surface messages that carry image blocks, oldest first.
 * @param session - agent session exposing `surface.nodes`, `eventAt`, `deriveEventMessage`.
 * @param keepRecent - number of newest image-bearing messages to leave untouched.
 */
export function collectImages(session, keepRecent = 0) {
	const groups = []
	for (const seq of session.surface.nodes) {
		const event = session.eventAt(seq)
		if (event === undefined || !MESSAGE_TYPES.has(event.type)) continue
		const message = session.deriveEventMessage(event)
		const content = message?.content
		if (!Array.isArray(content)) continue
		const images = []
		content.forEach((block, index) => {
			if (block?.type === 'image' && block.attachment !== undefined) images.push({ index, ref: block.attachment })
		})
		if (images.length === 0) continue
		groups.push({ seq, event, message, content, images })
	}
	return keepRecent > 0 ? groups.slice(0, Math.max(0, groups.length - keepRecent)) : groups
}

function describe(ref) {
	return `${ref?.name ?? ref?.attachmentId ?? 'image'} ${ref?.width}x${ref?.height}@${ref?.bytes}`
}

/**
 * Shrink one image reference through the host attachment service.
 * @returns the replacement reference, `{dryRun: true, ...}` under dryRun, or null when nothing worth doing.
 */
async function dietOne(ref, { config, attachments, cache, log, signal }) {
	const key = cacheKey(ref, config)
	const hit = cache?.get(key)
	if (hit !== undefined) return hit

	const target = planTarget(ref, config)
	if (target === null) {
		cache?.set(key, null)
		return null
	}

	let variant
	try {
		variant = await attachments.readImageRequest(ref, target, signal)
	} catch (error) {
		log?.(`encode failed for ${describe(ref)}: ${error instanceof Error ? error.message : String(error)}`)
		return null
	}
	if (variant === undefined || variant === null || variant.data === undefined) {
		cache?.set(key, null)
		return null
	}

	const encodedBytes = variant.data.byteLength ?? variant.bytes ?? 0
	const sourceLong = Math.max(ref.width, ref.height)
	const variantLong = Math.max(variant.width ?? 0, variant.height ?? 0)
	if (variantLong > sourceLong || (ref.bytes !== undefined && encodedBytes >= ref.bytes)) {
		cache?.set(key, null)
		return null
	}

	if (config.dryRun) {
		log?.(`dryRun: ${describe(ref)} -> ${variant.width}x${variant.height}@${encodedBytes}`)
		return { dryRun: true, width: variant.width, height: variant.height, bytes: encodedBytes }
	}

	let saved
	try {
		const refs = await attachments.saveImages([{ data: variant.data, mediaType: variant.mediaType, name: ref.name }])
		saved = refs?.[0]
	} catch (error) {
		log?.(`store failed for ${describe(ref)}: ${error instanceof Error ? error.message : String(error)}`)
		return null
	}
	if (saved === undefined || saved === null) {
		cache?.set(key, null)
		return null
	}
	const gain = ref.bytes === undefined ? 1 : saved.bytes / ref.bytes
	if (saved.bytes >= encodedBytes * 1.1 || gain > MIN_GAIN_RATIO) {
		cache?.set(key, null)
		return null
	}

	cache?.set(key, saved)
	log?.(`${describe(ref)} -> ${saved.width}x${saved.height}@${saved.bytes}`)
	return saved
}

/**
 * One diet pass over the current surface.
 * @param session - agent session.
 * @param options - `{config, attachments, cache, log, signal}`.
 * @returns `{replaced, savedBytes}` for logging.
 */
export async function runPass(session, { config, attachments, cache, log, signal }) {
	if (attachments === undefined || attachments === null || typeof attachments.readImageRequest !== 'function') {
		log?.('attachments service has no readImageRequest; skip')
		return { replaced: 0, savedBytes: 0 }
	}

	const groups = collectImages(session, config.keepRecent)
	let replaced = 0
	let savedBytes = 0

	for (const group of groups) {
		if (signal?.aborted === true) break
		const content = [...group.content]
		let groupReplaced = 0
		let groupSaved = 0
		for (const { index, ref } of group.images) {
			const next = await dietOne(ref, { config, attachments, cache, log, signal })
			if (next === null) continue
			groupReplaced += 1
			groupSaved += Math.max(0, (ref.bytes ?? 0) - (next.bytes ?? 0))
			if (next.dryRun === true) continue
			content[index] = Object.freeze({ ...group.content[index], attachment: next })
		}
		replaced += groupReplaced
		savedBytes += groupSaved
		if (groupReplaced === 0 || config.dryRun) continue
		const nextContent = Object.freeze(content)
		const data = group.event.type === 'tool/result'
			? { ...group.event.data, message: Object.freeze({ ...group.message, content: nextContent }) }
			: { ...group.event.data, content: nextContent }
		try {
			// 逐组隔离：某组被 session 拒绝（例如它正好是受保护的 system 头节点）时只回退这一组的计数。
			session.append(group.event.type, data, { surfaceOp: { op: 'replace', startSeq: group.seq, endSeq: group.seq }, sourceEventSeqs: [group.seq] })
		} catch (error) {
			replaced -= groupReplaced
			savedBytes -= groupSaved
			log?.(`surface refused seq ${group.seq}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	return { replaced, savedBytes }
}

function expandHome(path) {
	if (!path.startsWith('~')) return path
	return `${process.env.HOME ?? ''}${path.slice(1)}`
}

/** Best-effort disk cache of `source key -> replacement ref` (null means "leave it alone"). */
export function createCache(file) {
	const map = new Map()
	let loaded = false
	let dirty = false
	const path = file === undefined || file === '' ? '' : expandHome(file)
	return {
		get(key) {
			return map.has(key) ? map.get(key) : undefined
		},
		set(key, value) {
			map.set(key, value ?? null)
			dirty = true
		},
		async load() {
			if (loaded) return
			loaded = true
			if (path === '') return
			try {
				const fs = await import('node:fs/promises')
				const raw = JSON.parse(await fs.readFile(path, 'utf8'))
				for (const [key, value] of Object.entries(raw)) map.set(key, value)
			} catch {}
		},
		async save() {
			if (!dirty || path === '') return
			dirty = false
			try {
				const fs = await import('node:fs/promises')
				const { dirname } = await import('node:path')
				await fs.mkdir(dirname(path), { recursive: true })
				await fs.writeFile(path, JSON.stringify(Object.fromEntries(map)))
			} catch {}
		},
	}
}

/** Cordis plugin entry point. */
export function apply(ctx, config = {}) {
	const resolved = resolveConfig(config)
	if (!resolved.enabled) {
		ctx.logger?.info?.('image-diet: disabled by config')
		return
	}
	ctx.logger?.info?.(`image-diet: enabled (maxLongEdge ${resolved.maxLongEdge}, targetPixels ${resolved.targetPixels}, minLongEdge ${resolved.minLongEdge}, targetBytes ${resolved.targetBytes}${resolved.dryRun ? ', dryRun' : ''})`)

	const broken = new WeakSet()
	const cache = createCache(resolved.cacheFile)
	let loaded = false
	const debug = (line) => {
		const text = `[${new Date().toISOString()}] ${line}`
		ctx.logger?.info?.(`image-diet: ${line}`)
		if (resolved.debugFile === '') return
		void import('node:fs/promises').then((fs) => fs.appendFile(expandHome(resolved.debugFile), `${text}\n`)).catch(() => {})
	}

	ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
		const session = agent?.session
		const attachments = ctx.get?.('attachments') ?? ctx.attachments
		if (session !== undefined && !broken.has(session) && signal?.aborted !== true) {
			try {
				if (!loaded) {
					loaded = true
					await cache.load()
				}
				const result = await runPass(session, { config: resolved, attachments, cache, log: debug, signal })
				if (result.replaced > 0) debug(`${resolved.dryRun ? 'would shrink' : 'shrank'} ${result.replaced} image(s), saved ${result.savedBytes} bytes`)
				await cache.save()
			} catch (error) {
				broken.add(session)
				debug(`disabled for this session after an error: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		return next()
	})
}

/** Test seam; the loader only consumes `name` / `apply`. */
export const __internals = { DEFAULTS, CONFIG_KEYS, resolveConfig, planTarget, cacheKey, collectImages, runPass, createCache }
