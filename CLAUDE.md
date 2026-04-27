# AI 트레이더 — Claude Code 작업 가이드

## 핵심 원칙
- 파일 수정 전 반드시 Read로 현재 상태 확인
- 변경 최소화: 요청된 것만 수정, 리팩터링/클린업 금지
- 주석 추가 금지 (코드가 자명한 경우)
- 에러 핸들링 추가 금지 (기존 패턴 유지)

---

## 프로젝트 구조 (핵심만)

```
src/
  index.js          # 진입점, cron 정의, Express 라우트
  db/
    database.js     # initDb(), getDb() — better-sqlite3 WAL
    schema.sql      # 테이블 정의 (아래 DB 섹션 참고)
  routes/
    portfolio.js    # /api/portfolio/* (holdings, trades)
    chat.js         # /api/chat
    history.js      # /api/history
  services/
    kis.js          # KIS REST API (현재가, 수급)
    kis-websocket.js # KIS WS 실시간 (H0STCNT0/H0STASP0)
    kakao.js        # 텔레그램 발송, dedup, 일 15건 제한 (파일명 유지, 내부는 텔레그램)
    claude-haiku.js # 뉴스 필터 (max_tokens 150)
    claude-sonnet.js # 정밀 분석 (timeout 60s)
    analyzer.js     # 모니터링 파이프라인 조율
    portfolio.js    # 보유 종목 조회/계산, saveDailySeedGrowth()
    rss.js          # RSS 다중 URL fallback
    alert.js        # sendErrorAlert()
    holiday.js      # isWeekday(), isHoliday() KST 기준
    dateutil.js     # nowKST()
    guard.js        # Sonnet 호출 rate limit (60s/3per-hr/15per-day)
  utils/
    market.js       # isMarketOpen(), getMarketStatus() KST 기반
  scheduler/
    morning.js      # 08:00 링크 발송
    scan.js         # 08:00 퀀트 스캔 60종목
    report.js       # 08:30 모닝 리포트 (Sonnet 1회)
    monitor.js      # 장중 30분마다 (Sonnet 조건부)
    closing.js      # 16:00 마감 리포트 + saveDailySeedGrowth()
    friday.js       # 금 13:30 주말 점검
    monday.js       # 월 09:30 주말 효과 판단
    weekly.js       # 일 10:00 주간 성과 (Sonnet 없음)
    monthly.js      # 마지막 금요일 16:30 월간 리포트 (Sonnet 1회)
    night.js        # 23:00/02:00 미국 시장 (Haiku만)
  public/
    index.html      # 대시보드
    portfolio.html  # 자산입력 + 매매완료 입력
    chat.html       # AI 질문
    history.html    # 분석 이력
```

---

## DB 스키마 요약

| 테이블 | 주요 컬럼 | 용도 |
|--------|-----------|------|
| holdings | date, stock_name, stock_code, quantity, avg_price, current_price | 보유 종목 (날짜별) |
| trades | date, stock_name, stock_code, trade_type, quantity, price, avg_price, profit_loss | 실현 손익 기록 |
| analysis | date, stock_name, action, reason, target_price, stop_loss, actual_result | Sonnet 분석 이력 |
| seed_growth | date, total_assets, stock_value, cash, realized_profit | 일별 자산 성장 |
| watchlist | date, stock_name, stock_code, rsi, macd, volume_ratio, reason | 스캔 결과 |
| news_cache | date, source, title, url, haiku_result | 뉴스 중복 방지 |
| performance | week, total_recommendations, correct_recommendations, accuracy_rate | 주간 성과 |
| alerts | date, stock_name, alert_type, sent_at | 발송 이력 (dedup용) |
| api_calls | date, model, call_count_today, call_count_hour | Sonnet 사용량 |

`trades.trade_type`: `sell_profit` / `sell_loss` / `switch` / `buy`

---

## 핵심 패턴

### KST 시간 처리
```js
// 항상 이 방식 사용
const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
const day = kst.getUTCDay();
const hour = kst.getUTCHours();
```
- `new Date().getHours()` 절대 사용 금지 (서버 UTC 기준)

### 장 외 가드
```js
const { isMarketOpen } = require('../utils/market');
if (!isMarketOpen()) return; // KIS API 호출 전 반드시 체크
```

### Sonnet 호출
```js
const { callSonnet } = require('../services/claude-sonnet');
// guard.js가 rate limit 자동 처리 — 별도 체크 불필요
const result = await callSonnet(promptObj, 'call_type');
```

### DB 쿼리
```js
const db = getDb(); // better-sqlite3, 동기
const row = db.prepare('SELECT ...').get(param);
const rows = db.prepare('SELECT ...').all(param);
db.prepare('INSERT/UPDATE ...').run(params);
```

### 텔레그램 발송
```js
const { sendKakao } = require('../services/kakao'); // 파일명 유지 (하위호환)
await sendKakao(msg); // 텔레그램 Bot API, 일 15건 dedup 자동 처리
// .env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID 필요
```

### RSS fallback
```js
// rss.js: {name, urls[]} 구조, fetchRSSWithFallback() 사용
// URL 추가 시 urls 배열에 append
```

---

## 수정 시 주의사항

### services/portfolio.js
- `kisBackupMode` 전역 변수 없음 (의도적 제거). 종목별 독립 fallback
- `?? null` 사용 (`|| null` 금지) — 0값 보존 필요 (외국인 수급 0 = 중립)
- off-market 시 DB 저장값 반환, KIS/naver 호출 금지

### services/kis.js
- `getInvestorData()`: KIS 당일 데이터 공백 → 전일(d[1]) 자동 fallback
- `foreignNet5Days`, `foreignConsecutiveDays`, `institutionConsecutiveDays` 필드 존재

### scheduler/closing.js
- `saveDailySeedGrowth()` 호출 — trades 테이블 기반 실현 손익 집계

### scheduler/monthly.js
- `isLastFridayOfMonth()` 선행 체크 — 마지막 금요일만 실행

### services/analyzer.js
- Sonnet pre-validation: holdings/current_price/RSI 없으면 스킵
- 뉴스 max 5개, 50자 요약
- watchlist max 5개

---

## Sonnet JSON 응답 형식

```json
{
  "action": "sell_all|buy_more|hold|switch_stock|buy_new|hold_cash|unknown",
  "reason": "string",
  "confidence": "high|medium|low",
  "current_upside": number,
  "target_price": number,
  "stop_loss": number,
  "entry_price": number,
  "market_outlook": "string",
  "key_risk": "string",
  "switch_stock": {
    "name": "string",
    "code": "string",
    "reason": "string",
    "expected_upside": number,
    "target_price": number,
    "stop_loss": number,
    "entry_price": number
  }
}
```

---

## cron 타임라인 (index.js)

| 시간(KST) | 스케줄 | 함수 |
|-----------|--------|------|
| 08:00 평일 | `0 8 * * 1-5` | runMorningLink + runScan |
| 08:10 평일 | `10 8 * * 1-5` | 자산입력 마감 체크 |
| 08:30 평일 | `30 8 * * 1-5` | runMorningReport |
| 09:00 평일 | `0 9 * * 1-5` | kisWs.connect() |
| 09:00~15:30 평일 | `0,30 9-15 * * 1-5` | runMonitor |
| 09:30 월요일 | `30 9 * * 1` | runMondayCheck |
| 13:30 금요일 | `30 13 * * 5` | runFridayCheck |
| 15:35 평일 | `35 15 * * 1-5` | kisWs.disconnect() |
| 16:00 평일 | `0 16 * * 1-5` | runClosingReport |
| 16:30 금요일 | `30 16 * * 5` | runMonthlyReport |
| 23:00 매일 | `0 23 * * *` | runNightMonitor |
| 02:00 매일 | `0 2 * * *` | runNightMonitor |
| 10:00 일요일 | `0 10 * * 0` | runWeeklyReport |

---

## WebSocket (kis-websocket.js)

- `connect(stockCodes)`: 최대 10종목, `isMarketOpen()` 체크 후 연결
- `H0STCNT0`: 체결 tick → `tickData[code]` (max 300개, 5분 window)
- `H0STASP0`: 호가 → `hokaData[code]` (buyWall/sellWall)
- 장 중 연결 끊기면 30초 후 자동 재연결
- `checkAlerts(holdings)`: -3% 5분 급락 / 목표가 / 트레일링 스탑 → 직접 텔레그램 발송

---

## 금지 패턴

- `require` 내부에서 동적 사용 지양 (단, 순환참조 방지 목적은 허용)
- `process.env` 접근 시 `.env` 로드 확인 (`dotenv.config()` 상단)
- DB 쿼리에서 날짜는 `YYYY-MM-DD` TEXT 형식 (ISO 슬라이스: `.toISOString().slice(0,10)`)
- 텔레그램 메시지 4096자 초과 금지 (자동 절단 없음 — 수동 slice 필요)
- `kakao.js` 파일명은 유지 (전체 import 경로 변경 방지). 내부 구현만 텔레그램
- 카카오 관련 env 변수(`KAKAO_*`) 참조 코드 신규 추가 금지
