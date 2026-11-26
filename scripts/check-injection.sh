#!/bin/bash
# 核对「当前会话」的 preset 与注入面（skills / rules / tools）。
# 用法：在任意 DSH 会话里 `bash scripts/check-injection.sh`
# 依据：会话日志 ~/.dsh/sessions/<编码cwd>/<DSH_SESSION_ID>/session.v4.jsonl.zstd
set -uo pipefail

sid="${DSH_SESSION_ID:-}"
if [ -z "$sid" ]; then echo "✗ 不在 DSH 会话内（DSH_SESSION_ID 未设置）"; exit 2; fi
enc="-$(printf '%s' "$PWD" | tr '/' '-')-"
f="$HOME/.dsh/sessions/$enc/$sid/session.v4.jsonl.zstd"
if [ ! -f "$f" ]; then
  # 编码规则变化时的兜底：按会话 id 在 sessions/ 下找
  f="$(find "$HOME/.dsh/sessions" -maxdepth 3 -name 'session.v4.jsonl.zstd' -path "*${sid}*" 2>/dev/null | head -1)"
fi
[ -n "${f:-}" ] && [ -f "$f" ] || { echo "✗ 找不到会话日志（sid=$sid, cwd=$PWD）"; exit 2; }
echo "会话日志: $f"
tmp="$(mktemp -t dsh-check)"
zstd -d -c "$f" > "$tmp" 2>/dev/null || { echo "✗ 解压失败: $f"; exit 2; }

python3 - "$tmp" <<'PY'
import json, os, re, sys

preset = None
tools = None
tool_entries = []
messages = []
rules_text = None
catalog_text = None

for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    line = line.strip()
    if not line:
        continue
    try:
        record = json.loads(line)
    except Exception:
        continue
    kind = record.get('type')
    if kind == 'session' and preset is None:
        preset = record.get('agentPreset')
    if kind == 'request/header':
        header = (record.get('data') or {}).get('header') or {}
        tool_entries = header.get('tools') or []
        tools = [entry.get('name') for entry in tool_entries]
    if kind == 'user/message':
        data = record.get('data') or {}
        source = data.get('source') or {}
        blocks = [b for b in (data.get('content') or []) if isinstance(b, dict)]
        text = ''.join(b.get('text', '') for b in blocks)
        messages.append((record.get('seq'), source.get('kind'), len(text)))
        if source.get('kind') == 'agents-rules':
            rules_text = text
        if source.get('kind') == 'skill-catalog':
            catalog_text = text

print(f"preset      : {preset}")
lean_marks = ('workflow', 'present', 'create_goal', 'update_goal')
if tools is None:
    print("tools       : (本会话还没有 request/header 记录)")
else:
    present = [n for n in lean_marks if n in tools]
    print(f"tools       : {len(tools)} 个（取最后一次 request/header = 当前实际工具面）")
    print(f"  lean 判据 : {'✗ ' + ', '.join(present) + ' 仍在 → 不是 lean' if present else '✓ workflow/present/goal 都不在 → 与 lean 一致'}")
    print(f"  关键工具  : {', '.join(n for n in ('skill', 'todo_write', 'subagent', 'ask_user_question') if n in tools) or '无'}")
    # 省流收敛（2026-10-15 追加）：团队工具 + fork 委派是否已从工具面移出
    schema_bytes = sum(len(json.dumps(entry, ensure_ascii=False)) for entry in tool_entries)
    print(f"  schema 字节: {schema_bytes}（收敛前基准 2026-10-15：28 工具 / 19215 B）")
    # profile 层 `- id: tool-agent-team; disabled: true` 应移除的 6 个团队工具
    # （send_message / list_agents / interrupt_agent 由 delegation 组的 subagent 控制行提供，属保留项）
    team_tools = ('spawn_teammate', 'wait_agent', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update')
    still = [n for n in team_tools if n in tools]
    print(f"  团队工具  : {'✗ 仍在: ' + ', '.join(still) if still else '✓ 已移除 6 个（-3.4KB ≈ -0.9k tokens/请求，实测 19215→15845 B）'}")
    print(f"  保留协作  : {', '.join(n for n in ('subagent', 'send_message', 'list_agents', 'interrupt_agent') if n in tools)}")
    print(f"  fork 委派 : {'✗ subagent_fork 仍在（-1.1KB 未生效）' if 'subagent_fork' in tools else '✓ subagent_fork 已移除（-1.1KB ≈ -0.3k tokens/请求）'}")

print("注入块      :")
for seq, kind, size in messages:
    print(f"  seq={seq:<4} {kind:<18} {size} chars")

rules = [m for m in messages if m[1] == 'agents-rules']
if not rules:
    print("rules       : ✗ 未注入")
elif len(rules) == 1:
    print("rules       : ✓ 已注入 1 次")
else:
    print(f"rules       : 注入了 {len(rules)} 次（每次压缩后会重注入，属正常；此处按副本数统计，非 surface 可见数）")
if rules_text:
    sections = re.findall(r'^## (\S+\.mdc)$', rules_text, re.M)
    body_heads = re.findall(r'^## (?!\S+\.mdc$)(.+)$', rules_text, re.M)
    print(f"  规则文件 ({len(sections)}) : {', '.join(sections)}")
    if body_heads:
        print(f"  正文内 ## 标题（不算文件）: {', '.join(body_heads)}")
    print(f"  目录行    : {'✓ ' + re.search(r'^Rules directory: .+$', rules_text, re.M).group(0) if re.search(r'^Rules directory: .+$', rules_text, re.M) else '✗ 缺 Rules directory 行'}")

catalogs = [m for m in messages if m[1] == 'skill-catalog']
if not catalogs:
    print("skills      : ✗ 无 skill-catalog 块")
else:
    print(f"skills      : ✓ catalog 已注入（{catalogs[0][2]} chars）（收敛前基准 2026-10-15: 4432 chars）")
    if catalog_text:
        names = sorted(set(re.findall(r'`([a-z0-9][a-z0-9-]{2,})`', catalog_text)))
        print(f"  catalog 提到 {len(names)} 个名字，示例: {', '.join(names[:8])}")

# context-diet（2026-10-15 追加）：旧工具输出折叠是否生效
folds = sum(1 for line in open(sys.argv[1], encoding='utf-8', errors='replace') if 'context-diet' in line and '"tool/result"' in line)
print(f"context-diet: 本会话日志中的折叠标记 {folds} 条（>0 表示插件在改写旧工具结果）")
log = os.path.expanduser('~/.dsh/context-diet.log')
if os.path.exists(log):
    rows = [r for r in open(log, encoding='utf-8', errors='replace').read().splitlines() if r.strip()]
    print(f"  诊断日志    : ✓ {len(rows)} 行；末行: {rows[-1][:140] if rows else '(空)'}")
else:
    print("  诊断日志    : ✗ 不存在（插件未加载，或重启后尚未跑到 pre-step）")
PY
rm -f "$tmp"
