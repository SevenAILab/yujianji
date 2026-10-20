#!/usr/bin/env bash
# 部署脚本：以 GitHub 上的 main 为准，把仓库同步到运行目录并重启服务。
#
#   scripts/deploy.sh web       # 主站：Next.js（/var/www/yujianji）
#   scripts/deploy.sh model3d   # 3D 服务：FastAPI（/var/www/yujianji-3d）
#   scripts/deploy.sh all       # 两个都做
#
# 选项：
#   --dry-run   只打印要做什么，不拉代码、不构建、不重启
#   --no-pull   不拉代码，用当前 checkout 的版本部署（救急用）
#
# 约定：仓库工作区必须干净。任何本地改动都先提交或丢弃，脚本不会替你决定。
set -euo pipefail

REPO=${REPO:-/var/www/yujianji}
WEB_DIR=${WEB_DIR:-/var/www/yujianji}
MODEL3D_DIR=${MODEL3D_DIR:-/var/www/yujianji-3d}
WEB_UNIT=${WEB_UNIT:-yujianji.service}
MODEL3D_UNIT=${MODEL3D_UNIT:-yujianji-3d.service}
HEALTH_WEB=${HEALTH_WEB:-http://127.0.0.1:3001/api/health}
HEALTH_MODEL3D=${HEALTH_MODEL3D:-http://127.0.0.1:8000/health}
BRANCH=${BRANCH:-main}

target=${1:-all}
shift || true
dry_run=0
do_pull=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --no-pull) do_pull=0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
run() {
  if [ "$dry_run" = 1 ]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi
}

cd "$REPO"

# 1. 前置检查：工作区必须干净，分支必须是 main
if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交的改动，先提交或丢弃再部署：" >&2
  git status --short >&2
  exit 1
fi
current=$(git rev-parse --abbrev-ref HEAD)
if [ "$current" != "$BRANCH" ] && [ "$do_pull" = 1 ]; then
  echo "当前分支是 $current，不是 $BRANCH。先切回去再部署。" >&2
  exit 1
fi

# 2. 拉取 GitHub 最新版本
if [ "$do_pull" = 1 ]; then
  say "拉取 origin/$BRANCH"
  run git fetch origin "$BRANCH"
  run git merge --ff-only "origin/$BRANCH"
fi
commit=$(git rev-parse --short HEAD)
say "本次部署 commit：$commit"

wait_health() {
  local url=$1 unit=$2
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      return 0
    fi
    if ! systemctl is-active --quiet "$unit"; then
      echo "服务 $unit 没起来，看日志：journalctl -u $unit -n 50" >&2
      return 1
    fi
    sleep 2
  done
  echo "健康检查超时：$url（日志：journalctl -u $unit -n 50）" >&2
  return 1
}

deploy_web() {
  say "部署主站到 $WEB_DIR"
  cd "$WEB_DIR"
  local stamp="$WEB_DIR/.npm-lock.sha256"
  local want
  want=$(sha256sum package-lock.json | cut -d' ' -f1)
  if [ "$dry_run" = 1 ]; then
    printf '    [dry-run] 比较 package-lock 校验和并按需 npm ci\n'
  elif [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$want" ]; then
    say "依赖有变化，npm ci"
    npm ci
    echo "$want" > "$stamp"
  else
    say "依赖未变，跳过 npm ci"
  fi
  run npm run build
  run systemctl restart "$WEB_UNIT"
  if [ "$dry_run" = 0 ]; then
    wait_health "$HEALTH_WEB" "$WEB_UNIT"
    served=$(curl -fsS "$HEALTH_WEB" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')
    say "线上 commit：${served:-未知}（应为 $commit）"
    if [ "${served:-}" != "$commit" ]; then
      echo "警告：线上 commit 与仓库不一致，检查是否有别的构建覆盖。" >&2
    fi
  fi
  cd "$REPO"
}

deploy_model3d() {
  say "部署 3D 服务到 $MODEL3D_DIR"
  mkdir -p "$MODEL3D_DIR"
  # 只同步代码；运行时的 .venv / .env / data / output 一律不动
  run rsync -a --delete \
    --exclude '.venv/' --exclude '.env' --exclude '.env.*' \
    --exclude '__pycache__/' --exclude '*.py[cod]' \
    --exclude 'data/' --exclude 'output/' --exclude '.pytest_cache/' \
    "$REPO/services/model3d/" "$MODEL3D_DIR/"

  local stamp="$MODEL3D_DIR/.requirements.sha256"
  local want
  want=$(sha256sum "$REPO/services/model3d/requirements.txt" | cut -d' ' -f1)
  if [ "$dry_run" = 1 ]; then
    printf '    [dry-run] 比较 requirements 校验和并按需 pip install\n'
  elif [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$want" ]; then
    say "依赖有变化，pip install"
    "$MODEL3D_DIR/.venv/bin/python" -m pip install -q -r "$MODEL3D_DIR/requirements.txt"
    echo "$want" > "$stamp"
  else
    say "依赖未变，跳过 pip install"
  fi

  run systemctl restart "$MODEL3D_UNIT"
  if [ "$dry_run" = 0 ]; then
    wait_health "$HEALTH_MODEL3D" "$MODEL3D_UNIT"
    say "3D 服务健康：$(curl -fsS "$HEALTH_MODEL3D")"
  fi
}

case "$target" in
  web) deploy_web ;;
  model3d) deploy_model3d ;;
  all) deploy_web; deploy_model3d ;;
  *) echo "用法：scripts/deploy.sh [web|model3d|all] [--dry-run] [--no-pull]" >&2; exit 2 ;;
esac

say "完成：$target @ $commit"
