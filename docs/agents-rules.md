# agents-rules 插件 —— 把 `~/.agents/rules/*.mdc` 注入每个请求

创建日期：2026-10-09 · host：`DSH_PROFILE=desktop`（桌面 App，127.0.0.1:19387）· 实现文件：`~/.dsh/plugins/agents-rules.mjs`

## 1. 为什么需要它

DSH 的全局指令只有一个硬编码入口：`$DSH_HOME/AGENTS.md`（即 `~/.dsh/AGENTS.md`）。`@deepseek-ai/dsh-agent-instructions` 的候选文件名只在**项目目录链**里生效，且校验拒绝含 `/` 的名字；官方 README 明说 `@path` import、`.claude/rules/` 之类目录一律不解释。所以 Claude 风格的 `~/.agents/rules/`（8 个 `.mdc`）对模型完全不可见 —— 这个插件就是补这个缺口。

技能侧不受影响：`@deepseek-ai/dsh-skill-filesystem` 的 `agentsHome = config.agentsHome ?? $DSH_AGENTS_HOME ?? ~/.agents`，照旧扫 `~/.agents/skills`。

## 2. 安装位置（单真源 + 每 profile 一个软链）

| 角色 | 路径 |
|---|---|
| 实现（唯一真源） | `~/.dsh/plugins/agents-rules.mjs` |
| 软链 | `~/.dsh/profiles/{web,desktop}/agents-rules.mjs` → `../../plugins/agents-rules.mjs` |
| 挂载行 | 各 profile `cordis.patch.yml` 末尾的 `- insert: [- id: agents-rules, name: ./agents-rules.mjs, ...]` |

patch 里相对 `name` 锚定在 **patch 文件所在目录**（cordis 组合参考 §Loader patch dialect），故软链必须落在 profile 目录里。宿主级一行覆盖该 profile 的**所有 preset**：已实测 preset 会话（standard）与子 agent 都能收到。

## 3. 行为

1. 读 `dir` 下所有 `*.mdc`/`*.md`，**按文件名排序**；剥掉 YAML frontmatter（`description`/`globs` 不注入），`alwaysApply: false` 的文件跳过（缺省视为 true）。
2. 渲染成一个 `<system-reminder>` 块（内含 `Rules directory: …` 与 `## <文件名>` 小节），必要时按 `maxBytes` 截断；块内 `</system-reminder>` 会转义。
3. 作为 **user 消息**注入：`source = { kind: 'agents-rules', form: 'rules', digest }`，消息 id = `agents-rules-<sha1>`，deep-freeze。
4. 首步（`step === 1 && decision.messages 为空`）走 `agent.inbox.prepend('next-step', …)`，其余步直接进 `decision.messages`（插在最后一条 claimed 消息之后）；失败一律降级为不注入 + 一次 `ctx.logger.warn`，**不会破坏会话**。
5. 去重三重：本步已 claimed 的同内容消息 / 会话 durable surface 里同 kind 同内容 / inbox 里已有同内容。
6. 文本不变 ⇒ digest 不变 ⇒ 注入载荷逐字稳定，落在请求前缀里可被 KV 缓存命中；只有规则真的改了才产生新载荷。

## 4. 配置旋钮（改 profile patch 里的 `config`）

| 字段 | 默认 | 含义 |
|---|---|---|
| `dir` | `~/.agents/rules` | 规则目录，支持 `~` |
| `maxBytes` | `12288` | 渲染块字节上限（当前 8 条渲染约 5.9KB） |
| `include` | `['.mdc', '.md']` | 后缀白名单 |
| `header` | 内置一句 | 块首说明行 |

## 5. 验证证据（2026-10-09，本机）

| 场景 | 证据 |
|---|---|
| 首步到达 + 顺序 | 新子会话 `45d0fd00…`：seq=8 user → seq=9 agent-instructions → **seq=10 agents-rules** → 11 runtime-context → 12 skill-catalog → 13 time-context → 17 assistant |
| 只注入一次 | 父会话 `session-12ae98c7` 落盘 `seq=423 kind=agents-rules`，条数 = 1；子会话条数 = 1 |
| 子 agent 也生效 | 探针子会话日志 `"kind":"agents-rules","form":"rules"` 各 1 条（`agentPreset: standard`） |
| 部署一致性 | `md5 -q` 源文件与 `~/.dsh/plugins/` 一致；从 desktop 软链路径 `import()` 成功（`name=agents-rules`） |
| 单测 | 桩 harness 下：注入 5951B、深层冻结、三种去重、step-1 幂等、插入位置正确 |

## 6. 已知限制

- **会话中途改规则**：下一次请求会带新块（digest 变），旧块留在历史里直到压缩，插件不做「移除旧块」协议。
- `globs:` 字段被忽略（只认 `alwaysApply`）；不做按文件类型的条件注入。
- 注入面是**全局**的：不区分 cwd/仓库。要按项目裁剪，只能改规则文件本身。

## 7. 回滚

```bash
# 1) 删掉两个 profile patch 末尾的 agents-rules insert 段
#    （或恢复 ~/.dsh/profiles/{web,desktop}/cordis.patch.yml.bak-20261009-*）
# 2) 删软链与实现
rm ~/.dsh/profiles/web/agents-rules.mjs ~/.dsh/profiles/desktop/agents-rules.mjs
rm ~/.dsh/plugins/agents-rules.mjs
```
host HMR 会自行 reconcile；老会话保持启动时的 revision。


## 9. glob 作用域规则改为按需（2026-10-15）

**问题**：插件只认 `alwaysApply`、忽略 `globs`（本文件第 52 行记录的既有取舍），于是 4 条
**作者声明为 glob 作用域**的规则被无条件全量注入，常驻成本 2,313 B ≈ 0.55k tokens/步。

**改动**：给这 4 个规则文件补 `alwaysApply: false`（与既有 `globs:` 并列）——
- Cursor 语义不变（`globs` + `alwaysApply:false` = 按匹配文件挂载）；
- DSH 侧由插件已有的 `alwaysApply()` 判定跳过，**无需改代码**；
- 文件内容变更即时生效：插件按 digest 重算，无需重启（本对话内已验证过一次）。
- 移出：`log-analysis` 534B、`ohos-architecture` 777B、`toolchain-convention` 465B、`verification-workflow` 537B。

**发现路径**：`AGENTS.md` §4 增补一行指向这 4 个按需规则（模型按需 `read`）。

**回滚**：删掉对应文件里的 `alwaysApply: false` 行，即恢复常驻注入。
- 2026-10-15 追加：`native-resource-api-ownership.mdc`（1,557 B）也翻为按需（AGENTS §2.6 已含该红线摘要 + 指向本文件）。

### 9.1 英文改中文（2026-10-15 追加）

**实测账**：固定前缀里「我们自己能改的英文」只有两处可动 ——
1. 5 条纯英文 skill 描述（`cmp-core-file-editing` / `docx-to-markdown` / `generate-commit-message` /
   `ios-instrumented-tests-compose` / `update-kotlin-version`）→ 改短中文触发短语。
   其余 14 条被判为「英文」的其实是「中文 + 标识符/路径」（`dispatchDraw`、`hdc file recv` 等），改中文更贵更不可读，**不动**。
2. 注入块 `header`（插件默认英文 105 字符）→ 走 `config.header` 覆盖为中文短句，**不改插件代码**。

**改不动的**：工具 schema 14,781 字符纯英文 —— asar 内无 `toolOverrides`/`descriptionOverride` 任何覆盖开关（命中 0）。

**结论（重要）**：语言本身**不省 token**。实测汉字 0.98 tokens/字、ASCII 0.51 tokens/字符，
同字符数下中文更贵；中文的优势是**信息密度**（1 汉字 ≈ 2–3 英文字符的信息量），
所以省 token 的正确做法是**压长度**（并且把 >60 字、已被 `catalogDescriptionMaxLength` 截断的描述写短 = 零信息损失）。
语言统一只是可读性收益（约 ±0.1k tokens/轮，属噪声）。

**回滚**：删掉 profile patch 里的 `header:` 行；描述文本从 `/tmp/dsh-patch-backup-<ts>/` 取回。
