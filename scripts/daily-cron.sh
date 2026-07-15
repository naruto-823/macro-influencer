#!/bin/zsh
# 每日一篇定时入口。用 cron/launchd 每天定时调用本脚本。
#
# 安装（每天 09:00 出发布包、不自动发，安全默认）：
#   crontab -e 然后加一行：
#   0 9 * * * /Users/naruo/Workspace/macro-influencer/scripts/daily-cron.sh >> /Users/naruo/Workspace/macro-influencer/logs/daily.log 2>&1
#
# 想全自动真发，把下面的 MODE 改成 --live（务必先用 --draft/默认确认链路稳）。
set -e
cd "$(dirname "$0")/.."

# 确保 PATH 里有 node/pnpm（cron 的环境很精简）
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p logs
MODE="--live"   # ""=只出包  / "--draft"=填好草稿  / "--live"=真实发布
echo "==== daily-cron $(date '+%Y-%m-%d %H:%M:%S') MODE=${MODE:-package-only} ===="
pnpm daily --persona gunzi-daren $MODE
