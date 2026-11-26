# dsh-lean-kit

给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 用的「省流」插件包：一个 profile bundle 图层，装上即生效，改的是**每次请求的投影**，不动会话日志、不动人类可见的 transcript。

- `preset-lean` —— 省流 preset：工具砍到 23 个、skills 只留名字、精简 persona
- `context-diet` —— 把过期的工具输出折叠成「头 + 省略标记 + 尾」
- `session-hygiene` —— 输入 token / 真实请求数达标时提醒交接（附 web 端「切换并继续」）
- `image-diet` —— 超标的图在请求投影里换成更小的附件引用（长边/像素/字节，带下限兜底）
- `agents-rules` —— 把 `~/.agents/rules/*.mdc` 注入每个请求

## 为什么

一次 agent step 会把整个 surface 重发一遍。实测（71 份会话日志、991M 累计输入 token）：

- 长会话的 surface 里约 **70% 是累积的 `tool/result` 文本**（最坏一次 147k token 请求里占 405KB）；
- DSH 自带的 `compaction-tool-result-pruner` 只在**到达压缩阈值**（约 240k）才动手，0～240k 之间什么都不裁，旧输出被重发几百次；
- 路由预算对图片是「一个模型一个尺寸」，图多图少共用一条长边上限 —— 要么整体偏大，要么整体糊。

本包补的就是这两段空档：每一步折旧工具输出、每张图按自身尺寸决定压到多大。

## 安装

包声明了 `dsh.bundle`，所以它会被写进 `dsh.profile.bundles` 当作**图层**插在 base 之上、用户
`cordis.patch.yml` 之下。相对路径的 `name:` 由 `anchorInsertedPluginNames` 按**本 patch 所在目录**解析，
插件文件放包内即可，不用往 profile 根目录做软链。

**A. GUI**：设置 → 插件 → 安装插件 → 粘贴本仓库目录（或发布的 tarball）。

**B. 命令行**：

```bash
bash install.sh <profile>          # 例：bash install.sh desktop
bash install.sh <profile> --strip  # 迁移：先摘掉 profile 里同名的 inline 块
```

装完**重启 DSH** —— 新增 bundle 层不会热挂到已跑着的进程。

## 验证

```bash
bash verify.sh <profile>
```

它会检查：包在不在、`dsh.profile.bundles` 登记没、5 个入口文件齐不齐、三个插件的离线 selftest 通不通、
preset 里每个 `name:` 还能不能被当前宿主解析。

运行时再确认一次（在任意会话里）：

```bash
bash scripts/check-injection.sh   # 期望 preset: lean、rules ✓、折叠标记 > 0
```

**升级后最容易踩的坑**：DSH 会校验插件声明的 `@deepseek-ai/*` 版本范围，不兼容时启动日志打印
`dsh: skipping profile bundle "<name>": ... is incompatible with dsh <ver> ...`，组件被**静默跳过**。
所以升级后一定要跑 `verify.sh`，别只看「能启动」。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/lean-preset.md](docs/lean-preset.md) | 省流 preset 与 standard 的逐项差异、收益测算、回滚 |
| [docs/context-diet.md](docs/context-diet.md) | 折叠策略、阈值、替换协议、诊断 |
| [docs/session-hygiene.md](docs/session-hygiene.md) | 触发信号、「切换并继续」的客户端行为 |
| [docs/image-diet.md](docs/image-diet.md) | 图片尺寸/字节自适应规则、缓存、诊断 |
| [docs/agents-rules.md](docs/agents-rules.md) | rules 注入格式与去重 |

## 已知坑

- **CLI 不 reconcile**：`dsh plugin add` 只转 pnpm，不会写 `dsh.profile.bundles`；`install.sh` 自己补这段，GUI 安装则自动补。
- **`link:` 语义**：`node_modules` 里是指向源目录的软链，改 `plugins/*.mjs` 立即生效；想冻结版本就 `npm pack` 后用 `file:dsh-lean-kit-<ver>.tgz` 装。
- **别和 inline 块共存**：profile 的 `cordis.patch.yml` 里若还留着 `preset-lean` / 四个插件，会出现两份定义。迁移用 `--strip`（只摘本包拥有的 5 段，其余配置原样保留，并已备份）。
- **`debugFile` 支持 `~`**：三个插件都会展开 `~`，patch 里写 `~/.dsh/*.log` 即可；写相对路径会落到进程 cwd 下。

## 开发

```bash
node plugins/context-diet/selftest.mjs    # 三个插件各自带离线 selftest，不需要 DSH
node plugins/session-hygiene/selftest.mjs
node plugins/image-diet/selftest.mjs
```

发布前 bump `package.json` 的 `version`，然后 `npm pack`。

## License

Apache-2.0，见 [LICENSE](LICENSE)。
