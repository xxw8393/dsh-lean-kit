# context-diet — 旧工具输出折叠（省 token）

> 落地日期：2026-10-15 ｜ 工作区：`~/KMP`（**非 git 仓库**，无 commit 锚定）
> 安装位置（唯一真源）：`~/.dsh/plugins/context-diet/{index.mjs,selftest.mjs,package.json}`
> 挂载：`~/.dsh/profiles/{desktop,web}/cordis.patch.yml` 的 `insert: - id: context-diet`
> 软链：`~/.dsh/profiles/{desktop,web}/context-diet -> ../../plugins/context-diet`

## 为什么做（2026-10-15 实测）

- 成本模型（本机模型**不区分缓存命不命中**）：`总输入 ≈ 步数 × 单步上下文`。71 份会话日志、9,314 步实测 **991M 输入 tokens**，平均 **106k/步**。
- 单步上下文的构成（长会话末态实测 147k tokens ≈ 545KB）：**工具结果 ≈ 52%**、工具调用参数 ≈ 19%、注入/用户文本 ≈ 15%、固定前缀 ≈ 9~11k tokens。
- harness 自带 `@deepseek-ai/dsh-compaction-tool-result-pruner` 只在**压缩阈值**（lean: `thresholdRatio 0.6` → 本机 ≈240k）触发时才裁剪，且只裁单条 `>thresholdChars` 的中间段。**0~240k 之间没有任何裁剪**，同一批旧输出会被重发几百步。
  - 证据：本会话日志里 `compaction/prune` 共 41 条，全部集中在 4 次压缩时刻；两次压缩之间（最多 ~100 步）旧结果原样重发。

## 机制

每个 `agent/pre-step`：

1. 取当前 surface 上的 `tool/result` 节点，按 seq 顺序（= 时间顺序），**保留最新 `keepRecent` 条不动**。
2. 其余中文本长度 > `minChars` 的，改写为 `headChars` 头 + 标记 + `tailChars` 尾。
3. 改写用 **harness 自己的替换协议**（与自带 pruner 完全同形，逐字对齐其源码）：
   - 先 `session.append('compaction/prune', {shadowedRange:{start:seq,end:seq}, shadowedSeqs:[seq], shadowedTokenCount})` 记影子计价；
   - 再 `session.append('tool/result', {...event.data, message}, {surfaceOp:{op:'replace',startSeq:seq,endSeq:seq}, sourceEventSeqs:[seq]})`。
4. **幂等**：折后长度（默认 ≈440 字符）必然低于 `minChars`（默认 500），不会被二次折叠；`toolCallId` / `source.callId` / 节点数量 / 顺序全部不变，工具调用-结果配对不破。
5. **软降级**：任何异常（含 session 拒绝替换）只记一条日志，并把该会话加入黑名单，**绝不阻断这一步**（`next()` 照常调用）。

## 配置（profile patch 里）

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `keepRecent` | `15` | 最近 N 条工具结果保持原样（正在用的别动） |
| `minChars` | `500` | 短于该长度不折（与 harness 压缩期省略阈值同量级） |
| `headChars` / `tailChars` | `200` / `120` | 折叠后保留的头/尾字符数 |
| `triggerTokens` | `20000` | 上下文低于该值整趟跳过（拿不到 tokenMeter 时不做此门限） |
| `debugFile` | `~/.dsh/context-diet.log` | 诊断日志；确认生效后可删掉这一行配置 |

约束：`headChars + tailChars < minChars`（否则折叠不会变小），配置校验不过会在挂载时直接报错。

## 验证

```bash
# 1) 离线自测（33 条断言，不需要 DSH）
node ~/.dsh/plugins/context-diet/selftest.mjs

# 2) 重启 DSH 后：诊断日志应出现 fold 行
tail -5 ~/.dsh/context-diet.log

# 3) 重启 DSH 后：新会话里折叠标记增多（老结果被本插件折，而非等到压缩）
bash scripts/check-injection.sh        # 末行 context-diet: 折叠标记 N 条
```

收益预估（诚实区间）：长会话稳态下单步输入 **−30%~50%**（工具结果占 52%，把 `keepRecent` 之外的都折到 ≈440 字符）。
按 991M 累计输入估算 ≈ **−300M~−490M tokens**；准确性取决于「模型是否需要旧输出细节」，若需要则重跑一次工具调用（一次重跑 ≈ 一次新工具结果成本，仍远小于每步重发）。

## 回滚

1. 删掉两个 profile patch 里的 `insert: - id: context-diet` 整块（含上方注释）；
2. 删掉 `~/.dsh/profiles/{desktop,web}/context-diet` 两个软链；
3. `~/.dsh/plugins/context-diet/` 可留着（不挂载即不生效）。

只想临时关掉：把 patch 里的 `enabled: true` 改成 `false`（无需删软链）。

## 已知边界

- 只折 `tool/result`，不碰 assistant 的 `tool/call` 参数（19% 那部分）——删整对调用需要处理 provider 的 tool_call/result 配对约束，风险高，未做。
- 不落盘存档原文：标记里写明「重跑上面那条调用或分段重读」即可复原（原文对应的调用仍在历史里）。
- 与压缩期省略的标记文本**故意保持一致**（`[... context-diet：此处省略 N 字符旧工具输出 ...]`），这样 `~/.agents/AGENTS.md` §6.4 的一条规则同时覆盖两种折叠。

## 落地状态与生效方式（2026-10-15 14:50 实测）

- 插件与软链已装好；两个 profile patch 各含 1 条 `insert: - id: context-diet`，用真实 YAML 解析器校验通过
  （desktop top-level 15 行、web 7 行）。
- **本会话（`session-78bf7a4f`）里尚未生效**：`~/.dsh/context-diet.log` 仍不存在 —— 已实测
  「profile 顶层补丁行立即热生效（团队工具 28→22 个），preset 内行/config 与新增插件行只对新会话生效」。
- ⇒ 验证请在**新会话**里做：`tail -3 ~/.dsh/context-diet.log`（应出现 `folded N tool result(s)`）
  与 `bash scripts/check-injection.sh`（末行折叠标记条数会随步数增长）。若新会话仍无日志，
  再重启 App（说明 HMR 未把新增插件行 reconcil 进去）。
- 别把「压缩期省略」误当成本插件的输出：两者标记文本相同，区别是压缩期的省略只发生在
  `compaction/prune` 时刻（本会话 41 条 prune 事件全集中在 4 次压缩），而本插件**每一步**都在折。
