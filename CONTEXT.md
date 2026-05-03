# AI Trader - 컨텍스트 요약

> Claude Web/App 프로젝트 메뉴 등록용 - 새 세션 시작 시 자동 주입

---

## 프로젝트 정의

**Claude AI 기반 24시간 자동 한국 주식 투자 의사결정 시스템**. Sonnet(정밀 분석) + Haiku(뉴스 필터링)로 매수/매도 판단 → 텔레그램 알림 → 사용자 수동 거래.

---

## 핵심 기능

| 기능 | 구현 상태 | 비고 |
|------|-----------|------|
| 08:00 종목 스캔 | ✅ | KIS API, score 기반 10종목 선정 |
| 08:30 모닝 리포트 | ✅ | Sonnet 1회 |
| 09:05 종목 추천 | ✅ | Sonnet 1회, 실시간 데이터 반영 |
| 장중 모니터링 | ✅ | 30분마다, Sonnet 조건부 (급락/뉴스) |
| 16:00 마감 리포트 | ✅ | Sonnet 1회 |
| 실시간 체결/호가 | ✅ | KIS WebSocket, 최대 10종목 |
| 급락/목표가 알림 | ✅ | WS 기반 즉시 알림 |
| 새벽 뉴스 수집 | ✅ | 00:00~07:00 매시간 RSS |
| 야간 미국 시장 | ✅ | 23:00, 02:00 크롤링 (Haiku만) |
| 웹 대시보드 | ✅ | Express + HTML/CSS/JS |
| 자동 매매 | ❌ | 의사결정만, 거래는 수동 |

---

## 기술 스택

- **런타임**: Node.js 20.x (CommonJS, PM2)
- **DB**: SQLite WAL (better-sqlite3, 동기)
- **AI**: Claude Sonnet 4.5 (15회/일), Haiku 4.5 (무제한)
- **스케줄**: node-cron (KST 기준)
- **웹**: Express 4.18
- **외부 API**: KIS 증권, Telegram, 네이버증권, DART

---

## 디렉토리 구조 (핵심만)

```
src/
├── index.js          # 진입점 (Express + cron)
├── scheduler/        # 시간 기반 작업 (scan, report, monitor 등)
├── services/         # 비즈니스 로직 (claude, kis, telegram 등)
├── routes/           # 웹 API (portfolio, chat, history)
├── db/               # SQLite (database.js, schema.sql)
└── public/           # 웹 정적 파일
```

---

## 핵심 용어

| 용어 | 의미 |
|------|------|
| watchlist | 08:00 스캔으로 선정된 오늘의 후보 종목 10개 |
| holdings | 사용자 보유종목 (웹에서 입력) |
| trades | 실현 손익 기록 (매도 완료 시 입력) |
| score | 스캔 점수 (RSI+MACD+수급+거래량, 5점 이상 통과) |
| tick | 실시간 체결 데이터 (5분 윈도우 300개) |
| urgent | 즉시 발송 알림 (중복 차단 없음) |
| KST | 한국 표준시 (`new Date(Date.now() + 9*3600*1000)`) |

---

## 알려진 제약사항

- Sonnet 한도: 60초/1회, 시간당 5회, 일일 15회
- KIS WS: 최대 10종목 동시 연결
- Telegram: 분당 30건
- 네이버증권: 15분 지연 (RSI, MACD)
- KIS 장외 API: 500 에러 정상 (현재가 조회 불가)

---

## 자주 하는 작업

### 1. 새 스케줄 추가
```javascript
// src/index.js
cron.schedule('0 10 * * 1-5', async () => {
  await runNewTask();
}, { timezone: 'Asia/Seoul' });

// src/scheduler/newtask.js 생성
```

### 2. Sonnet 프롬프트 수정
- 파일: `src/services/claude-sonnet.js`
- `SYSTEM_PROMPT` 또는 `callSonnet()` 내 프롬프트 수정
- JSON 응답 형식 변경 시 파싱 로직도 수정

### 3. 알림 포맷 변경
- 파일: `src/scheduler/closing.js`, `report.js` 등
- `formatXXXReport()` 함수 수정
- `sendTelegram(msg, stockName, alertType, urgent)` 호출

### 4. DB 스키마 변경
- `src/db/schema.sql` 수정
- DB 삭제 후 재시작 (자동 재생성) 또는 마이그레이션 스크립트
- 관련 쿼리 (`db.prepare(...)`) 전부 수정

### 5. 웹 페이지 수정
- `src/public/*.html` 직접 수정
- CSS: `src/public/style.css`
- API 변경 시: `src/routes/*.js`

---

## 금지 패턴

- ❌ `new Date().getHours()` (서버 UTC 기준 — KST 패턴 사용)
- ❌ `require('../services/kakao')` (삭제됨, telegram 사용)
- ❌ Sonnet 직접 axios 호출 (guard.js 우회 금지)
- ❌ `await db.prepare(...)` (동기 API임)
- ❌ `kisBackupMode` 전역 변수 (제거됨, 종목별 독립 fallback)

---

## 환경변수 핵심 항목

```env
CLAUDE_API_KEY=sk-ant-...
KIS_APP_KEY=...
KIS_APP_SECRET=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
STOCK_SELL_TAX_RATE=0.002  # 매도세 0.2%
SERVER_IP=your.server.ip
```

---

## DB 핵심 테이블

| 테이블 | 주요 컬럼 | 용도 |
|--------|-----------|------|
| holdings | date, stock_name, stock_code, quantity, avg_price | 보유종목 |
| trades | date, stock_name, trade_type, profit_loss | 실현손익 |
| watchlist | date, stock_name, rsi, macd, score | 스캔 결과 |
| analysis | date, action, reason, confidence | Sonnet 판단 이력 |
| alerts | date, stock_name, alert_type, sent_at | 중복 차단 |
| api_calls | date, model, call_count_today, last_called_at | rate limit |

`trade_type`: `sell_profit`, `sell_loss`, `switch`, `buy`

---

## 일일 스케줄 요약

| KST | 작업 | Sonnet |
|-----|------|--------|
| 00~07 | 뉴스 수집 | ❌ |
| 08:00 | 스캔 | ❌ |
| 08:30 | 모닝 리포트 | ✅ |
| 08:50 | WS 사전 연결 | ❌ |
| 09:00 | WS 정식 연결 | ❌ |
| 09:05 | 종목 추천 | ✅ |
| 09~15:30 | 장중 모니터링 | 조건부 |
| 15:35 | WS 종료 | ❌ |
| 16:00 | 마감 리포트 | ✅ |
| 23:00, 02:00 | 미국 시장 | ❌ |

---

## 비용 (일일)

- Sonnet: 최대 15회 × $0.08 = **$1.2**
- Haiku: ~50회 × $0.001 = **$0.05**
- **합계**: ~$1.25/일 (~$37.5/월)

---

## 파일별 핵심 역할

| 파일 | 역할 | 수정 빈도 |
|------|------|-----------|
| `services/claude-sonnet.js` | Sonnet 호출 + 프롬프트 | 높음 |
| `services/guard.js` | rate limiting | 낮음 |
| `services/kis-websocket.js` | 실시간 데이터 | 중간 |
| `scheduler/scan.js` | 종목 스캔 로직 | 중간 |
| `scheduler/recommendation.js` | 09:05 추천 | 중간 |
| `scheduler/monitor.js` | 장중 모니터링 | 중간 |
| `scheduler/closing.js` | 마감 리포트 | 높음 |
| `routes/portfolio.js` | 웹 API | 중간 |

---

## 현재 버전 특징 (v7)

- 텔레그램 완전 전환 (kakao.js 삭제)
- 새벽 뉴스 수집 강화 (00~07시)
- 09:05 종목 추천 스케줄 추가
- WS 백오프 재연결 + 복구 알림
- Scan fallback 제거 (API 실패 시 명확한 알림)
- 수수료 계산 정확도 개선 (`calcRealPnL`)
- 마감 리포트 포맷 개선 (KST 헤더, 실질손익, 재진입 조건)
- 진입가 실시간 보정 (장중 현재가 반영)

---

**마지막 업데이트**: 2026-05-03
**토큰 수**: ~1800 (목표 2000 이하)
