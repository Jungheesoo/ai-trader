# Claude Code 작업 가이드

> Claude Code 터미널 환경에서 AI Trader 프로젝트 작업 시 반드시 준수할 규칙

---

## 🚨 절대 규칙

### 금지 사항
- ❌ `.env` 파일 수정 금지 (토큰/키 유출 위험)
- ❌ `data/trading.db` 직접 수정 금지 (무결성 파괴)
- ❌ `src/db/schema.sql` 수정 시 마이그레이션 없이 반영 금지
- ❌ `package.json` 의존성 변경 시 사전 논의 필수
- ❌ KST 시간 처리를 `new Date().getHours()` 로 절대 사용 금지 (서버 UTC 기준)
- ❌ `kakao.js` 관련 코드 신규 추가 금지 (텔레그램으로 완전 전환)
- ❌ Sonnet 호출 시 rate limit 우회 시도 금지

### 보호 파일 (읽기 전용)
- `ecosystem.config.js` - PM2 설정 (수정 시 재시작 필수)
- `.github/` - CI/CD 워크플로우
- `deploy.sh`, `setup.sh` - 배포 스크립트

---

## 🛠️ 자주 사용하는 명령어

### 로컬 개발
```bash
npm start              # 일반 실행
npm run dev            # watch 모드 (파일 변경 시 자동 재시작)
```

### PM2 (프로덕션)
```bash
pm2 start ecosystem.config.js    # 시작
pm2 restart ai-trader            # 재시작
pm2 logs ai-trader --lines 50    # 로그 확인
pm2 monit                        # 실시간 모니터링
```

### 데이터베이스
```bash
# DB 직접 조회 (읽기만)
node -e "const db = require('./src/db/database').getDb(); console.log(db.prepare('SELECT * FROM watchlist WHERE date = ?').all('2026-05-03'));"

# 오늘 알림 건수 확인
node -e "const db = require('./src/db/database').getDb(); const today = new Date(Date.now() + 9*3600*1000).toISOString().slice(0,10); console.log('오늘 알림:', db.prepare('SELECT COUNT(*) as cnt FROM alerts WHERE date = ?').get(today));"
```

### 테스트 명령어
```bash
# 모듈 로드 테스트
node -e "require('./src/services/telegram'); console.log('✅ telegram 로드 OK');"

# KST 시간 확인
TZ='Asia/Seoul' date
node -e "const kst = new Date(Date.now() + 9*3600*1000); console.log('KST:', kst.toISOString());"

# 수수료 계산 검증
node -e "const { calcRealPnL } = require('./src/services/portfolio'); console.log(calcRealPnL(157100, 156600, 9));"
```

---

## 📏 코드 수정 규칙

### KST 시간 처리 (필수 패턴)
```javascript
// ✅ 올바른 방법
const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
const day = kst.getUTCDay();        // 0(일)~6(토)
const hour = kst.getUTCHours();     // 0~23 (KST)
const dateStr = kst.toISOString().slice(0, 10);  // 'YYYY-MM-DD'

// ❌ 절대 사용 금지
const hour = new Date().getHours();  // 서버 UTC 기준!
```

### Sonnet 호출 (guard.js 자동 처리)
```javascript
// ✅ 올바른 방법 - guard.js가 rate limit 자동 체크
const { callSonnet } = require('../services/claude-sonnet');
const result = await callSonnet(promptObj, 'call_type');

// ❌ 잘못된 방법 - 직접 axios 호출 금지
// rate limit 우회하면 비용 폭발
```

### DB 쿼리 (동기 방식)
```javascript
// ✅ 올바른 방법 - better-sqlite3는 동기
const db = getDb();
const row = db.prepare('SELECT * FROM holdings WHERE date = ?').get(today);
const rows = db.prepare('SELECT * FROM watchlist').all();
db.prepare('INSERT INTO alerts (...) VALUES (?, ?)').run(date, msg);

// ❌ await 사용 금지 (에러 발생)
// const row = await db.prepare(...).get();  // 동작 안 함
```

### 텔레그램 발송 (중복 차단)
```javascript
// ✅ 올바른 방법
const { sendTelegram } = require('../services/telegram');
await sendTelegram(msg, stockName, alertType, urgent);
// urgent=true: 즉시 발송 (급락, 목표가)
// urgent=false: 1시간 중복 차단

// ❌ 잘못된 방법 - kakao.js 사용 금지
// const { sendKakao } = require('../services/kakao');  // 파일 삭제됨
```

### 장 외 가드 (API 호출 전 필수)
```javascript
// ✅ 올바른 방법
const { isMarketOpen } = require('../utils/market');
if (!isMarketOpen()) return;  // KIS API 호출 전 체크
await getCurrentPrice(code);

// ❌ 장 외 호출 시 KIS 500 에러 발생
```

---

## 🗂️ 파일별 수정 지침

### `src/index.js` - 메인 진입점
- cron 스케줄 추가 시 KST 기준 확인 (`timezone: 'Asia/Seoul'`)
- 새 라우트 추가 시 `/api/` prefix 유지
- Express 미들웨어 순서 변경 금지

### `src/services/claude-sonnet.js` - AI 호출
- `SYSTEM_PROMPT` 수정 시 JSON 응답 형식 검증 필수
- timeout 60초 고정 (변경 금지)
- `callSonnet()` 함수 시그니처 변경 시 모든 호출부 동시 수정

### `src/services/kis-websocket.js` - 실시간 데이터
- `connect()` 호출 전 `isMarketOpen()` 체크 필수
- 최대 10종목 제한 준수 (KIS 제약)
- `disconnect()` 누락 시 메모리 누수 → 15:35 cron 확인

### `src/services/portfolio.js` - 보유종목 관리
- `getTodayHoldings()` - 08:10 이후 전일 데이터 자동 사용 (수정 금지)
- `calcRealPnL()` - 수수료 계산 로직 변경 시 검증 필수 (`STOCK_SELL_TAX_RATE`)
- `saveDailySeedGrowth()` - `trades` 테이블 기반 실현손익 집계 (변경 금지)

### `src/scheduler/scan.js` - 종목 스캔
- fallback 하드코딩 목록 절대 추가 금지 (v7에서 완전 제거)
- score 계산 로직 수정 시 `watchlist.score` 컬럼 업데이트
- 최소 5점 이상 통과 기준 유지

### `src/scheduler/recommendation.js` - 종목 추천
- 08:50 WS 사전 연결 후 09:05 실행 (순서 변경 금지)
- `morning_strategy` 테이블에 추천 이력 저장
- Sonnet 1회 호출 제한 (루프 금지)

---

## 🐛 자주 발생하는 실수와 해결

### 1. KIS API 500 에러
**원인**: 장 외 시간에 현재가 조회
**해결**:
```javascript
const { isMarketOpen } = require('../utils/market');
if (!isMarketOpen()) {
  // DB에서 저장된 값 사용 또는 스킵
  return;
}
```

### 2. WebSocket 연결 실패 반복
**원인**: 장 외 연결 시도 또는 잘못된 종목코드
**해결**:
- `src/index.js` 08:50/09:00 스케줄 확인
- 보유종목 없을 때 `connect([])` 호출 금지

### 3. Sonnet 호출 한도 초과
**원인**: `guard.js` 우회 또는 루프 내 호출
**해결**:
```javascript
// ❌ 잘못된 예
for (const stock of watchlist) {
  await callSonnet(...);  // 10번 호출 = 즉시 한도 초과
}

// ✅ 올바른 예
const prompt = { watchlist };  // 한 번에 전달
const result = await callSonnet(prompt, 'scan');
```

### 4. 텔레그램 메시지 4096자 초과
**원인**: 긴 메시지 발송 시 자동 절단 미처리
**해결**:
- `telegram.js`에서 3900자에서 자동 절단 + 더보기 링크 (이미 구현됨)
- 수동 slice 시 `message.slice(0, 3900)` 사용

### 5. DB 날짜 형식 불일치
**원인**: ISO 슬라이스 없이 저장
**해결**:
```javascript
// ✅ 올바른 방법
const today = new Date(Date.now() + 9*3600*1000).toISOString().slice(0, 10);
db.prepare('INSERT ... VALUES (?)').run(today);  // 'YYYY-MM-DD'

// ❌ 잘못된 방법
db.prepare('... VALUES (?)').run(new Date());  // ISO 전체 문자열
```

---

## 🔧 외부 API 연동 주의사항

### KIS API
- **Rate Limit**: 초당 20건 (과부하 방지 0.4초 딜레이 필수)
- **WebSocket**: 종목당 1연결, 최대 10종목
- **500 에러**: 장 외 호출 시 정상 (에러 카운터 제거됨)

### Telegram
- **분당 30건** 제한 (초과 시 429 에러)
- **중복 차단**: `alerts` 테이블 기반 1시간 dedup (urgent=false 시)
- **환경변수**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` 필수

### Claude API
- **Sonnet**: 시간당 5회, 일일 15회 (guard.js 자동 제어)
- **Haiku**: 제한 없음 (비용 저렴)
- **Timeout**: Sonnet 60초, Haiku 15초 고정

---

## 📦 토큰 절약 가이드

### 파일 읽기 최소화
- `src/scheduler/*` 수정 시 해당 파일만 읽기
- `src/services/kis.js` 수정 시 `kis-websocket.js`도 함께 확인 (연관성)
- `src/index.js` cron 스케줄 확인 시 `scheduler/` 전체 읽기 불필요

### 작업 단위 예시
| 작업 | 필요한 파일 |
|------|-------------|
| 새 스케줄 추가 | `src/index.js`, 신규 `scheduler/*.js` |
| 알림 포맷 변경 | `src/services/telegram.js`, 호출부 (closing.js 등) |
| DB 스키마 변경 | `src/db/schema.sql`, 관련 쿼리 파일 |
| Sonnet 프롬프트 수정 | `src/services/claude-sonnet.js` 만 |

---

## 🎯 프로젝트 특유 컨벤션

### 변수명
- KST 시간: `kst`, `kstHour`, `kstDay`
- 종목명: `stock_name` (snake_case, DB 컬럼과 일치)
- 종목코드: `stock_code` (6자리 숫자, 예: `'005930'`)

### 함수명
- 스케줄러: `run{TaskName}` (예: `runScan`, `runMorningReport`)
- API 호출: `fetch{Resource}` (예: `fetchAllRSS`, `fetchSoxData`)
- 계산: `calculate{Metric}` (예: `calculateRSI`, `calcRealPnL`)

### 에러 처리
- 외부 API 호출은 반드시 try-catch
- 에러 시 `console.error` + `sendErrorAlert()` (알림 발송)
- 스케줄러 내 에러는 전체 중단하지 않고 로그만 (다음 실행 보장)

### 주석
- 코드가 자명한 경우 주석 불필요
- 비즈니스 로직 "왜"만 간결하게
- TODO 주석 금지 (즉시 수정 또는 이슈 생성)

---

**마지막 업데이트**: 2026-05-03
