# AI 트레이더 시스템

나만을 위한 완전 자동화 AI 트레이더. Node.js + SQLite + Claude API.
Oracle Cloud 서버에서 24시간 자동 운영. 카카오톡으로 알림.

---

## 1. 시스템 전체 구조

```
오전 8:00  → 카카오톡 웹 UI 링크 발송 + 전체 종목 퀀트 스캔
오전 8:30  → Claude Sonnet 모닝 리포트 → 카카오톡 발송
장 중 30분마다 → 퀀트 계산 → Haiku 뉴스 필터 → 이상 시 Sonnet 분석 → 카카오톡 알림
오후 4:00  → Sonnet 마감 리포트 → 카카오톡 발송
밤 11시/새벽 2시 → RSS + Haiku만 (Sonnet 없음)
일요일 10:00 → 주간 성과 리포트 (Sonnet 없음)
```

AI 3단계 구조:
1. **퀀트 엔진** (Claude 없음): RSI, MACD, 볼린저밴드, 수급 계산
2. **Haiku 필터**: 뉴스 전체 읽기 → 보유 종목 영향 여부 분류
3. **Sonnet 정밀 분석**: 이상 감지 시에만 호출 (하루 최대 15회)

---

## 2. Oracle Cloud ARM 서버 생성

1. https://cloud.oracle.com 접속 → 계정 생성 (Visa/Mastercard 필요)
2. **서울 리전(ap-seoul-1)** 선택 필수
3. Compute → Instances → Create Instance
4. Shape: **Ampere A1** (Always Free) → 4 OCPU / 24GB RAM
5. OS: Ubuntu 22.04
6. SSH 키 생성 및 저장 (분실 시 접속 불가)
7. 서버 생성 후 Public IP 메모

---

## 3. Ubuntu 22.04 초기 세팅

```bash
# SSH 접속
ssh ubuntu@<서버IP>

# Node.js 20 설치
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# PM2 설치
sudo npm install -g pm2

# 방화벽 설정 (3000 포트 열기)
sudo ufw allow 3000
sudo ufw allow 22
sudo ufw enable

# Oracle Cloud 콘솔에서도 보안 규칙 추가 필요:
# Networking → VCN → Security List → Ingress Rules → TCP 3000 허용

# 프로젝트 클론
git clone https://github.com/<your-repo>/ai-trader.git
cd ai-trader
npm install
```

---

## 4. 한국투자증권 KIS API 키 발급

1. https://apiportal.koreainvestment.com 접속
2. 계좌 없어도 신청 가능 (잔고 0원으로 시세 조회 가능)
3. 앱 신청 → 서비스 신청 → 실전투자 선택
4. App Key, App Secret 발급 → `.env`에 입력
5. 계좌번호: 증권계좌 앞 8자리-뒤 2자리 형식

---

## 5. 카카오 개발자센터 설정 (나에게 보내기)

1. https://developers.kakao.com 접속 → 애플리케이션 추가
2. 플랫폼 → Web → 사이트 도메인: `http://<서버IP>:3000`
3. 제품 설정 → 카카오 로그인 → 활성화
4. Redirect URI: `http://<서버IP>:3000/oauth`
5. 동의항목 → 카카오톡 메시지 전송 → 필수 동의
6. **Access Token 최초 발급** (브라우저에서 1회):

```
https://kauth.kakao.com/oauth/authorize?client_id=<REST_API_KEY>&redirect_uri=<REDIRECT_URI>&response_type=code&scope=talk_message
```

7. 리다이렉트된 URL에서 `code=` 값 복사
8. Access Token 발급:

```bash
curl -X POST https://kauth.kakao.com/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&client_id=<REST_API_KEY>&redirect_uri=<REDIRECT_URI>&code=<CODE>"
```

9. 응답의 `access_token`, `refresh_token` → `.env`에 입력

---

## 6. 네이버 뉴스 API 키 발급

1. https://developers.naver.com 접속
2. Application 등록 → 검색 API 선택
3. Client ID, Client Secret → `.env`에 입력
4. 일일 25,000건 무료

---

## 7. DART API 키 발급

1. https://opendart.fss.or.kr 접속
2. 인증키 신청 → 이메일 인증
3. API 키 발급 → `.env`에 입력

---

## 8. .env 파일 설정

```bash
cp .env.example .env
nano .env
```

`.env` 내용:
```
CLAUDE_API_KEY=sk-ant-...
CLAUDE_SONNET_MODEL=claude-sonnet-4-20250514
CLAUDE_HAIKU_MODEL=claude-haiku-20240307
CLAUDE_SONNET_MIN_INTERVAL_SECONDS=60
CLAUDE_SONNET_MAX_CALLS_PER_HOUR=3
CLAUDE_SONNET_MAX_CALLS_PER_DAY=15

KIS_APP_KEY=...
KIS_APP_SECRET=...
KIS_ACCOUNT_NO=12345678-01
KIS_BASE_URL=https://openapi.koreainvestment.com:9443

KAKAO_CLIENT_ID=...
KAKAO_CLIENT_SECRET=...
KAKAO_REDIRECT_URI=http://<서버IP>:3000/oauth
KAKAO_ACCESS_TOKEN=...
KAKAO_REFRESH_TOKEN=...

NAVER_CLIENT_ID=...
NAVER_CLIENT_SECRET=...

DART_API_KEY=...

MAX_KAKAO_ALERTS_PER_DAY=15
PORT=3000
NODE_ENV=production
SERVER_IP=<서버IP>
```

---

## 9. Oracle Cloud 환경변수로 API 키 안전 관리 (권장)

`.env` 파일 대신 Oracle Cloud Instance Metadata로 관리하거나, PM2 환경변수 파일 사용:

```bash
# /etc/environment에 추가 (서버 재시작 시 자동 로드)
sudo nano /etc/environment
# CLAUDE_API_KEY="sk-ant-..." 형식으로 추가

# 또는 PM2 ecosystem.config.js의 env_production 블록에 직접 입력
# (단, 이 파일은 .gitignore에 추가)
```

---

## 10. 웹 UI 접속

```
http://<서버IP>:3000
```

화면 구성:
- `/` : 메인 대시보드 (총 자산, 보유 종목, AI 분석 요약)
- `/portfolio` : 자산현황 입력 (매일 오전 8시 카카오톡 링크)
- `/chat` : AI 실시간 질문
- `/history` : 분석 이력 및 성과 통계

---

## 11. PM2 상시 실행 설정

```bash
cd ai-trader

# 시작
pm2 start ecosystem.config.js

# 서버 재시작 시 자동 시작 등록
pm2 startup
# 출력된 명령어 복사 후 실행

pm2 save

# 상태 확인
pm2 status
pm2 logs ai-trader
```

---

## 12. GitHub Actions 백업 설정

Oracle 서버 장애 시 GitHub Actions가 카카오톡으로 알림 발송.

1. GitHub 리포지토리 → Settings → Secrets and variables → Actions
2. 다음 Secrets 추가:
   - `SERVER_IP`: Oracle 서버 IP
   - `PORT`: 3000
   - `KAKAO_ACCESS_TOKEN`: 카카오 Access Token

`.github/workflows/morning-backup.yml` 파일이 자동으로 동작함.

---

## 13. Anthropic Console 월 $5 한도 설정 (필수)

**이 설정을 안 하면 코드 버그 시 과금될 수 있습니다.**

1. https://console.anthropic.com 접속
2. Settings → Billing → Usage limits
3. **Monthly spend limit: $5** 설정
4. 저장

예상 월 비용: Haiku ~$0.6 + Sonnet ~$1.5~2.0 = **총 $2~3**
$5 한도로 절대 초과 불가.

---

## 14. Claude.ai Pro 해지 후 API만으로 운영

- Pro($20/월)와 API는 **완전히 별개 서비스**
- Pro 해지 후에도 API 키로 시스템 완전 정상 운영됨
- Pro는 claude.ai 채팅창 사용용, API는 시스템 자동화용
- Pro 해지: claude.ai → Settings → Billing → Cancel Plan
- API만 유지: console.anthropic.com에서 결제 관리

---

## 15. 설날/추석 휴장일 매년 업데이트

`src/services/holiday.js` 파일에서 수동 업데이트:

```js
const LUNAR_HOLIDAYS_2027 = [
  '2027-xx-xx', '2027-xx-xx', // 설날
  '2027-xx-xx', '2027-xx-xx', // 추석
];
```

매년 1월에 한국거래소(KRX) 공지 확인 후 업데이트.

---

## 16. 자주 발생하는 오류 해결

**KIS API 토큰 만료 (401 오류)**
```bash
# 자동 갱신됨. 수동 재시작 시:
pm2 restart ai-trader
```

**카카오 Access Token 만료 (401 오류)**
- 시스템이 6시간마다 자동 갱신
- 갱신 실패 시 카카오톡 알림 발송됨
- 수동 갱신: 5번 항목 참고하여 새 토큰 발급 후 `.env` 업데이트

**카카오 Refresh Token 만료 (만료 7일 전 알림)**
- 60일마다 만료. 시스템이 7일 전 카카오톡 알림 발송
- 만료 전 5번 항목부터 다시 진행하여 새 토큰 발급

**메모리 초과 (PM2 자동 재시작)**
```bash
pm2 logs ai-trader --lines 100
```

**SQLite DB 오류**
```bash
rm data/ai-trader.db
pm2 restart ai-trader
```

---

## 17. 정상 동작 확인 체크리스트

```
□ http://<서버IP>:3000 접속 → 대시보드 표시
□ pm2 status → ai-trader online 상태
□ pm2 logs → 오류 없음
□ /api/health → {"ok":true} 응답
□ 카카오톡 테스트 메시지 수신 확인
□ .env 파일 모든 항목 입력 완료
□ Anthropic Console 월 $5 한도 설정 완료
□ portfolio.html에서 자산 입력 → 저장 성공
□ chat.html에서 AI 질문 → 응답 수신
```
