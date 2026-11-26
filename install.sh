#!/bin/bash
# 一键把 dsh-lean-kit 装进某个 profile（默认 desktop），用「本地目录 link」方式：改源码立即生效，无需重新打包。
# 用法：bash install.sh <profile> [--strip]
#   --strip 先把这个 profile 的 cordis.patch.yml 里 kit 拥有的 inline 块摘掉（迁移时用）
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
P="${1:?用法: install.sh <profile> [--strip]}"
PROFILE_DIR="$HOME/.dsh/profiles/$P"
DSH_BIN="${DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
[ -x "$DSH_BIN" ] || DSH_BIN="$(command -v dsh || true)"
[ -n "$DSH_BIN" ] || { echo "找不到 dsh CLI；用 DSH_BIN=<path> 指定"; exit 1; }

if [ "${2:-}" = "--strip" ] && [ -f "$PROFILE_DIR/cordis.patch.yml" ]; then
  echo "== 0/3 摘掉 inline 块（先备份）"
  cp -p "$PROFILE_DIR/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml.bak-$(date +%Y%m%d-%H%M%S)-pre-leankit"
  python3 "$HERE/strip-inline.py" "$PROFILE_DIR/cordis.patch.yml"
fi

echo "== 1/3 link 安装 → $PROFILE_DIR/node_modules/dsh-lean-kit"
"$DSH_BIN" plugin --profile "$P" add "link:$HERE" 2>&1 | grep -v '^Update available\|^Changelog\|^To update' | tail -4

echo "== 2/3 登记 dsh.profile.bundles（CLI 不做 reconcile，这里自己补，幂等）"
node - "$PROFILE_DIR/package.json" <<'JS'
const fs = require("fs");
const file = process.argv[2];
const m = JSON.parse(fs.readFileSync(file, "utf8"));
const NAME = "dsh-lean-kit";
m.dsh ??= {};
m.dsh.profile ??= {};
const b = (m.dsh.profile.bundles ??= ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);
if (!b.includes(NAME)) b.push(NAME);
fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
console.log("bundles:", b.join(", "));
JS

echo "== 3/3 校验"
bash "$HERE/verify.sh" "$P"
echo
echo "生效方式：重启 DSH（新增 bundle 层不会热挂到已跑着的进程）"
