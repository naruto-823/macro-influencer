#!/bin/zsh
# 一键配置每日自动发布
set -e

echo "🔧 配置每日 09:00 自动发布..."

# 添加 crontab
(crontab -l 2>/dev/null | grep -v "daily-cron.sh"; echo "0 9 * * * /Users/naruo/Workspace/macro-influencer/scripts/daily-cron.sh >> /Users/naruo/Workspace/macro-influencer/logs/daily.log 2>&1") | crontab -

echo "✅ Crontab 已配置："
crontab -l | grep daily

echo ""
echo "📝 配置完成！每天 09:00 自动出发布包。"
echo "   查看日志：tail -f logs/daily.log"
echo "   手动测试：pnpm daily --draft"
echo ""
echo "⚠️  默认只出发布包不自动发布（安全）"
echo "   想全自动发布，编辑 scripts/daily-cron.sh 第16行改成 MODE=\"--live\""
