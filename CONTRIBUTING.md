# 贡献

## 环境

- Node ≥ 20（只用内置模块，无依赖）
- DSH ≥ 0.2（插件 API 以宿主版本为准；升级宿主后先跑 `bash verify.sh`）

## 改之前

三个插件都**不依赖 DSH 运行**，先跑离线 selftest 定位：

```bash
npm run selftest
```

`plugins/*/index.mjs` 里的纯函数（`resolveConfig` / `foldContent` / `planTarget` / `splitRules` 等）都有导出，
新增行为请优先落在纯函数上并补 selftest 用例，别把逻辑塞进事件回调里。

## 验收清单

1. `npm run selftest` 全绿
2. `bash install.sh <profile>` 后重启 DSH，`bash verify.sh <profile>` 通过
3. 新会话里 `bash scripts/check-injection.sh` 显示 `preset: lean` 且折叠标记 > 0
4. 行为有变化时同步 `docs/*.md`（排查记录只追加、不改写历史节）

## 提交

- 一个 PR 一件事，附「为什么」与证据（日志行 / 前后 token 数）
- 不要在提交信息里加 agent 署名（`Co-authored-by:` 等）
