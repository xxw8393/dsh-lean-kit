#!/usr/bin/env python3
"""从 profile 的 cordis.patch.yml 里摘掉 lean-kit 拥有的块（preset-lean / 三个插件），保留其余用户配置。
幂等：已经摘过的文件再跑一次不产生变化。
用法：python3 strip-inline.py <cordis.patch.yml> [--check]
"""
import re, sys

OWNED = {"preset-lean", "agents-rules", "session-hygiene", "context-diet", "image-diet"}
TOP = re.compile(r'^(- insert:|- id: |# ── )')


def main() -> int:
    path = sys.argv[1]
    check = "--check" in sys.argv
    lines = open(path, encoding="utf-8").read().splitlines(keepends=True)

    kept, dropped = [], 0
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("- insert:"):
            j = i + 1
            while j < len(lines) and not TOP.match(lines[j]):
                j += 1
            block = "".join(lines[i:j])
            # 摘掉紧邻其上的注释行
            k = len(kept)
            while k > 0 and kept[k - 1].lstrip().startswith("#"):
                k -= 1
            if any(f"id: {name}" in block for name in OWNED):
                del kept[k:]
                dropped += 1
                i = j
                continue
            kept.extend(lines[i:j])
            i = j
            continue
        kept.append(line)
        i += 1

    out = "".join(kept)
    if check:
        print(f"{'仍有' if dropped else '已无'} inline 块：本次可摘 {dropped} 段")
        return 0
    if dropped:
        open(path, "w", encoding="utf-8").write(out)
    print(f"摘除 {dropped} 段；剩余 {len(out.splitlines())} 行")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
