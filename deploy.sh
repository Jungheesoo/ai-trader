#!/bin/bash
# 서버에서 실행하는 배포 스크립트
# 실행 방법: chmod +x deploy.sh && ./deploy.sh

set -e

echo "=============================="
echo " AI 트레이더 배포 시작"
echo "=============================="

# 1. 프로젝트 디렉토리 이동
cd ~/ai-trader

# 2. 최신 코드 pull
echo "[1/4] git pull..."
git pull origin main

# 3. 의존성 설치
echo "[2/4] npm install..."
npm install --production

# 4. PM2 실행 또는 재시작
echo "[3/4] PM2 시작/재시작..."
if pm2 describe ai-trader > /dev/null 2>&1; then
  pm2 restart ai-trader
  echo "  → 기존 프로세스 재시작 완료"
else
  pm2 start ecosystem.config.js
  echo "  → 신규 프로세스 시작 완료"
fi

# 5. PM2 저장 (재부팅 후 자동 시작)
echo "[4/4] pm2 save..."
pm2 save

echo ""
echo "=============================="
echo " 배포 완료!"
echo " 상태 확인: pm2 status"
echo " 로그 확인: pm2 logs ai-trader"
echo "=============================="
