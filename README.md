# AI 트레이더 시스템

나만을 위한 완전 자동화 AI 트레이더. Node.js + SQLite + Claude API.
Google Cloud 서버에서 24시간 자동 운영. 카카오톡으로 알림.

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

## 2. Google Cloud VM 생성

1. https://console.cloud.google.com 접속 → 계정 생성 (Visa/Mastercard 필요)
2. Compute Engine → **인스턴스 만들기**
3. 리전: **asia-northeast3 (서울)** 선택 필수
4. 머신 유형: **e2-micro** (무료 티어 해당)
5. OS: Ubuntu 22.04 LTS, 부팅 디스크 30GB
6. 방화벽: HTTP/HTTPS 트래픽 허용 체크
7. 서버 생성 후 **외부 IP 주소 메모** → 이것이 `SERVER_IP`

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

# Google Cloud Console에서도 방화벽 규칙 추가 필요:
# VPC 네트워크 → 방화벽 → 규칙 만들기 → TCP 3000 허용 (README Step 3 참고)

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

## 9. Google Cloud 환경변수로 API 키 안전 관리 (권장)

`.env` 파일 대신 PM2 환경변수 파일로 관리:

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

Google Cloud 서버 장애 시 GitHub Actions가 카카오톡으로 알림 발송.

1. GitHub 리포지토리 → Settings → Secrets and variables → Actions
2. 다음 Secrets 추가:
   - `SERVER_IP`: Google Cloud 서버 외부 IP
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

---

## Google Cloud 배포 가이드

누구나 따라할 수 있는 단계별 안내.

---

### Step 1. Google Cloud 계정 생성

1. 브라우저에서 https://cloud.google.com 접속
2. 우측 상단 **"무료로 시작하기"** 클릭
3. Gmail 계정으로 로그인
4. 국가: **대한민국** 선택 → 약관 동의 → 계속
5. 카드 정보 입력 (본인 확인 용도, e2-micro는 실제 과금 없음)
6. 가입 완료 — "$300 크레딧 + 무료 티어" 화면 표시 → 콘솔로 이동

---

### Step 2. VM 인스턴스 생성

1. https://console.cloud.google.com 접속
2. 상단 검색창에 `Compute Engine` 입력 → 클릭
3. 처음 사용 시 **"사용 설정"** 클릭 (1~2분 대기)
4. **"+ 인스턴스 만들기"** 클릭
5. 아래 설정 입력:

   | 항목 | 값 |
   |------|-----|
   | 이름 | ai-trader |
   | 리전 | **asia-northeast3 (서울)** ← 반드시 서울 선택 |
   | 영역 | asia-northeast3-a |
   | 시리즈 | E2 |
   | 머신 유형 | **e2-micro** ← 무료 티어 해당 |
   | 부팅 디스크 OS | Ubuntu 22.04 LTS |
   | 부팅 디스크 유형 | 표준 영구 디스크 |
   | 크기 | 30GB |
   | 방화벽 | HTTP 트래픽 허용 ✅, HTTPS 트래픽 허용 ✅ |

6. **"만들기"** 클릭 (30초~1분 대기)
7. VM 목록에서 **외부 IP 주소 메모** → 이것이 `SERVER_IP`

---

### Step 3. 방화벽 규칙 추가 (포트 3000)

1. 상단 검색창에 `방화벽` 입력 → **"방화벽 정책"** 클릭
2. **"+ 방화벽 규칙 만들기"** 클릭
3. 아래 설정 입력:

   | 항목 | 값 |
   |------|-----|
   | 이름 | allow-3000 |
   | 트래픽 방향 | 수신 |
   | 일치 시 작업 | 허용 |
   | 대상 | 네트워크의 모든 인스턴스 |
   | 소스 IPv4 범위 | 0.0.0.0/0 |
   | 프로토콜 및 포트 | TCP, 포트: 3000 |

4. **"만들기"** 클릭

---

### Step 4. SSH 접속

1. Compute Engine → VM 인스턴스 페이지 이동
2. ai-trader 인스턴스 행 오른쪽 **"SSH"** 버튼 클릭
3. 브라우저에서 검은 터미널 창 열림 → 접속 성공
4. 확인:
   ```bash
   whoami
   ```
   Google 계정 사용자명 출력되면 정상

---

### Step 5. 서버 초기 세팅

```bash
# setup.sh 다운로드 후 실행
curl -o setup.sh https://raw.githubusercontent.com/Jungheesoo/ai-trader/main/setup.sh
chmod +x setup.sh
./setup.sh

# 설치 확인
node --version   # v18.x.x
npm --version    # 9.x.x 이상
pm2 --version    # 5.x.x 이상
```

---

### Step 6. 코드 배포

```bash
cd ~
git clone https://github.com/Jungheesoo/ai-trader.git
cd ai-trader
npm install --production
```

---

### Step 7. .env 파일 서버에 생성

```bash
nano .env
```

로컬 `.env` 내용 전체 붙여넣기 후 아래 항목 수정:

```
SERVER_IP=Step2에서_메모한_외부IP
KAKAO_REDIRECT_URI=http://Step2에서_메모한_외부IP:3000/auth/kakao/callback
```

저장: `Ctrl+X` → `Y` → `Enter`

확인:
```bash
cat .env | grep SERVER_IP
# SERVER_IP=34.64.xxx.xxx 출력되면 정상
```

---

### Step 8. PM2로 서버 실행

```bash
# 시작
pm2 start ecosystem.config.js

# 상태 확인 (online이면 성공)
pm2 status

# 로그 확인
pm2 logs ai-trader

# 재부팅 후 자동 시작 설정
pm2 save
pm2 startup
# → 출력된 명령어를 복사하여 그대로 실행

# 브라우저에서 접속 확인
# http://서버외부IP:3000 → AI 트레이더 웹 UI 표시되면 성공
```

---

### Step 9. 카카오 설정 업데이트

1. https://developers.kakao.com → ai-trader 앱 → **카카오 로그인 → Redirect URI 추가**:
   ```
   http://서버외부IP:3000/auth/kakao/callback
   ```

2. 브라우저에서 Access Token 발급:
   ```
   http://서버외부IP:3000/auth/kakao/login
   ```
   → 카카오 로그인 → 동의 → 화면에 표시된 토큰 복사

3. `.env` 업데이트:
   ```bash
   nano .env
   # KAKAO_ACCESS_TOKEN=발급받은토큰
   # KAKAO_REFRESH_TOKEN=발급받은리프레시토큰
   ```

4. 서버 재시작:
   ```bash
   pm2 restart ai-trader
   ```

---

### Step 10. KIS API 서버 IP 등록

> ⚠️ 이 단계를 건너뛰면 KIS API가 403 오류 발생

1. https://apiportal.koreainvestment.com 접속 → 로그인
2. **앱 관리** → 앱 선택 → **API 신청 현황**
3. **IP 관리** 또는 **허용 IP** 항목에 Step 2에서 메모한 서버 외부 IP 추가
4. 저장 후 약 5분 대기

---

### Step 11. 최종 동작 확인

```bash
pm2 status                    # ai-trader: online 확인
curl http://localhost:3000/health  # {"ok":true} 확인
pm2 logs ai-trader --lines 30 # 에러 없음 확인
```

브라우저:
- `http://서버IP:3000` → 대시보드 ✅
- `http://서버IP:3000/portfolio.html` → 자산 입력 ✅

재부팅 후 자동 실행 확인:
```bash
sudo reboot
# 1분 후 SSH 재접속
pm2 status  # ai-trader: online ✅
```

---

### 자주 발생하는 오류 해결

| 오류 | 원인 | 해결 |
|------|------|------|
| pm2 start 후 errored | .env 누락 또는 npm install 미실행 | `pm2 logs ai-trader` 로 확인 |
| 브라우저 접속 안 됨 | 포트 3000 방화벽 미설정 | Step 3 재확인 |
| KIS API 403 | 서버 IP 미등록 | Step 10 진행 |
| 카카오 토큰 오류 | Redirect URI 불일치 | Step 9 재확인 |

---

### 비용 구조

| 항목 | 비용 |
|------|------|
| Google Cloud e2-micro | 무료 (월 744시간 무료 티어) |
| Claude API | 약 $2~3/월 |
| 카카오/네이버/DART/KIS/RSS | 전부 무료 |
| **합계** | **약 $2~3/월** |

> Claude.ai Pro($20/월)와 API는 완전히 별개. Pro 해지 후에도 시스템 정상 운영됨.

---

### 전체 프로젝트 체크리스트

#### API 키 발급
- [x] Claude API 키 + Anthropic Console 월 $5 한도 설정
- [x] 한투 KIS App Key / App Secret / 계좌번호
- [ ] 카카오 REST API 키 (**채팅창 노출로 재발급 필수**)
- [ ] 카카오 Client Secret (**채팅창 노출로 재발급 필수**)
- [x] 네이버 Client ID / Client Secret
- [x] DART API 키

#### 카카오 설정
- [x] 카카오 로그인 활성화 ON
- [ ] Redirect URI 등록 (로컬 + 서버 IP)
- [ ] 동의항목: 카카오톡 메시지 전송 ON
- [ ] Access Token / Refresh Token 발급 및 저장

#### .env 파일
- [x] CLAUDE_API_KEY, 모델명, 호출 제한값
- [x] KIS_APP_KEY, KIS_APP_SECRET, KIS_ACCOUNT_NO
- [ ] KAKAO_CLIENT_ID (재발급 후 입력)
- [ ] KAKAO_CLIENT_SECRET (재발급 후 입력)
- [ ] KAKAO_REDIRECT_URI, KAKAO_ACCESS_TOKEN, KAKAO_REFRESH_TOKEN
- [x] NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
- [x] DART_API_KEY
- [ ] SERVER_IP (Google Cloud 외부 IP)

#### Google Cloud 배포
- [ ] Google Cloud 계정 생성 (Step 1)
- [ ] e2-micro VM 생성 서울 리전 (Step 2)
- [ ] 방화벽 포트 3000 개방 (Step 3)
- [ ] SSH 접속 확인 (Step 4)
- [ ] setup.sh 실행 (Step 5)
- [ ] git clone + npm install (Step 6)
- [ ] 서버에 .env 파일 생성 (Step 7)
- [ ] pm2 start + pm2 startup + pm2 save (Step 8)
- [ ] 카카오 Redirect URI 서버 IP 추가 + 토큰 재발급 (Step 9)
- [ ] KIS Developers에 서버 IP 등록 (Step 10)
- [ ] 웹 UI + 카카오톡 알림 최종 확인 (Step 11)

#### 보안
- [ ] 카카오 REST API 키 재발급 (노출됨)
- [ ] 카카오 Client Secret 재발급 (노출됨)
- [x] .env .gitignore 등록 확인

#### 향후 구현 예정
- [ ] history.html AI 적중률 입력 버튼 (correct/incorrect)
- [ ] performance/seed_growth 적재 완성
- [ ] 퀀트 스캔 2500종목 전체 확장
- [ ] 2027년 이후 음력 휴일 업데이트
