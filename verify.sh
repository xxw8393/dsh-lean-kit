#!/bin/bash
# 校验 dsh-lean-kit 是否装好、挂上。用法：bash verify.sh <profile>（默认 desktop）
set -u
P="${1:-desktop}"
P_DIR="$HOME/.dsh/profiles/$P"
PKG="$P_DIR/node_modules/dsh-lean-kit"

echo "profile      : $P ($P_DIR)"
if [ ! -d "$PKG" ]; then
  echo "bundle 安装  : ✗ 未安装（dsh plugin --profile $P add file:<path>/dsh-lean-kit-*.tgz）"
  exit 1
fi
echo "bundle 安装  : ✓ $PKG"

grep -q '"dsh-lean-kit"' "$P_DIR/package.json" \
  && echo "dsh.profile.bundles : ✓ 已登记" \
  || echo "dsh.profile.bundles : ✗ 未登记（手工加进 dsh.profile.bundles，或重跑 add）"

for f in cordis.patch.yml plugins/context-diet/index.mjs plugins/session-hygiene/index.mjs plugins/image-diet/index.mjs plugins/agents-rules.mjs; do
  [ -f "$PKG/$f" ] && echo "  ✓ $f" || echo "  ✗ $f 缺失"
done

echo "--- 语法自检（离线，不依赖 DSH 运行时）"
for d in context-diet session-hygiene image-diet; do
  if [ -f "$PKG/plugins/$d/selftest.mjs" ]; then
    node "$PKG/plugins/$d/selftest.mjs" >/dev/null 2>&1 \
      && echo "  ✓ $d selftest" || echo "  ✗ $d selftest 失败（DSH 升级可能改了钩子 API）"
  fi
done

echo "--- preset 名称解析（宿主升级后必跑：任一 name 失效 → preset 判 invalid）"
if [ -f "$PKG/check-preset.mjs" ]; then
  node "$PKG/check-preset.mjs" "$PKG/cordis.patch.yml" || echo "  ✗ 上面 FAIL 的条目要按新版 presets/standard.patch.yml 改正"
else
  echo "  ✗ check-preset.mjs 缺失"
fi

echo "--- 运行时确认（在任意会话里执行）"
echo "  bash scripts/check-injection.sh   # 看 preset / rules / 折叠标记"
