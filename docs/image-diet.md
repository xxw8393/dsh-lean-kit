# image-diet — 按图自适应的图片压缩（省 token / 省字节）

> 落地日期：2026-10-29 ｜ 工作区：`~/KMP`（**非 git 仓库**，无 commit 锚定）
> 实现位置（唯一真源）：`plugins/image-diet/{index.mjs,selftest.mjs,package.json}`
> 挂载：`cordis.patch.yml` 的 `insert: - id: image-diet`
> 生效路径：`~/.dsh/profiles/web/node_modules/dsh-lean-kit`（link 到本目录，改源码即改运行码）

## 一句话

**每张图按自己的长边/像素/字节超标程度决定请求尺寸**，通过替换会话表面上的图片附件引用生效；
只改**模型请求投影**，不改会话日志、不改人眼看到的 transcript，也不删原图。

## 为什么做（宿主现状缺口，2026-10-29 核实）

- 宿主的图片预算是**路由级**的：`imageRequestTarget(provider, model, image)` 一个模型路由给一套
  「尺寸 + 字节」目标（`dsh-llm/lib/types/index.js:178`，DeepSeek 适配器实现见
  `dsh-llm-deepseek/lib/index.js:2124`）⇒ **同一会话里所有图共用一个长边上限**，图少图多一个样。
- 超总量的处理是**整张丢弃**：`dsh-compaction-image-offload` 收到 `IMAGE_OFFLOAD_REQUIRED` 后把最旧的
  图片占用替换成文字占位（`dsh-compaction-image-offload/lib/index.js:142`）⇒ 图一多，老图直接没了。
- 缺的那一环：**没有按图自适应**。一张 4K 截图和一张 400px 的小图被同一把尺子量；总量吃紧时会话要么
  整体偏大（图少时不压），要么丢图（图多时）。

## 机制

每个 `agent/pre-step`（host 插件，`apply(ctx, config)`）：

1. 扫当前 surface 上的 `user/message` 与 `tool/result`，收集 `type === 'image'` 的块及其附件引用
   （引用形状：`{attachmentId, mediaType, width, height, bytes, name?}`，
   `dsh-attachment-local/lib/index.js:337-342`）。
2. 对每张图算目标（`planTarget`）：长边 > `maxLongEdge`、像素 > `targetPixels`、字节 > `targetBytes`
   三者任一超标才动手；缩放比例取三者的最小值，并用 `minLongEdge` 兜底（图已经比下限小就**只重压缩不裁尺寸**，
   且**绝不放大**）。
3. 编码复用宿主附件服务：`attachments.readImageRequest(ref, {width, height, maxBytes}, signal)`
   —— sharp 实现、带磁盘变体缓存、目标字节达不到时回落到最小档；**不启子进程、不写临时文件**。
4. 落库再写回：`attachments.saveImages([{data, mediaType, name}])` 得到新引用（内容寻址，与直接上传同一套准入；
   旧图仍留在 attachments 里，不删）。
5. 用 harness 自己的替换协议写表面（与 `context-diet` / 自带 pruner 同形）：
   `session.append(type, data, {surfaceOp:{op:'replace',startSeq,endSeq}, sourceEventSeqs:[seq]})`；
   `tool/result` 只换 `content` 里的 `attachment`，`toolCallId` 等字段原样保留（`assertToolResultRewrite` 只允许这种差量）。
6. **幂等**：替换后的引用已经变小，下一步 `planTarget` 返回 null；编码结果与「旧引用 → 新引用」映射都过缓存
   （`~/.dsh/cache/image-diet.json`），重启后同一张图不再重复编码。
7. **软降级**：编码/落库/替换任何一步抛错只记日志，该会话进黑名单，`next()` 照常调用，**绝不阻断这一步**。

## 配置（profile patch 里，默认已写在 dsh-lean-kit 的 patch）

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dryRun` | `false` | 只记日志不替换（先看会压成什么样） |
| `maxLongEdge` | `1600` | 长边上限（像素） |
| `targetPixels` | `1200000` | 总像素上限 |
| `minLongEdge` | `1024` | 长边下限：小字要还能看清 |
| `targetBytes` | `900000` | 单图编码字节上限 |
| `keepRecent` | `0` | 最新 N 组带图消息保持原样；0 = 全都参与 |
| `cacheFile` | `~/.dsh/cache/image-diet.json` | 旧引用 → 新引用的落盘缓存 |
| `debugFile` | `~/.dsh/image-diet.log` | 诊断日志；确认生效后可删这一行 |

约束：`minLongEdge ≤ maxLongEdge`，其余须正整数；不合规会在挂载时报错（不静默跑偏）。

## 验证

```bash
# 1) 离线自测（不需要 DSH / sharp / 网络）
node ./plugins/image-diet/selftest.mjs

# 2) bundle 全量校验（含三个插件的 selftest）
bash ./verify.sh web

# 3) 重启 DSH 后，新会话里贴一张大图，看压缩行
tail -5 ~/.dsh/image-diet.log     # 例：photo.png 4000x3000@3120000 -> 1264x948@412000
```

> 判定「真的生效」的口径：日志里出现 `->` 行，且同一步的请求图片尺寸随之变小；
> 只有 `dryRun:` 行说明是 dryRun；一行都没有 ⇒ 图没超标（先用 `dryRun: true` + 更长边的大图试）。

## 回滚

1. 删掉 `cordis.patch.yml` 里 `insert: - id: image-diet` 整块（含上方注释）；
2. 重启 DSH（新增插件行对**新会话**生效，热更不一定 reconcile 到已经开着的会话）；
3. `plugins/image-diet/` 可留着（不挂载即不生效）。

只想临时关掉：`enabled: false`（无需删目录）。

## 与 handoff 原方案的差异（2026-10-29，已核实后改）

- 原计划：用 `sips` 子进程 + `/tmp` 临时文件重编码。
- 实际实现：用宿主 `attachments.readImageRequest()`。理由：① 零子进程、零临时文件（无路径注入与清理问题）；
  ② 复用宿主 sharp 与变体缓存，行为与「模型实际拿到的那张图」同一条代码路径；
  ③ Windows 无 `sips`，子进程方案跨平台要两套；
  ④ diff 更小：不需要猜测输出格式、不需要自己做降级重试。
  代价：依赖宿主的内部附件方法名（已是 `AttachmentStore` 公开方法，见 `dsh-attachment/lib/index.js:242`,
  `:320`）；宿主改名时 selftest 与「安静跳过」逻辑兜底。

## 已知边界

- 不删原图：只改引用，旧附件仍在 `~/.dsh/attachments`（要清盘另做，不属本插件职责）。
- 不做内容理解（不做 OCR/显著性判断）：尺寸决策只看长边/像素/字节与下限，规则可解释、可回归。
- 只处理 surface 上的图（`user/message`、`tool/result`）；`image/offload` 之类的占位事件不碰。
- 缩放后同一张图在**所有**后续请求里都变小（这是刻意的：KV 前缀稳定、账单稳定）。
