# session-hygiene —— 达阈值提醒，并在浏览器侧「一键」把 UI 切到新会话

创建日期：2026-10-15 · host：DSH Desktop v0.2.0-rc.2（`DSH_PROFILE=desktop`，http://127.0.0.1:19387）+ `web`
实现：`~/.dsh/plugins/session-hygiene/`（**插件包**）· 挂载：`profiles/{desktop,web}/cordis.patch.yml` 的 `- insert:` 块

## 1. 为什么从单文件 `.mjs` 改成插件包

原来的 `session-hygiene.mjs` 只有宿主半边：它能算出「历史已经大到该交接」，也能提醒模型，但**没法替你点「新会话」**。原因是结构性的，不是没想到：

| 事实 | 证据（v0.2.0-rc.2，路径相对 `app.asar/dsh/`） |
|---|---|
| 切换/新建会话是**浏览器**动作 | `@deepseek-ai/dsh-client-ui-workspace/lib/client.js:821` `openSession`、`:846` `startSession` |
| 宿主→浏览器**没有**通用推送通道 | 转发白名单编译期固定：`@deepseek-ai/dsh-api-remotes/lib/types/remote-events.js:12-39`（27 条，改一条要重构建） |
| 宿主新建会话时浏览器**不会**自己跳 | 客户端只 `mergeSummary`/`handleBlank`（`dsh-api-session-controller/lib/client.js:2828`）；`uiWorkspace.watchNavigation` 只在启动时恢复上次选中（`:894-924`） |
| 客户端插件的发现只认**包声明** | `dsh-client-modules/lib/index.js:714-719`：必须有 `dsh.client.platform === "web"` 与 `exports["./client"]`；`cordis.patch.yml` 里没有任何 client 字段 |

所以现在的形态是**一个插件包、两个半边**：宿主半边（检测+注入提醒，逻辑与旧版逐字相同）+ 浏览器半边（`client.js`，读提醒→弹确认条→建会话→切主视图→发第一句）。

## 2. 安装位置（单真源 + 每 profile 一个软链）

| 角色 | 路径 |
|---|---|
| 实现（唯一真源） | `~/.dsh/plugins/session-hygiene/{package.json,index.mjs,client.js,selftest.mjs}` |
| 软链（目录软链，不是文件） | `~/.dsh/profiles/{desktop,web}/session-hygiene` → `../../plugins/session-hygiene` |
| 挂载行 | 各 profile `cordis.patch.yml`：`- id: session-hygiene, name: ./session-hygiene/index.mjs` |
| 旧单文件实现（回滚用） | `~/.dsh/plugins/session-hygiene.mjs.bak-20261015` |

要点（都踩过）：
- loader 解析 `name` 后会 **realpath**，所以路径要落到「有 `package.json` 的目录」里；`~/.dsh/plugins/` 自身没有 `package.json`，`~/.dsh/plugins/foo.client.mjs` 这种孤立文件加载不了。
- bundle 里 `window.__ModuleLoader__.load({ id })` 的 `id` **必须**等于 `package.json` 的 `name`（`dsh-session-hygiene`），否则报 `loaded without registering`。
- `client.js` 必须是 **classic script**（不能有 `import`/`export`），只 `require` 平台静态 seed 词（`react`、`@deepseek-ai/dsh-client-ui-primitives`），因此 package.json 里不需要 `dsh.client.external`。

## 3. 行为

**宿主半边**（与旧版逐字相同，`renderText` 输出已做字节级比对）：在 `agent/pre-step` 增量扫描会话日志，算「最近一次请求总输入 tokens / 是否压缩 / 真实人类请求数 / 跨天」，达 warn/alarm 档注入一条 `<system-reminder>`（`source = { kind:'session-hygiene', form:'notice', key:'tier#turnBucket', summary }`），按档位幂等，排在已 claim 消息之后（前缀稳定、KV cache 友好）。

**浏览器半边**（新增）：
1. 只盯**当前主会话**的事件流；窗口里出现最新的 `source.kind === 'session-hygiene'` 消息（来源字段缺失时退化为按文本标记 `session-hygiene 插件自动注入` 识别）→ 页面顶部弹一条**常驻** Toast：
   `turn 42, 输入 ≈ 150k tokens（alarm）· 交接到新会话并继续？　切换并继续　忽略`
2. 当前轮还在跑时不显示「切换并继续」（避免在模型写完 handoff 前就切走）；本轮一结束自动出现。
3. 点「切换并继续」→ **先让旧会话落盘 handoff**（向旧会话发一条交接指令并等这一轮跑完，上限 90s）→ `ctx.sessions.create({ workspaceId: 当前会话所属 workspace })` → `ctx.uiWorkspace.openSession(新id)` → 新会话第一句按交接结果分三种（继续 / 没有未完任务只等新任务 / 交接没落盘先确认）→ 记住旧会话这条档位不再提醒。细节见文末「2026-10-28 交接转交」。
4. 点「忽略」→ 只记住该档位（`localStorage`，前缀 `dsh-session-hygiene:dismissed:<sessionId>`），不新建、不切换；档位/桶更新后仍会提示。
5. 失败（例如交接轮 `session/writer-held`）→ 仍会切到新会话，只是首句退化为「交接没落盘，先确认任务」，并在顶部提示原因；绝不打断会话。

## 4. 配置

| 字段 | 默认 | 位置 | 含义 |
|---|---|---|---|
| `enabled` | `true` | patch `config` | false 时宿主半边完全不注册 |
| `tokensWarn` / `tokensAlarm` | `120000` / `150000` → **`140000` / `175000`**（2026-10-15 调高，见文末） | patch `config` | 档位阈值（总输入 = `inputTokens + cacheReadTokens + cacheWriteTokens`） |
| `promptsWarn` / `promptsMinTokens` | `4` / `60000` → **`6` / `90000`**（2026-10-15 调高，见文末） | patch `config` | 多目标信号 |
| `minTurnsForDaySwitch` / `recheckTurns` | `12` / `10` | patch `config` | 跨天信号；`recheckTurns` 决定 `key` 的桶宽（多久允许再提醒一次） |
| `debugFile` | `''` | patch `config` | 诊断日志；当前 patch 里指向 `~/.dsh/session-hygiene.log`，验证通过后删掉即可（及其文件） |
| `FIRST_PROMPT` | `继续会话` | **`client.js` 常量** | 浏览器半边**拿不到** patch 的 config（客户端 entry 只收到 `{name}`），故第一句与「忽略」存储前缀写死在 client.js |

## 5. 验证证据

**离线自测（不需要 DSH/浏览器，两个半边一起测）**：`node ~/.dsh/plugins/session-hygiene/selftest.mjs` → 38 项全绿，覆盖 bundle id=`package.json` name、只 require seed 词、提醒识别（主路径+退化路径+取最新）、点击路径（`create({workspaceId})` → `openSession` → `prompt([{type:'text',text:'继续会话'}],'queue')`）、忽略不新建、宿主 alarm 注入/幂等/green 不注入/enabled:false 不注册。

**配置被 DSH 自己解析**（用 app.asar 里的 `js-yaml` + `dsh-app-boot` 的 `!!js` schema 跑真解析）：
```
desktop | top-level entries = 13 | session-hygiene mount = {"id":"session-hygiene","name":"./session-hygiene/index.mjs","enabled":true}
web     | top-level entries = 5  | session-hygiene mount = {"id":"session-hygiene","name":"./session-hygiene/index.mjs","enabled":true}
```

**路径解析**：`profiles/{desktop,web}/session-hygiene/index.mjs` → realpath `~/.dsh/plugins/session-hygiene/index.mjs` → 最近 `package.json` name = `dsh-session-hygiene`，`exports["./client"] = ./client.js`。

**上线后仍需你在真机点一次**（本次会话不能重启自己，故这一段未取证）：
1. 重启 DSH（见 §6），会话跑到阈值；
2. 页面顶部应出现确认条，文案带 `turn … 输入 ≈ …k tokens`；
3. 点「切换并继续」→ 左侧出现新会话、主视图已切过去、新会话第一条是你发的 `继续会话`（模型随后读 `LATEST.md`）；
4. 回到旧会话：确认条不再出现（已记住该档）。

## 6. 约束、回滚与顺带发现

**约束**
- **新增/删除 client 插件必须重启 DSH**：HMR 只对「已进入启动图的插件行」做内容热替换（宿主每 500ms stat bundle → SSE → 浏览器原地重建 fiber），新增行不会自动进图。
- 浏览器半边只对**当前主会话**生效；子代理会话不参与。
- 「忽略」记忆在浏览器 `localStorage`（同一 profile 的窗口共享；换窗口/清缓存会重置）。

**回滚**（三步，任一步单独执行都不破坏会话）
1. 删掉两个 profile patch 里的 session-hygiene `insert` 块（或把 `name:` 改回 `./session-hygiene.mjs`）；
2. `rm ~/.dsh/profiles/{desktop,web}/session-hygiene`，`mv ~/.dsh/plugins/session-hygiene.mjs.bak-20261015 ~/.dsh/plugins/session-hygiene.mjs`；
3. 重启 DSH。

**顺带发现（值得单独记一笔）**：宿主半边在当前 desktop profile 里**自 2026-10-09 之后再没生效过**。证据：`~/.dsh/sessions/**` 共 74 份会话日志，只有 1 份（`session-95545f74…`，2026-10-09）含 `"kind":"session-hygiene"` 注入；desktop 的 insert 块是 10-14 18:22 才写进 patch 的，而进程自 10-13 09:29 起未重启（`~/Library/Application Support/@deepseek-ai/dsh-desktop/TransportSecurity` mtime），期间也没有 `~/.dsh/session-hygiene.log`（`apply()` 一挂载就会写 `mount: apply() called`）→ **运行中的图是旧的**。所以这次重启同时修好宿主半边，值得上线后立刻确认提醒重新出现。
## 7. 续接会话标题继承（2026-10-15 追加）

**问题**：DSH 会话标题取首条用户消息（`session/title`：先 fallback 抄原句，再由 `session-title-first-prompt-llm` 起名），
而「切换并继续」固定发「继续会话」→ 续接会话全同名，会话列表里认不出是哪条（2026-10-15 实际选错任务）。

**行为**：点「切换并继续」时，客户端半边读旧会话标题 → `nextTitle()`（`X` → `X 2`；`X N` → `X N+1`；泛化标题不继承）
→ `ctx.sessions.create` → `ctx.sessions.rename({sessionId, title})`（不可用则跳过）→ `uiWorkspace.openSession`
→ 发送首句 `继续会话｜<新标题>`（宿主标题 LLM 据此起同主题标题，兜底 rename 不可用的情况）。

**验证**：`node ~/.dsh/plugins/session-hygiene/selftest.mjs`（含 9 条标题继承断言）；
真机：切换后新会话标题应为 `<旧标题> 2`，其上第一条用户消息应为 `继续会话｜<新标题>`。

## 2026-10-15 阈值调高（缓存计费前提变更）

- 触发原因：用户实测/判断**缓存命中不计费** → 本插件原 alarm 理由「历史重发成本已显著」不再成立；
  只剩「临近压缩前留交接余量」这一条硬理由（压缩点实测 ≈19.8 万，`compaction-basic.thresholdRatio 0.6`）。
- 现值（`~/.dsh/profiles/desktop/cordis.patch.yml` → `session-hygiene.config`）：
  `tokensWarn 120000 → 140000`、`tokensAlarm 150000 → 175000`、`promptsWarn 4 → 6`、`promptsMinTokens 60000 → 90000`。
  旧值已在上表同行标注，回滚即填回。
- `compactions > 0` 仍是无条件 alarm，压缩后必然提醒 —— 该路径未改，不依赖 tokens 阈值。
- **生效条件：宿主半边（index.mjs）与挂载 config 都在 DSH 启动时读取 → 需重启 DSH Desktop**（客户端半边的改动则走 HMR 热重载，不需要重启）。
- 锚定：2026-10-15 · 插件 `~/.dsh/plugins/session-hygiene` · 工作区 `~/KMP` · 分支 `feature/cmp-dynamic-framework` @ `3b0682747e2`（脏树，与本插件改动无关）。

## 2026-10-28 交接转交：切换前必写 handoff，首句按「有待办 / 无待办」分派（本节锚定）

**背景（用户实测反馈）**：达阈值点「切换并继续」时，旧会话并没有把 handoff 写完就切走，
新会话只收到一句 `继续会话` → 自己去分析「该继续做什么」，有任务时接错、没任务时拿 token 空转。

**行为（现态）**：`client.js` 的点击路径拆成「交接轮 → 建会话 → 分派首句」三段：

1. **交接轮**（新增 `handoffInstruction()` / `writeHandoff()`）：先向**旧会话**发一条
   `【会话卫生 · 交接落盘】` 指令 —— 按 session-handoff skill 落盘、`下一步` 必须放文末、
   没有待办就明写「无未完任务：新会话不要执行任何任务，只等待用户输入新任务」；
   然后 `waitTurn()` 等这一轮跑完（`running` 由真转假 / assistant 条数增加 / 90s 超时，任一即收尾；
   20s 内 `running` 没翻真就放弃等待，避免 prompt 没起来时白等）。
2. **读标记**（`parseHandoff()`）：从旧会话末尾**带标记**的那条 assistant 文本里读（`handoffText()`，一轮多条消息时也能找到）
   `HANDOFF: <路径>` / `MODE: continue|wait` / `NEXT: <一句话>`；缺路径时退化为正文里捞
   `.dsh/handoff/**.md`；`MODE` 缺失时按 `NEXT` 措辞推断。
3. **首句分派**（`composeFirstPrompt()`）：
   - `continue` → `继续会话｜<新标题>` + `handoff: <路径>` + `下一步 = <NEXT>`；
   - `wait` → `会话交接｜<新标题>（没有未完任务）` + `handoff: <路径>` + 「只回一行『已读交接，等待新任务』」，
     **刻意不用「继续会话」开头**：那句命中 user-global 的 `session-handoff-resume`，会把新会话拖去执行假想任务；
   - 未落盘 / 交接轮失败（如 `session/writer-held`）→ 仍以 `继续会话｜…` 开头，但明写
     「交接没能自动落盘」+ 附旧会话最后一句人类请求（`（仅供参考）`），要求新会话**先问再做**。
4. 交接轮与建会话期间确认条显示阶段文案（`handoff` → 「正在让当前会话写 handoff…」，
   `switching` → 「正在新建会话并切换…」）；交接轮只留一个「跳过交接直接切换」逃生按钮
   （置 `skipHandoff`，不再等模型写完，按退化首句切换），避免模型卡住时用户干等 90s。
5. 顶部提示改成结果回执：`已切到新会话（标题：X）· handoff: 2026-10-28-foo.md（无未完任务，新会话只等新任务）`。

**宿主半边同步**：`index.mjs` 的 `renderText` 增加两条要求 ——「下一步」放文末并给出无待办写法、
回复末三行给 `HANDOFF:/MODE:/NEXT:` 标记（与 client 解析同一套契约；手动说到「新开会话」时也产出可解析标记）。

**验证**（离线，不需要 DSH/浏览器）：
`node ./plugins/session-hygiene/selftest.mjs` → **110 项全绿**。
新增覆盖：标记解析（backtick/缺 MODE 推断/无标记不编造/正文捞路径/路径后跟说明与句末标点）、一轮多条 assistant 时从倒数第二条捞标记、裸事件形状兼容、三种首句措辞、未落盘时附带旧会话最后请求与最后回复截断、
交接轮一定先于 `sessions.create`（`calls.order[0] === 'oldPrompt'`）、
等待态首句不以「继续会话」开头、交接轮失败仍新建会话并退化首句、宿主注入文本带标记契约。

**真机取证待办**（本次不能重启自己）：重启 DSH 后跑到阈值点一次 → 旧会话应出现一条
`【会话卫生 · 交接落盘】` 用户消息并写完 `.dsh/handoff/<YYYY-MM-DD>-*.md`，随后新会话第一条应带
`handoff: <路径>`；没有待办时应为「会话交接…只回一行已读交接，等待新任务」。

**锚定**：2026-10-28 · 插件 `./plugins/session-hygiene`
（该目录**不在 git 仓库内**；profile 侧软链 `~/.dsh/profiles/{desktop,web}/node_modules/dsh-lean-kit` → 本目录）·
工作区 `~/` · 分支/commit：不适用（无 git）。

## 2026-10-28 二次修订：降首屏噪音 + 新会话首轮提速（本节锚定）

用户实测反馈两点（机制已通，观感/时延有问题）：
1. 交接期间旧/新会话都把内容整段摊开，干扰大；希望旧会话只看到「正在记录并转交」，新会话只看到「正在继续会话」。
2. 新会话首条发出后迟迟不回应，怀疑「有大量上下文在交换」。

**改动（只动文案与信息量，交接机制不变）**
- `handoffInstruction()`：首行改成「【会话卫生 · 交接】正在记录本会话状态并转交新会话…」，
  并新增「回复只给三行，不要复述交接正文、不要再总结或解释」→ 旧会话里模型只回 `HANDOFF/MODE/NEXT` 三行。
- `composeFirstPrompt()`：首句压到 3–4 行。
  - continue 态**不再**带旧会话最后请求/最后回复（`hint` 只在「交接没落盘」兜底时出现，截断 120 字）；
  - `NEXT` 独立成行、按分句边界截断 80 字（`clipTask()`，半截括号自动配平），长出的事让新会话读文件；
  - wait 态只要求看 handoff 末尾，不读全篇；
  - continue 态要求「不要复述 handoff、不要先给计划」，省掉一轮「先输出计划」的往返。
- flash 回执改成「正在继续会话：<文件>」/「已交接：<文件>（无未完任务，新会话只等新任务）」，不再贴长路径。
- 宿主 `index.mjs` 注入文本同步加「不要复述交接正文」。

**关于「是不是有很大的上下文在交换」**：**不是**。新会话上下文为空，交接只占一条 3–4 行首句 + 一次
`read`（handoff 文件本身）。慢的是 DSH 新会话首轮的固定 bootstrap（system prompt / skills 索引 / AGENTS / preset 注入）
与「先 read 再规划」的往返；本次去掉了首句里的冗余读入和一次计划往返，剩余固定开销不在插件可控范围。

**验证**：`node ./plugins/session-hygiene/selftest.mjs`
→ **112 项全绿**（上节 110 项为当时实测）。新增/更新断言：首句 ≤4 行、continue 态不带旧请求长文本、
`NEXT` 独立成行、wait 态只读末尾、未落盘兜底仍带旧请求与最后回复（各 ≤120 字）。

**锚定**：2026-10-28 15:52 · 插件 `./plugins/session-hygiene`
（不在 git 仓库内；profile 侧软链 `~/.dsh/profiles/{desktop,web}/node_modules/dsh-lean-kit` → 本目录）· 工作区 `~/`。
（2026-11-26 起本目录已是 GitHub `xxw8393/dsh-lean-kit` 仓库工作区，软链指向 `~/dsh-lean-kit`；详见文末追加节。）

---

## 附：开源化后的路径变更（2026-11-26 追加）

> 本节锚定：2026-11-26 · 仓库 `dsh-lean-kit` · 分支 `main` · commit `80e49b2`（脏树无）· 目录 `~/dsh-lean-kit`。
> 上文各节保持**当时的**路径写法（`~/.dsh/plugins/...`、`~/.dsh-bundles/...`），此处只做现态对照，不改写历史分析。

| 项 | 当时 | 现态 |
|---|---|---|
| 实现目录（唯一真源） | `~/.dsh/plugins/<plugin>/` 或 `~/KMP/.dsh-bundles/lean-kit/` | `~/dsh-lean-kit/plugins/<plugin>/`（= GitHub `xxw8393/dsh-lean-kit`） |
| profile 挂载 | `node_modules/dsh-lean-kit` 软链 → 旧目录 | 软链 → `~/dsh-lean-kit`（`desktop`、`web` 两个 profile 已改） |
| 说明文档 | `.dsh-bundles/README-<topic>.md` | `docs/<topic>.md` |
| 自测入口 | `node ~/.dsh/plugins/<plugin>/selftest.mjs` | `node plugins/<plugin>/selftest.mjs`（或 `npm run selftest`） |
| 注入面核对脚本 | `.dsh-bundles/check-injection.sh` | `scripts/check-injection.sh` |

验收探针（本次实跑）：`bash verify.sh web` / `bash verify.sh desktop` 均通过 —— 入口文件齐、三个 selftest 全绿、`preset` 里 25 个 `name:` 全部可解析。
