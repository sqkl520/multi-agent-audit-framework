#!/usr/bin/env bash
# 回滚 Hilltop Village 插件源码到修复前状态。
#
# 为什么需要：这个项目**没有 git**。修复过程中如果改坏了，
# 没有任何版本控制能帮你恢复。备份是唯一的安全网。
#
# 用法：
#   ./rollback.sh              # 列出可用备份，不做任何事
#   ./rollback.sh <备份目录名>  # 回滚到指定备份
#
# 备份位置：backups/prerepair-*/
set -euo pipefail

ROOT="<TARGET_REPO>"
SRC="$ROOT/Hilltop Village Plugin/src"
BACKUPS="$ROOT/backups"

if [ $# -eq 0 ]; then
  echo "可用的备份："
  echo
  for d in "$BACKUPS"/prerepair-*; do
    [ -d "$d" ] || continue
    n=$(find "$d/src" -name '*.java' 2>/dev/null | wc -l)
    t=$(stat -c %y "$d" 2>/dev/null | cut -d. -f1)
    echo "  $(basename "$d")   $n 个 java   $t"
  done
  echo
  echo "用法: $0 <备份目录名>   例如: $0 $(ls -1 "$BACKUPS" | grep prerepair | head -1)"
  exit 0
fi

TARGET="$BACKUPS/$1"
if [ ! -d "$TARGET/src" ]; then
  echo "✗ 找不到备份: $TARGET/src" >&2
  exit 2
fi

echo "即将回滚："
echo "  从: $TARGET/src"
echo "  到: $SRC"
echo
echo "当前的差异（回滚会丢弃这些改动）："
diff -rq "$TARGET/src" "$SRC" 2>&1 | head -20 || true
echo

read -r -p "确认回滚？(yes/no) " ans
if [ "$ans" != "yes" ]; then
  echo "已取消"
  exit 0
fi

# 回滚前再存一份「回滚前状态」，防止回滚本身也需要撤销
SAFETY="$BACKUPS/before-rollback-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SAFETY"
cp -r "$SRC" "$SAFETY/"
echo "已保存当前状态到: $SAFETY"

rm -rf "$SRC"
cp -r "$TARGET/src" "$SRC"
echo "✓ 已回滚到 $TARGET"

# 回滚后重新编译验证
echo
echo "重新编译验证..."
cd "$ROOT/Hilltop Village Plugin"
./build.sh -o clean compile 2>&1 | grep -E "BUILD|ERROR" | head -5
