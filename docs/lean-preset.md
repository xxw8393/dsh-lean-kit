# 省流模式 preset（lean）— 安装与调优

创建日期：2026-10-09 · 目标：把「每次对话 token 很多」的固定开销与长会话上下文压下来。

## 1. 为什么做这个

实测本机数据（会话 `95545f74`，2026-10-08 → 10-09，共 1449 步）：

| 项 | 数值 |
|---|---|
| `standard` preset 固定开销 | **12.4K tokens/请求**（首步 `input 3076 + cacheRead 9344`） |
| 其中工具 schema | **30.4KB ≈ 8.2K**（37 个工具；`workflow` 单个 3.4KB、`schedule_create` 2.7KB、`schedule_update` 2.5KB） |
| 会话历史 | **中位数 137K tokens/请求**，峰值 199K；98.6% 输入命中前缀缓存 |
| 压缩触发 | `compaction-basic` 默认 `thresholdRatio 0.8`，按 ~256K 路由窗口 ⇒ ~20 万才压缩 |

也就是说：每一步都要重发整段历史。"省 token" 只有两条路——压固定开销，和让历史别长到 10–20 万。

## 2. 文件

```
dsh-lean-kit/
├── package.json             # bundle 声明（dsh.bundle.patch）
├── cordis.patch.yml         # preset-lean 声明（含四个插件段）
└── docs/lean-preset.md      # 本文件
```

## 3. 与 standard 的差异

| # | 改动 | 依据 / 预期收益 |
|---|---|---|
| 1 | 去掉 `tool-workflow`、`tool-goal`+`command-goal`、`present`、`tool-ralph` | 省 ~7KB schema ≈ **2K tokens/请求**（`workflow` 是最大的单个工具 schema） |
| 2 | `tool-skill` 的 `catalogDescriptionMaxLength: 500 → 60` | skill 目录注入从 ~9KB（41 个 skill）降到 ~3KB ≈ **1.5K tokens/请求** |
| 3 | `agent-instructions` 的 `maxBytes: 65536 → 16384` | 无 AGENTS.md 时零开销；有的话封顶最坏情况 |
| 4 | `compaction-basic`：`thresholdRatio 0.8 → 0.6`、`retainRatio 0.16 → 0.15` | **长会话主要杠杆**：稳态上下文从 ~137K 降到 ~100K 量级 |
| 5 | `tool-result-pruner`：`head 4096→3072`、`tail 1024→768`（阈值仍 8192） | 长工具结果在**后续**请求里更短（产生它的那一步仍全价） |

保留：`persona`、`agent-instructions`、全部 fs/shell/jobs 工具、`planning`、`compaction`、`delegation`（subagent / subagent_fork）、`ask_user`、`todo`、`web`（含 fetch）。

**没有纳入**：`~/.dsh/.agent-presets/liangshen`（梁神模式）里的 5 个 `.mjs` 插件。原因不是取舍，而是它们已与本版 DSH API 漂移，直接挂载会激活失败：

- `agent.cordis.yml` 的 persona 行用 `text:` 键；本版 `@deepseek-ai/dsh-persona` 的 Config 是 `{ prefix(必填), suffix, complete, includeRuntimeContext }`，没有 `text` ⇒ 校验失败。
- `skill-search.mjs` 给 `ctx.tools.register` 传的是 JSON Schema，而本版 `parameters` 期望的是 `{ name: { type, required, description } }` 记录形式 ⇒ 工具签名错误。
- 另外 `agent.cordis.yml` 引用了已不存在的 `@deepseek-ai/dsh-workflow-worker-thread`（现名 `dsh-workflow-ptc`）。

如需那套「首轮最小工具集 + 完全去掉 skill 目录 + 不注入 AGENTS.md」，需要先做 API 适配（可以另开一轮做）。

## 4. 安装

本 profile 没有暴露 `plugin_manager` 工具（standard preset 里它是 disabled），所以推荐方式 A。

### 方式 A：写进 profile patch（推荐）

把 `lean-preset/cordis.patch.yml` 去掉顶部注释后，作为 insert 追加到
`~/.dsh/profiles/web/cordis.patch.yml`（该文件是"profile patch 层，在全部 bundle 层之后应用"）。
追加前先备份：

```bash
cp ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/profiles/web/cordis.patch.yml.bak-$(date +%Y%m%d)
```

注意：这是 profile 级改动，**需要重启/重载 DSH 才生效**，且会影响该 profile 下所有新会话的 preset 选择项（老会话保持启动时的 plugin revision）。

### 方式 B：装成 bundle

```text
plugin_manager action=install_bundle target=../lean-preset
```

或在 GUI：设置 → 插件（安装 bundle 入口）。装完 `list_bundles` 应能看到该 bundle。

## 5. 验证

1. `plugin_manager action=list_plugins` → 出现 `preset-lean` 行且状态为已激活。
2. 新建会话，在 preset 选择里选 **省流模式**（老会话不会变）。
3. 新会话跑一步，对比首步 `inputTokens + cacheReadTokens`：应从 12.4K 降到 ~9–10K。

## 6. 可调旋钮（改 `cordis.patch.yml` 后重装/重载）

| 想要 | 改什么 |
|---|---|
| 更省 | `compaction-basic.thresholdRatio: 0.5`（压缩更勤，摘要次数翻倍） |
| 更保守（怕丢信息） | 回到 `0.8`，只靠第 1/2 条省固定开销 |
| 去掉运行时上下文块 | `persona` 加 `includeRuntimeContext: false`（约省 0.5K/请求，会丢掉 DSH_WEB_URL 等环境事实） |
| skill 目录再小 | `catalogDescriptionMaxLength: 40`；或干脆删掉 `tool-skill` 行（则 lean 会话不能用 skill） |
| 恢复目标功能 | 删掉 `tool-goal` 的省略，加回 `- id: tool-goal / name: '@deepseek-ai/dsh-tool-goal'` |
| 恢复 workflow | 加回 `workflow-ptc` + `tool-workflow`（+2.5K/请求） |

### profile 级旋钮（preset 管不到的部分）

`schedule_*`（≈5–7KB schema）和 agent-team 工具是由其它 bundle 层插入到 **host 平面**的，任何 preset 都删不掉。要省这块只能改 profile patch：

```yaml
- id: schedule
  disabled: true
- id: time-context
  disabled: true
```

代价：失去定时提醒能力。agent-team 那层还顺带 disable 了 subagent 行，牵连较多，建议先不动。

## 7. 行为层面的配套（比配置更有效）

1. **一个任务一个会话**，阶段结论落文档（配合 `engineering-doc-append-only`），别让会话跨天累积到 1450 步。
2. **重活派子代理**：翻日志、全仓搜索、跑长命令放 subagent/workflow，主会话只收摘要。
3. **`reasoningEffort` high → medium**（设置里的默认模型配置）：那次会话 output 累计 1.63M tokens，推理是大头。
4. 读文件一律 `offset/limit`，命令输出一律 `head/tail/grep -c` 截断。

## 8. 回滚

删掉 profile patch 中追加的 insert 段（或恢复 `.bak`），重载即可；bundle 方式则在插件页卸载。
preset 本身不影响已被创建的老会话。

## 9. 追加（2026-10-09 17:45）：选不到「省流模式」的根因 = profile 不匹配

**锚定**：2026-10-09 · host `DSH_PROFILE=desktop`（桌面 App，PID 65113，监听 `127.0.0.1:19387`）· `~/.dsh/profiles/{web,desktop}/cordis.patch.yml` · 会话锚点 `session-12ae98c7`（`agentPreset=standard`）

第 4 节把 preset 写进了 `web` profile，但本机 GUI 跑的是 **desktop** profile。证据：

1. App 进程环境：`DSH_PROFILE=desktop`、`DSH_PROFILE_DIR=~/.dsh/profiles/desktop`、`__CFBundleIdentifier=com.deepseek.dsh`。
2. `lsof -nP -iTCP:19387 -sTCP:LISTEN` → `DeepSeek PID 65113`；并没有 `dsh web` 进程在跑。
3. `~/.dsh/profiles/desktop/cordis.patch.yml` 原本**没有任何 `insert:`/preset 声明**；而选择器枚举的是**当前 host 进程**的 preset 注册表（`@deepseek-ai/dsh-agent-preset-registry` 经 `agentPresets/list` 暴露，渲染方 `@deepseek-ai/dsh-client-ui-agent-preset`），所以 `lean` 从未注册 ⇒ 不是 picker 过滤，也不是 YAML 写法问题。
4. 今天 5 个会话（含子会话）`agentPreset` 全为 `standard`，历史投影里只有 `standard`/`minimal`，**从未出现 `lean`** ⇒ 此前「预设已生效」的判断是错的。

**已执行修法**：把 `web` patch 中 `# ── preset-lean` 段（第 13 行起）整段同步追加到 `desktop` patch 末尾（同一段还含本轮新增的 `agents-rules` 行）；备份 `~/.dsh/profiles/desktop/cordis.patch.yml.bak-20261009-174541`。现在两个 profile 都有「省流模式」。

**生效方式修正（覆盖第 62 行「需要重启/重载」）**：`@deepseek-ai/dsh-base` 对 profile 启用了 `@deepseek-ai/dsh-hmr`，它 watch `profile.patchPath` → `reconcileProfilePatches`，**无需重启 App**；但客户端 roster 需**刷新 GUI 页面**（连接重置/设置更新时才重新 `agentPresets/list`）才看得到「省流模式」（设置页的**自定义**分组）。

**验证（选中 lean 后在磁盘上核）**：

```bash
zstd -d -c ~/.dsh/sessions/<编码后的 cwd>/session-<id>/session.v4.jsonl.zstd \
  | grep -o '"agentPreset":"[a-z]*"' | head -1     # 期望 "lean"
```

## 10. 追加（2026-10-15 14:45）：工具面收敛 + 省流目录（c 项）

锚定：工作区 `~/KMP`（**非 git 仓库**，无 commit）；改动文件
`~/.dsh/profiles/{desktop,web}/cordis.patch.yml`（备份同名 `.bak-c-20261015-143535`）。

**动机**：本机模型**不区分缓存命中计费** ⇒ 缓存/前缀稳定性优化零收益，只能压
「步数 × 单步体积」。固定前缀实测（本会话 28 次 `request/header`）：工具 schema **19,215 B**、
`agent-instructions` 3,583 B、`agents-rules` 4,309 B、`skill-catalog` 4,341 B。

**三处改动**（`thresholdRatio`/`retainRatio` 未动）：

| 改动 | 位置 | 实测/预期 |
|---|---|---|
| `- id: tool-agent-team` + `disabled: true` | **profile 顶层补丁行** | **已生效**：本会话工具面 28 → 22 个、schema 19,215 → **15,845 B**（−3.4KB ≈ −0.9k tokens/请求）。移除 `spawn_teammate`/`wait_agent`/`team_task_*`(4)；`subagent`/`send_message`/`list_agents`/`interrupt_agent` 由 delegation 组提供，保留 |
| `catalogDescriptionMaxLength: 60 → 3` | preset 的 `tool-skill` 行 config | 待新会话验证：46 条目 4,341 → 预期 ~1.4KB（≈ −0.8k tokens/请求） |
| 删除 preset `delegation` 组的 `tool-subagent-fork` 行 | preset 行 | 待新会话验证：−1,106 B（≈ −0.3k tokens/请求），且消除「fork 子会话继承整段父上下文」这条最贵的委派路径 |

**实测到的生效规则（重要，覆盖第 9 节的「HMR 无需重启」）**：
- **profile 顶层补丁行**（`- id: X` 无 `name`）→ 对本会话**立即热生效**（上表第 1 行已实测）。
- **preset 内行/config 改动** → 只对**新会话**生效；本会话仍是旧值（catalog 仍 4,341，`subagent_fork` 仍在）。
- 因此验证第 2、3 行必须**开新会话**后跑 `bash scripts/check-injection.sh`。

**回来的路**：删掉 `- id: tool-agent-team` 那两行（+注释）；`catalogDescriptionMaxLength` 改回 60；
fork 行从 `README` 记录的原样贴回（原始块见本节上方 diff 描述，或从 `.bak-c-20261015-143535` 取回）。

**未做（需你点头）**：`thresholdRatio: 0.6 → 0.2~0.3`、`retainRatio: 0.15 → 0.05~0.1`。
按「压缩阈值 T、保留 R，平均单步 ≈ (R+T)/2」估算，本机 ≈240k 阈值 + 60k 保留 → 平均约 147k/步；
改成 0.25/0.10 → 阈值 ~100k、保留 ~40k → 平均 ~70k/步，**单步输入 ≈ −50%**（≈ −490M tokens）。
代价：压缩更频繁、模型更多时候只看到摘要（有信息损失与「重新探索」风险），必须你确认再动。
