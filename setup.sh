#!/bin/bash
# Ubuntu 22.04 서버 최초 1회 실행
# 실행 방법: chmod +x setup.sh && ./setup.sh

set -e

echo "=============================="
echo " AI 트레이더 서버 초기 세팅"
echo "=============================="

# 1. 시스템 업데이트
echo "[1/7] 시스템 업데이트..."
sudo apt-get update -y && sudo apt-get upgrade -y

# 2. Node.js 18 LTS 설치
echo "[2/7] Node.js 18 LTS 설치..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. PM2 글로벌 설치
echo "[3/7] PM2 설치..."
sudo npm install -g pm2

# 4. git 설치
echo "[4/7] git 설치..."
sudo apt-get install -y git

# 5. 방화벽 설정
echo "[5/7] 방화벽 설정 (22, 3000 포트)..."
sudo ufw allow 22
sudo ufw allow 3000
sudo ufw --force enable

# 6. 디렉토리 생성
echo "[6/7] 디렉토리 생성..."
mkdir -p ~/ai-trader/logs
mkdir -p ~/ai-trader/data

# 7. 버전 확인
echo "[7/7] 설치 버전 확인..."
echo "Node.js: $(node --version)"
echo "npm:     $(npm --version)"
echo "PM2:     $(pm2 --version)"

echo ""
echo "=============================="
echo " 서버 초기 세팅 완료!"
echo " 다음 단계: git clone 후 .env 파일 생성"
echo "=============================="
