/**
 * session-hygiene 自测（`node selftest.mjs`）——不需要 DSH、不需要浏览器。
 *
 * 覆盖两半的**契约**，而不是实现细节：
 *   A. client.js 以正确的 bundle id 注册，导出 `apply`/`inject`，且只 require 平台 seed 词；
 *   B. 事件窗口 → 认出提醒（`source.kind` 主路径 + 文本标记退化路径）；
 *   C. 点「切换并继续」→ **先**向旧会话发「交接落盘」指令并等它跑完 → `sessions.create({workspaceId})`
 *      → `uiWorkspace.openSession(id)` → 新会话首句按交接结果分三种（继续 / 等新任务 / 未落盘兜底）；
 *      「忽略」不新建；
 *   D. 交接标记解析（`HANDOFF:/MODE:/NEXT:`）与三种首句的措辞（2026-10-28 交接转交回归）；
 *   E. 宿主半边在 alarm 档注入提醒，`source.key = tier#turnBucket`，文本含 NOTICE_MARKER 与交接标记契约，
 *      且同档同桶幂等、`enabled:false` 完全不注册。
 */

import { readFileSync } from 'node:fs'

let failures = 0
const ok = (condition, label, detail = '') => {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failures += 1
    console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}
const eq = (actual, expected, label) => ok(actual === expected, label, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// ─────────────────────────────────────────────────────────────── A：bundle 契约
console.log('client.js / bundle 契约')

const registered = []
const localStorageStub = {
  store: new Map(),
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null
  },
  setItem(key, value) {
    this.store.set(key, value)
  },
}
globalThis.window = { __ModuleLoader__: { load: (registration) => registered.push(registration) }, localStorage: localStorageStub }

const React = {
  Fragment: Symbol('Fragment'),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  createElement: (type, props, ...children) => {
    const element = { type, props: { ...(props ?? {}) } }
    if (children.length > 0) element.props.children = children.length === 1 ? children[0] : children
    return element
  },
}
const primitives = { Toast: Symbol('Toast'), IconWarningOutlineRegular: Symbol('IconWarningOutlineRegular') }
const required = []
const fakeRequire = (spec) => {
  required.push(spec)
  if (spec === 'react') return React
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require("${spec}")`)
}

await import('./client.js')

eq(registered.length, 1, '注册了一个 bundle')
const bundle = registered[0]
eq(bundle.id, pkg.name, 'bundle id === package.json name（扫描器按行 id 匹配）')

const clientExports = bundle.factory(fakeRequire)
ok(typeof clientExports.apply === 'function', '导出 apply')
ok(typeof clientExports.inject === 'object' && clientExports.inject !== null, '导出 inject')
ok(clientExports.inject.includes('uiWorkspace') && clientExports.inject.includes('uiSession') && clientExports.inject.includes('slots'), 'inject 声明了 uiWorkspace/uiSession/slots')
const SEEDS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit']
ok(required.every((spec) => SEEDS.includes(spec)), '只 require 平台静态 seed 词', required.join(', '))
eq(pkg.dsh.client.platform, 'web', 'package.json 声明 dsh.client.platform = web')
eq(pkg.exports['./client'], './client.js', 'package.json 声明 exports["./client"]')

// ─────────────────────────────────────────────────────────────── B：提醒识别
console.log('client.js / 提醒识别')

const { __internals } = clientExports
ok(typeof __internals.noticeOf === 'function', '导出 noticeOf 供自测')
const noticeEvent = (seq, sourceKind, marker, key = 'alarm#4') => ({
  type: 'event',
  event: {
    type: 'user/message',
    seq,
    time: 1,
    data: {
      content: [{ type: 'text', text: marker ? '<system-reminder>\n会话卫生自检（session-hygiene 插件自动注入；本条不是用户请求）' : '普通消息' }],
      source: { ...(sourceKind === undefined ? {} : { kind: sourceKind }), form: 'notice', summary: 'session-hygiene alarm: turn 42, 输入 ≈ 150k tokens', key },
    },
  },
})
eq(__internals.noticeOf([noticeEvent(1, 'session-hygiene', true)]).key, 'alarm#4', '主路径：按 source.kind 认出提醒')
const stripped = noticeEvent(7, undefined, true)
delete stripped.event.data.source.key
eq(__internals.noticeOf([stripped]).key, 'text@7', '退化路径：来源字段缺失时按文本标记认出（无 key 时退回 seq）')
eq(__internals.noticeOf([noticeEvent(1, 'user', false)]), null, '普通用户消息不触发')
eq(__internals.noticeOf([noticeEvent(1, 'session-hygiene', true), noticeEvent(2, 'user', false)])?.key, 'alarm#4', '取窗口内最新的一条提醒')
eq(__internals.noticeOf([noticeEvent(1, 'session-hygiene', true, 'warn#1'), noticeEvent(9, 'session-hygiene', true, 'alarm#4')])?.key, 'alarm#4', '多档并存时取最新一条')

console.log('client.js / 续接标题继承')
eq(__internals.nextTitle('DSH 宿主插件线'), 'DSH 宿主插件线 2', '首次续接：追加序号 2')
eq(__internals.nextTitle('DSH 宿主插件线 2'), 'DSH 宿主插件线 3', '再续：序号递增')
eq(__internals.nextTitle('会话标题 · 7'), '会话标题 8', '分隔符 · 也识别')
eq(__internals.nextTitle('继续会话'), null, '泛化标题不继承')
eq(__internals.nextTitle('继续会话 3'), null, '泛化标题带序号也不继承')
eq(__internals.nextTitle(''), null, '空标题不继承')
eq(__internals.nextTitle(undefined), null, '缺标题不继承')

console.log('client.js / 交接标记与首句')
const MODE_CONTINUE_REPLY = [
  '已落盘交接。',
  'HANDOFF: /Users/x/.dsh/handoff/2026-10-28-session-hygiene.md',
  'MODE: continue',
  'NEXT: 补全交接轮与首句',
].join('\n')
const parsed = __internals.parseHandoff(MODE_CONTINUE_REPLY)
eq(parsed.path, '/Users/x/.dsh/handoff/2026-10-28-session-hygiene.md', '解析 HANDOFF 路径')
eq(parsed.mode, 'continue', '解析 MODE: continue')
eq(parsed.next, '补全交接轮与首句', '解析 NEXT')

const waitParsed = __internals.parseHandoff('`HANDOFF: /x/.dsh/handoff/2026-10-28-a.md`\nMODE: wait')
eq(waitParsed.path, '/x/.dsh/handoff/2026-10-28-a.md', '容忍反引号包裹的路径')
eq(waitParsed.mode, 'wait', '解析 MODE: wait')

eq(__internals.parseHandoff('随便写了点东西，没给标记').path, null, '无标记时不编造路径')
eq(__internals.parseHandoff('见 .dsh/handoff/2026-10-28-b.md').path, '.dsh/handoff/2026-10-28-b.md', '无标记时退化为正文捞路径')
eq(__internals.parseHandoff('HANDOFF: /x/a.md\nNEXT: 等待新任务').mode, 'wait', 'MODE 缺失时按 NEXT 措辞推断 wait')
eq(__internals.parseHandoff('HANDOFF: /x/a.md\nNEXT: 继续修渲染').mode, 'continue', 'MODE 缺失时按 NEXT 措辞推断 continue')
eq(__internals.parseHandoff('HANDOFF: /x/.dsh/handoff/2026-10-28-c.md，新会话继续').path, '/x/.dsh/handoff/2026-10-28-c.md', '剥掉路径后的句末标点')
eq(__internals.parseHandoff('HANDOFF: `/x/.dsh/handoff/2026-10-28-d.md`（交接完成）').path, '/x/.dsh/handoff/2026-10-28-d.md', '剥掉反引号与全角括号注释')

// 一轮里会落多条 assistant 消息：标记可能在倒数第二条，最后一条只是「已完成」。
const multiAssistant = [
  { type: 'event', event: { type: 'assistant/message', seq: 1, data: { content: [{ type: 'text', text: '我先看看仓库。' }] } } },
  { type: 'event', event: { type: 'assistant/message', seq: 2, data: { content: [{ type: 'text', text: MODE_CONTINUE_REPLY }] } } },
  { type: 'event', event: { type: 'assistant/message', seq: 3, data: { content: [{ type: 'text', text: '已完成交接。' }] } } },
]
ok(__internals.handoffText(multiAssistant).includes('HANDOFF:'), '标记在倒数第二条时也能捞到')
eq(__internals.lastAssistantText(multiAssistant), '已完成交接。', 'lastAssistantText 仍取最后一条')
eq(__internals.assistantCount(multiAssistant), 3, 'assistantCount 计满三条')
// 裸事件形状（无 `type:'event'` 包装）也要能读。
const rawEntries = [{ type: 'assistant/message', seq: 9, data: { content: [{ type: 'text', text: MODE_CONTINUE_REPLY }] } }]
eq(__internals.assistantCount(rawEntries), 1, '裸事件形状也计入 assistant 条数')
ok(__internals.lastAssistantText(rawEntries).includes('HANDOFF:'), '裸事件形状也能取正文')

const continuePrompt = __internals.composeFirstPrompt({ title: 'T 2', path: '/x/.dsh/handoff/a.md', mode: 'continue', next: '继续 A' })
ok(continuePrompt.startsWith('继续会话｜T 2'), '继续态：首句仍以「继续会话」开头（命中 resume 规则）')
ok(continuePrompt.includes('handoff: /x/.dsh/handoff/a.md'), '继续态：首句带 handoff 路径')
ok(continuePrompt.includes('一句话任务：继续 A'), '继续态：首句带一句任务提示')
ok(!continuePrompt.includes('上一会话最后的请求'), '继续态：首句不带旧请求长文本（首屏噪音）')
ok(continuePrompt.split('\n').length <= 4, '继续态：首句压到 4 行以内')
const waitPrompt = __internals.composeFirstPrompt({ title: 'T 2', path: '/x/.dsh/handoff/a.md', mode: 'wait', next: '等待新任务' })
ok(!waitPrompt.startsWith('继续会话'), '等待态：首句不得以「继续会话」开头（否则执行假想任务）')
ok(waitPrompt.includes('等待新任务'), '等待态：要求新会话只等新任务')
ok(waitPrompt.includes('handoff: /x/.dsh/handoff/a.md'), '等待态：仍带上 handoff 路径')
const waitNoPath = __internals.composeFirstPrompt({ title: null, path: null, mode: 'wait', next: null })
ok(waitNoPath.includes('LATEST.md'), '等待态无路径时指向 LATEST.md（不引用不存在的 handoff）')
const degraded = __internals.composeFirstPrompt({ title: 'T 2', path: null, mode: null, hint: '把交接补全', lastReply: '跑到一半了' })
ok(degraded.startsWith('继续会话｜T 2'), '未落盘：仍以「继续会话」开头')
ok(degraded.includes('没能自动落盘') && degraded.includes('把交接补全') && degraded.includes('跑到一半了'), '未落盘：提示先确认任务，并附旧会话最后请求/最后回复')
const instr = __internals.handoffInstruction('T 2')
ok(instr.includes('T 2') && instr.includes('无未完任务') && instr.includes('MODE: continue 或 wait'), '落盘指令：带记录键、无任务措辞与标记契约')
eq(__internals.baseNameOf('/x/.dsh/handoff/a.md'), 'a.md', 'baseNameOf 只取文件名')
eq(__internals.HANDOFF_TIMEOUT_MS >= 30_000, true, '交接轮超时给足几十秒')

// ─────────────────────────────────────────────────────────────── C：点击路径
console.log('client.js / 点击路径')

/** 造一个 client ctx：记录调用，只对 `session-old`（有提醒）与 `session-new`（新建）给出会话。 */
function makeClientCtx(options = {}) {
  const calls = { create: [], openSession: [], prompt: [], oldPrompt: [], rename: [], order: [], slotsInjectKey: undefined, registered: undefined, slotsRegistered: 0 }
  const newSession = {
    prompt: async (content, mode) => {
      calls.prompt.push({ content, mode })
      calls.order.push('newPrompt')
      return { ok: true, value: { accepted: true } }
    },
  }
  const humanEvent = (seq, text) => ({ type: 'event', event: { type: 'user/message', seq, time: 1, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } } })
  let oldEntries = [humanEvent(0, options.lastUser ?? '把 session-hygiene 的交接补全')]
  // 交接前的既有 assistant 回复（退化首句会把它截断带过去作锚点）。
  if (options.priorReply !== undefined) oldEntries.push({ type: 'event', event: { type: 'assistant/message', seq: 0.5, data: { content: [{ type: 'text', text: options.priorReply }] } } })
  oldEntries = [...oldEntries, noticeEvent(1, 'session-hygiene', true)]
  let oldRunning = false
  const oldSession = {
    eventSource: { getSnapshot: () => ({ entries: oldEntries }), subscribe: () => () => {} },
    getSnapshot: () => ({ running: oldRunning }),
    subscribe: () => () => {},
    prompt: async (content, mode) => {
      calls.oldPrompt.push({ content, mode })
      calls.order.push('oldPrompt')
      if (options.oldPromptFails) return { ok: false, error: { message: 'session/writer-held' } }
      // 模拟「这一轮已经跑完」：running 翻真后立刻落一条 assistant 事件并转假。
      oldRunning = true
      oldEntries = [...oldEntries, { type: 'event', event: { type: 'assistant/message', seq: 100, time: 1, data: { content: [{ type: 'text', text: options.oldReply ?? '' }] } } }]
      oldRunning = false
      return { ok: true }
    },
  }
  const ctx = {
    effect: (execute) => execute(),
    slots: {
      inject: (key, callback) => {
        calls.slotsInjectKey = key
        return callback()
      },
      register: (options_, component) => {
        calls.registered = { options: options_, component }
        calls.slotsRegistered += 1
        return () => {}
      },
    },
    sessions: {
      binding: (id) => (id === 'session-old' ? { session: oldSession } : id === 'session-new' ? { session: newSession } : undefined),
      create: async (opts) => {
        calls.create.push(opts)
        calls.order.push('create')
        return 'session-new'
      },
      // 真实形状：列表投影快照店（`list.getSnapshot().byId[id].title` 是宿主持久标题）。
      list: {
        getSnapshot: () => ({
          ids: ['session-old'],
          byId: options.oldTitle === undefined ? {} : { 'session-old': { id: 'session-old', title: options.oldTitle } },
        }),
      },
      rename: async (...args) => {
        calls.rename.push(args)
        calls.order.push('rename')
        if (options.renameShape === 'object' && typeof args[0] === 'string') throw new Error('expected object form')
        return { ok: true, value: { title: 'normalized', seq: 1 } }
      },
    },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-1', sessionIds: ['session-old'] }] }) } },
    uiSession: { current: { getSnapshot: () => ({ key: 'session-old' }), subscribe: () => () => {} } },
    uiWorkspace: { openSession: (id) => calls.openSession.push(id) },
  }
  return { ctx, calls }
}

/** 点击路径发出的新会话首句正文。 */
const firstPromptOf = (calls) => calls.prompt[0]?.content?.[0]?.text ?? ''

const first = makeClientCtx({ oldReply: MODE_CONTINUE_REPLY })
clientExports.apply(first.ctx)
eq(first.calls.slotsInjectKey, 'shell.overlay', '注册进 shell.overlay')
eq(first.calls.registered.options.name, 'shell.overlay', 'slot name 正确')
eq(first.calls.registered.options.id, 'session-hygiene.bar', 'list slot 带 id（否则 register 抛错）')
eq(first.calls.slotsRegistered, 1, '注册一次确认条')

const tree = first.calls.registered.component({})
const barElement = tree.props.children[0]
ok(barElement !== null && barElement !== undefined, '有提醒时渲染确认条')
ok(String(barElement.props.text ?? '').includes('150k tokens'), '确认条带证据文本', String(barElement.props.text))
ok(barElement.props.icon !== undefined, '确认条带警示图标')
const actions = barElement.props.actions ?? []
const switchAction = actions.find((action) => action.label === '切换并继续')
const ignoreAction = actions.find((action) => action.label === '忽略')
ok(switchAction !== undefined, '提供「切换并继续」动作')
ok(ignoreAction !== undefined, '提供「忽略」动作')

await switchAction.onClick()
eq(JSON.stringify(first.calls.create), JSON.stringify([{ workspaceId: 'ws-1' }]), '按当前 workspace 新建会话')
eq(JSON.stringify(first.calls.openSession), JSON.stringify(['session-new']), '切换主视图到新会话')
eq(first.calls.oldPrompt.length, 1, '切换前先让旧会话落盘 handoff')
ok(String(first.calls.oldPrompt[0].content[0].text).includes('正在记录本会话状态并转交新会话'), '交接轮指令首行即「正在记录并转交」')
eq(first.calls.order[0], 'oldPrompt', '交接轮发生在新建会话之前（先写完再切）')
ok(firstPromptOf(first.calls).startsWith('继续会话'), '无持久标题时新会话首句仍以「继续会话」开头')
ok(firstPromptOf(first.calls).includes('handoff: /Users/x/.dsh/handoff/2026-10-28-session-hygiene.md'), '首句转交 handoff 路径')
ok(firstPromptOf(first.calls).includes('一句话任务：补全交接轮与首句'), '首句带 NEXT（自动生成的任务提示）')
ok(!firstPromptOf(first.calls).includes('上一会话最后的请求'), '交接成功时首句不带旧请求长文本')
eq(first.calls.rename.length, 0, '无持久标题时不发起改名')
ok(String(localStorageStub.getItem('dsh-session-hygiene:dismissed:session-old')).includes('alarm#4'), '切换后记住该档，不再打扰旧会话')

// 标题投影读取（纯函数）
eq(__internals.titleFromSnapshot({ byId: { a: { title: 'T' } } }, 'a'), 'T', 'byId 形状取到标题')
eq(__internals.titleFromSnapshot({ items: [{ sessionId: 'a', title: 'T' }] }, 'a'), 'T', 'items 降级形状取到标题')
eq(__internals.titleFromSnapshot({ byId: { a: { displayTitle: 'KMP' } } }, 'a'), null, '只有 displayTitle 时不算标题')
eq(__internals.titleFromSnapshot(undefined, 'a'), null, '快照缺失不抛')

console.log('client.js / 标题继承（点击路径 · 2026-10-15 误接续回归）')

/** 点一次「切换并继续」，返回该实例的调用记录。 */
async function clickSwitch(fake) {
  const tree = fake.calls.registered.component({})
  const bar = tree.props.children[0]
  const action = (bar.props.actions ?? []).find((item) => item.label === '切换并继续')
  await action.onClick()
  return fake.calls
}

// 回归 1：假 ctx 上没有 `sessions.get`（正是事故现场），标题仍须继承
localStorageStub.store.clear()
const titled = makeClientCtx({ oldTitle: 'DSH 宿主插件线' })
clientExports.apply(titled.ctx)
const titledCalls = await clickSwitch(titled)
eq(JSON.stringify(titledCalls.rename), JSON.stringify([['session-new', 'DSH 宿主插件线 2']]), '按真实契约以位置参数 rename(sessionId, title)')
ok(firstPromptOf(titledCalls).startsWith('继续会话｜DSH 宿主插件线 2'), '首句携带继承标题（resume 规则据此定位交接）')
const noteTitled = JSON.parse(localStorageStub.getItem(__internals.INHERIT_KEY) ?? '{}')
eq(noteTitled.oldTitle, 'DSH 宿主插件线', '留痕记录读到的旧标题')
eq(noteTitled.next, 'DSH 宿主插件线 2', '留痕记录继承结果')
eq(noteTitled.renamed, true, '留痕记录改名成功')

// 回归 2：泛化标题不继承，但不再静默
localStorageStub.store.clear()
const generic = makeClientCtx({ oldTitle: '继续会话' })
clientExports.apply(generic.ctx)
const genericCalls = await clickSwitch(generic)
eq(genericCalls.rename.length, 0, '泛化标题不发起改名')
eq(firstPromptOf(genericCalls).startsWith('继续会话｜'), false, '泛化标题时首句不带 ｜<标题>')
ok(firstPromptOf(genericCalls).startsWith('继续会话'), '泛化标题仍以「继续会话」开头')
eq(JSON.parse(localStorageStub.getItem(__internals.INHERIT_KEY) ?? '{}').next, null, '留痕标 next=null（本次未继承）')

// 回归 3：宿主契约漂移成对象形式时仍能改名（位置参数失败后兜底）
localStorageStub.store.clear()
const drifted = makeClientCtx({ oldTitle: 'AGP 10 迁移', renameShape: 'object' })
clientExports.apply(drifted.ctx)
const driftedCalls = await clickSwitch(drifted)
eq(driftedCalls.rename.length, 2, '位置参数失败后改试对象形式')
eq(JSON.stringify(driftedCalls.rename[1]), JSON.stringify([{ sessionId: 'session-new', title: 'AGP 10 迁移 2' }]), '对象形式参数正确')

// 回归 4（2026-10-28）：旧会话说「没有未完任务」→ 新会话只等新任务，别去执行假想任务
localStorageStub.store.clear()
const waitMode = makeClientCtx({ oldTitle: 'AGP 10 迁移', oldReply: 'HANDOFF: /x/.dsh/handoff/2026-10-28-done.md\nMODE: wait\nNEXT: 等待新任务' })
clientExports.apply(waitMode.ctx)
const waitCalls = await clickSwitch(waitMode)
ok(!firstPromptOf(waitCalls).startsWith('继续会话'), '等待态首句不以「继续会话」开头')
ok(firstPromptOf(waitCalls).includes('没有未完任务'), '等待态首句明说没有未完任务')
ok(firstPromptOf(waitCalls).includes('等待新任务'), '等待态要求新会话只等新任务')
ok(firstPromptOf(waitCalls).includes('handoff: /x/.dsh/handoff/2026-10-28-done.md'), '等待态仍转交 handoff 路径')

// 回归 5：旧会话没按标记回复 → 退化首句要求先确认任务（不猜任务）
localStorageStub.store.clear()
const unmarked = makeClientCtx({ oldTitle: 'AGP 10 迁移', oldReply: '好的，我知道了。', lastUser: '把交接轮补上', priorReply: '已改完首句生成，下一步要跑 selftest' })
clientExports.apply(unmarked.ctx)
const unmarkedCalls = await clickSwitch(unmarked)
ok(firstPromptOf(unmarkedCalls).startsWith('继续会话｜AGP 10 迁移 2'), '未落盘：仍以「继续会话」开头并继承标题')
ok(firstPromptOf(unmarkedCalls).includes('没能自动落盘'), '未落盘：明说交接没落盘')
ok(firstPromptOf(unmarkedCalls).includes('把交接轮补上'), '未落盘：附旧会话最后一句请求')
ok(firstPromptOf(unmarkedCalls).includes('已改完首句生成'), '未落盘：附旧会话最后一条回复截断片段')

// 回归 6：交接轮发不出去（writer held）→ 不阻断切换，退化成「先确认任务」首句
localStorageStub.store.clear()
const failed = makeClientCtx({ oldPromptFails: true, lastUser: '跑 selftest' })
clientExports.apply(failed.ctx)
const failedCalls = await clickSwitch(failed)
eq(JSON.stringify(failedCalls.create), JSON.stringify([{ workspaceId: 'ws-1' }]), '交接失败仍然新建会话')
ok(firstPromptOf(failedCalls).includes('没能自动落盘'), '交接失败时用退化首句')
ok(firstPromptOf(failedCalls).includes('跑 selftest'), '交接失败时仍附旧会话最后一句请求')

// 「忽略」：另起一个实例，保证状态干净
localStorageStub.store.clear()
const second = makeClientCtx()
clientExports.apply(second.ctx)
const ignoreTree = second.calls.registered.component({})
const ignoreBar = ignoreTree.props.children[0]
const ignore = (ignoreBar.props.actions ?? []).find((action) => action.label === '忽略')
ignore.onClick()
eq(second.calls.create.length, 0, '「忽略」不新建会话')
eq(second.calls.openSession.length, 0, '「忽略」不切换视图')
ok(String(localStorageStub.getItem('dsh-session-hygiene:dismissed:session-old')).includes('alarm#4'), '「忽略」只记住该档')

// ─────────────────────────────────────────────────────────────── D：宿主半边
console.log('index.mjs')

const host = await import('./index.mjs')
eq(host.name, 'session-hygiene', '宿主插件 name')

let preStep
const hostCtx = { logger: { warn: () => {}, debug: () => {} }, on: (event, handler) => { if (event === 'agent/pre-step') preStep = event === 'agent/pre-step' ? handler : preStep } }
host.apply(hostCtx, { enabled: true })
ok(typeof preStep === 'function', '注册了 agent/pre-step 处理器')

const now = Date.now()
const agent = {
  session: {
    events: [
      { type: 'user/message', time: now, data: { source: { kind: 'user' } } },
      { type: 'assistant/message', time: now, data: { usage: { inputTokens: 100000, cacheReadTokens: 50000 } } },
      { type: 'compaction/summary', time: now, data: {} },
    ],
  },
}
const claimed = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
const decision = await preStep({ agent, messages: claimed, turn: 20, step: 2, signal: undefined }, async () => ({ kind: 'proceed', messages: claimed.slice() }))
const injected = (decision.messages ?? []).filter((message) => message?.source?.kind === 'session-hygiene')
eq(injected.length, 1, 'alarm 档注入一条提醒')
eq(injected[0].source.key, 'alarm#2', 'key = tier#turnBucket（turn 20 / recheckTurns 10）')
eq(injected[0].source.form, 'notice', '来源 form = notice')
ok(injected[0].content[0].text.includes(host.NOTICE_MARKER), '注入文本含 client 侧识别标记')
ok(injected[0].content[0].text.includes('无未完任务'), '注入文本要求「没有待办就写明等新任务」')
ok(injected[0].content[0].text.includes('HANDOFF:') && injected[0].content[0].text.includes('MODE: continue'), '注入文本带交接三行标记契约（与 client 解析一致）')
eq(decision.messages[decision.messages.length - 1].content[0].text.includes(host.NOTICE_MARKER), true, '提醒排在已 claim 消息之后（前缀稳定、KV cache 友好）')

const again = await preStep({ agent, messages: decision.messages, turn: 21, step: 3, signal: undefined }, async () => ({ kind: 'proceed', messages: decision.messages.slice() }))
eq((again.messages ?? []).filter((message) => message?.source?.kind === 'session-hygiene').length, 1, '同档同桶幂等：不重复注入')

const greenAgent = { session: { events: [{ type: 'user/message', time: now, data: { source: { kind: 'user' } } }] } }
const green = await preStep({ agent: greenAgent, messages: claimed, turn: 3, step: 1, signal: undefined }, async () => ({ kind: 'proceed', messages: claimed.slice() }))
eq(green.messages.length, 1, 'green 档不注入')

let onCalls = 0
host.apply({ logger: {}, on: () => { onCalls += 1 } }, { enabled: false })
eq(onCalls, 0, 'enabled:false 时完全不注册')

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)