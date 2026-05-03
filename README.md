# AI Trader - 완전 자동화 한국 주식 투자 시스템

> Claude AI 기반 24시간 자동 매매 의사결정 시스템

## 📖 프로젝트 개요

**AI Trader**는 Claude AI(Anthropic)를 두뇌로 사용하여 한국 주식시장을 24시간 모니터링하고, 자동으로 매수/매도/보유 판단을 내리는 완전 자동화 트레이딩 시스템입니다. 사용자는 AI의 추천을 받아 실제 거래를 수동으로 실행하며, 시스템은 실시간 시장 데이터, 뉴스, 기술적 지표를 종합 분석하여 텔레그램으로 알림을 전송합니다.

### 주요 특징

- **AI 기반 의사결정**: Claude Sonnet 4.5로 정밀 분석, Claude Haiku로 빠른 뉴스 필터링
- **24시간 모니터링**: 장중 30분마다 실시간 체결 데이터 분석, 새벽 미국 시장 모니터링
- **자동 스케줄링**: 08:00 스캔 → 08:30 모닝리포트 → 09:05 종목 추천 → 16:00 마감리포트
- **실시간 알림**: 급락(-3% 5분), 목표가 도달, 손절가 이탈 시 즉시 텔레그램 전송
- **종합 데이터 분석**: KIS API(현재가/수급), 네이버증권(보조지표), DART(공시), RSS(뉴스)
- **웹 대시보드**: 포트폴리오 입력, AI 채팅, 분석 이력 조회 기능

---

## 🎯 주요 기능

### 1. 자동 스케줄링 (cron 기반)

| 시간(KST) | 기능 | 설명 |
|-----------|------|------|
| 00:00~07:00 | 새벽 뉴스 수집 | RSS 매시간 수집, Haiku로 이벤트 종목 포착 |
| 08:00 | 아침 링크 발송 + 종목 스캔 | 웹 대시보드 링크, KIS API로 60종목 기술적 분석 |
| 08:30 | 모닝 리포트 | Sonnet 종합 분석 + 오늘 전략 (1회) |
| 08:50 | WS 사전 연결 | 장 개장 전 WebSocket 점검 |
| 09:00 | WS 정식 연결 | 보유 종목 실시간 체결/호가 수신 시작 |
| 09:05 | 종목 추천 | 스캔 결과 + 실시간 데이터 기반 매수 추천 (1회) |
| 09:00~15:30 | 장중 모니터링 | 30분마다 Sonnet 조건부 호출 (급락/뉴스 시) |
| 15:35 | WS 연결 종료 | 장 마감 후 WebSocket 종료 |
| 16:00 | 마감 리포트 | 오늘 손익 + 내일 전략 + 실현 손익 기록 |
| 23:00, 02:00 | 야간 미국 시장 | 나스닥/S&P500/다우 크롤링 (Haiku만) |

### 2. 실시간 데이터 수집

- **KIS WebSocket**: 보유 종목 체결(H0STCNT0), 호가(H0STASP0) 실시간 수신
- **KIS REST API**: 일봉/투자자별 수급/현재가 조회
- **네이버 증권**: RSI, MACD, 볼린저밴드, 거래량 비율
- **DART**: 긴급 공시 모니터링 (적격공시, 주요경영사항)
- **RSS**: 네이버뉴스, 연합뉴스, 매일경제, 한경 등 다중 소스

### 3. AI 분석 파이프라인

```
뉴스 수집 → Haiku 필터링 → Sonnet 정밀 분석 → 행동 결정 → 텔레그램 알림
```

- **Haiku (저비용)**: 뉴스 관련성 판단, 후보 종목 추출
- **Sonnet (고정밀)**: 보유 종목 매도/보유/갈아타기 판단, 신규 진입 종목 추천
- **Rate Limiting**: 시간당 5회, 일일 15회 제한 (비용 관리)

### 4. 웹 대시보드 (Express + HTML/CSS/JS)

| 페이지 | 경로 | 기능 |
|--------|------|------|
| 메인 | `/` | 오늘 자산, 실시간 손익, 알림 이력 |
| 포트폴리오 | `/portfolio` | 보유종목 입력, 매매 완료 입력 (실현손익 기록) |
| AI 채팅 | `/chat` | 포트폴리오 기반 질문 (Sonnet) |
| 분석 이력 | `/history` | 과거 AI 판단 기록, 정확도 추적 |

---

## 🛠️ 기술 스택

### 언어 & 런타임
- **Node.js 20.x** (ES Modules 미사용, CommonJS)
- **JavaScript** (비동기 처리: async/await, Promise)

### 프레임워크 & 라이브러리
| 카테고리 | 패키지 | 용도 |
|---------|--------|------|
| 웹 서버 | `express@4.18` | REST API + 정적 파일 서빙 |
| DB | `better-sqlite3@9.4` | WAL 모드 SQLite (동기 쿼리) |
| 스케줄링 | `node-cron@3.0` | cron 표현식 기반 자동 실행 |
| WebSocket | `ws@8.20` | KIS 실시간 데이터 수신 |
| HTTP 클라이언트 | `axios@1.6` | KIS/DART/Claude API 호출 |
| 뉴스 파싱 | `rss-parser@3.13` | RSS 피드 수집 |
| HTML 파싱 | `cheerio@1.0` | 미국 증시 크롤링 |

### 외부 API
| 서비스 | 용도 | 필수 여부 |
|--------|------|-----------|
| **Anthropic Claude** | AI 분석 (Sonnet 4.5, Haiku 4.5) | 필수 |
| **KIS 증권** | 실시간 체결/호가, 일봉, 수급 데이터 | 필수 |
| **Telegram Bot** | 알림 발송 (Kakao 대체) | 필수 |
| **네이버 증권** | 기술적 지표 (RSI, MACD 등) | 필수 |
| **DART** | 공시 정보 | 선택 |

### 데이터베이스 (SQLite)
- **위치**: `data/trading.db`
- **모드**: WAL (Write-Ahead Logging) - 동시성 향상
- **주요 테이블**: holdings, trades, watchlist, analysis, alerts, api_calls

---

## 🚀 설치 및 실행

### 1. 사전 요구사항
- **Node.js 20.x 이상**
- **PM2** (프로세스 관리)
- **KIS 증권 계좌** (모의투자 가능)
- **Telegram Bot Token** ([BotFather](https://t.me/botfather)에서 생성)
- **Claude API Key** ([Anthropic Console](https://console.anthropic.com))

### 2. 설치 단계
```bash
# 저장소 클론
git clone <repository-url>
cd ai-trader

# 의존성 설치
npm install

# 환경변수 설정
cp .env.example .env
vi .env  # 필수 항목 입력 (아래 참고)

# DB 초기화 (자동)
npm start  # 첫 실행 시 schema.sql 자동 적용

# PM2로 실행 (권장)
pm2 start ecosystem.config.js
pm2 logs ai-trader
```

### 3. 환경변수 (.env)

#### AI 관련
```env
CLAUDE_API_KEY=sk-ant-...
CLAUDE_SONNET_MODEL=claude-sonnet-4-20250514
CLAUDE_HAIKU_MODEL=claude-haiku-4-5-20251001
CLAUDE_SONNET_MIN_INTERVAL_SECONDS=60
CLAUDE_SONNET_MAX_CALLS_PER_HOUR=5
CLAUDE_SONNET_MAX_CALLS_PER_DAY=15
```

#### 증권사 API
```env
KIS_APP_KEY=your_app_key
KIS_APP_SECRET=your_app_secret
KIS_ACCOUNT_NO=12345678-01
KIS_BASE_URL=https://openapi.koreainvestment.com:9443
```

#### 알림
```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=123456789
```

#### 보조 서비스 (선택)
```env
NAVER_CLIENT_ID=your_naver_client_id
NAVER_CLIENT_SECRET=your_naver_secret
DART_API_KEY=your_dart_key
```

#### 시스템 설정
```env
PORT=3000
NODE_ENV=production
SERVER_IP=your.server.ip  # 웹 대시보드 URL 생성용
STOCK_SELL_TAX_RATE=0.002  # 매도세 0.2% (증권거래세 0.18% + 농특세 0.02%)
STOCK_BUY_FEE_RATE=0       # 매수 수수료 (보통 0)
```

---

## 📂 디렉토리 구조

```
ai-trader/
├── src/
│   ├── index.js              # 진입점 - Express 서버 + cron 스케줄러
│   ├── db/
│   │   ├── database.js       # SQLite WAL 초기화 + 쿼리 헬퍼
│   │   └── schema.sql        # 테이블 스키마 정의
│   ├── routes/               # Express 라우트
│   │   ├── portfolio.js      # 포트폴리오 CRUD (보유종목, 매매기록)
│   │   ├── chat.js           # AI 채팅 (/api/chat)
│   │   ├── history.js        # 분석 이력 조회
│   │   └── stream.js         # SSE 스트리밍 (실시간 알림)
│   ├── scheduler/            # cron 작업 모듈
│   │   ├── morning.js        # 08:00 - 링크 발송
│   │   ├── scan.js           # 08:00 - 종목 스캔 (60종목 → 상위 10개)
│   │   ├── report.js         # 08:30 - 모닝 리포트 (Sonnet)
│   │   ├── recommendation.js # 09:05 - 종목 추천 (Sonnet)
│   │   ├── monitor.js        # 09:00~15:30 - 장중 모니터링
│   │   ├── closing.js        # 16:00 - 마감 리포트 + 시드 성장 기록
│   │   ├── friday.js         # 금 13:30 - 주말 점검
│   │   ├── monday.js         # 월 09:30 - 주말 효과 판단
│   │   ├── weekly.js         # 일 10:00 - 주간 성과 집계
│   │   ├── monthly.js        # 마지막 금 16:30 - 월간 리포트
│   │   └── night.js          # 23:00, 02:00 - 미국 시장 모니터링
│   ├── services/             # 핵심 비즈니스 로직
│   │   ├── analyzer.js       # 모니터링 파이프라인 조율
│   │   ├── claude-sonnet.js  # Sonnet API 호출 + 구조화된 프롬프트
│   │   ├── claude-haiku.js   # Haiku 뉴스 필터링
│   │   ├── guard.js          # Sonnet rate limiting (60s/3per-hr/15per-day)
│   │   ├── kis.js            # KIS REST API (일봉, 수급, 현재가)
│   │   ├── kis-websocket.js  # KIS WS (체결, 호가) + 자동 재연결
│   │   ├── telegram.js       # 텔레그램 발송 + 중복 차단
│   │   ├── portfolio.js      # 보유종목 조회 + 실현손익 계산
│   │   ├── rss.js            # 다중 RSS 수집 (fallback)
│   │   ├── naver.js          # 네이버증권 크롤링 (RSI, MACD)
│   │   ├── dart.js           # DART 공시 조회
│   │   ├── holiday.js        # 공휴일 판단 (KST 기준)
│   │   ├── alert.js          # 에러 알림 전송
│   │   └── dateutil.js       # KST 시간 유틸
│   ├── utils/
│   │   └── market.js         # 장 개장 여부 판단 (KST 기준)
│   └── public/               # 웹 대시보드 정적 파일
│       ├── index.html        # 메인 페이지
│       ├── portfolio.html    # 포트폴리오 입력
│       ├── chat.html         # AI 채팅
│       ├── history.html      # 분석 이력
│       └── style.css         # 공통 스타일
├── data/
│   └── trading.db            # SQLite 데이터베이스
├── logs/                     # PM2 로그
├── .env                      # 환경변수 (gitignore)
├── .env.example              # 환경변수 샘플
├── ecosystem.config.js       # PM2 설정
├── package.json              # 의존성
└── README.md                 # 이 파일
```

---

## 🔄 시스템 작동 흐름

### 아침 (장 시작 전)
1. **08:00** - RSS 뉴스 수집 → Haiku 필터링 → 후보 종목 DB 저장
2. **08:00** - KIS API로 거래량/등락률 순위 60종목 수집
3. **08:00** - 후보 종목 기술적 분석 (RSI, MACD, 수급) → 상위 10개 `watchlist` 테이블 저장
4. **08:30** - Sonnet이 watchlist + 뉴스 + SOX/환율 분석 → 텔레그램 모닝 리포트
5. **08:50** - WebSocket 사전 연결 (조용히)
6. **09:00** - WebSocket 정식 연결 (보유종목 실시간 수신 시작)
7. **09:05** - Sonnet이 watchlist 상위 종목 + 실시간 데이터 분석 → 매수 추천

### 장중 (09:00~15:30)
1. **실시간 체결 데이터** - WebSocket으로 5분 윈도우 틱 데이터 수집
2. **30분마다** - 조건부 Sonnet 호출
   - 조건: 보유종목 RSI/current_price 있음 + (5분 -3% 급락 또는 긴급 뉴스)
   - 호출 시: 매도/보유/갈아타기 판단 → 텔레그램 알림
3. **실시간 알림** - WebSocket 데이터 기반
   - 5분 -3% 급락
   - 목표가 도달
   - 트레일링 스탑 이탈

### 마감 (16:00 이후)
1. **16:00** - Sonnet 마감 분석 → 내일 전략 + 실현 손익 DB 저장
2. **금 13:30** - 주말 효과 점검 (금요일만)
3. **금 16:30** - 월간 리포트 (마지막 금요일만)

### 야간 (23:00, 02:00)
1. 나스닥/S&P500/다우 크롤링 (Google Finance)
2. Haiku로 미국 뉴스 필터링 (Sonnet 미호출)
3. 나스닥 -3% 이상 급락 시 긴급 알림

---

## 💰 비용 관리

### Claude API 사용량 (일일 기준)
| 모델 | 용도 | 1회 토큰 | 일일 호출 | 예상 비용 |
|------|------|----------|-----------|-----------|
| Sonnet 4.5 | 정밀 분석 | 4K in / 1K out | 최대 15회 | ~$1.2 |
| Haiku 4.5 | 뉴스 필터링 | 0.3K in / 0.15K out | ~50회 | ~$0.05 |
| **합계** | | | | **~$1.25/일** |

### 비용 절감 전략
- Rate Limiting: 시간당 5회, 일일 15회 제한
- Haiku 선제 필터링: 뉴스 관련성 판단 후 Sonnet 호출
- 조건부 Sonnet: 장중 급락/뉴스 발생 시에만 호출
- 거시 키워드 자동 통과: 트럼프/나스닥 등 Haiku 미호출

---

## ⚠️ 제한사항 및 주의사항

### 자동 매매 아님
- 시스템은 **판단만** 제공, 실제 거래는 사용자가 수동 실행
- 매수/매도 추천을 받으면 KIS HTS/MTS에서 직접 주문 필요

### 데이터 지연
- 네이버증권: 15분 지연 (RSI, MACD)
- SOX 지수: 미국 장 개장 후 (15분 지연)
- KIS WebSocket: 실시간 (지연 없음)

### KST 시간 기준
- 서버 UTC 설정 무관하게 모든 스케줄은 KST 기준
- `new Date(Date.now() + 9 * 60 * 60 * 1000)` 패턴 사용
- 공휴일 판단: 대체 공휴일 자동 인식

### Rate Limiting
- Sonnet: 60초/1회, 시간당 5회, 일일 15회 (guard.js)
- KIS API: 과부하 방지 0.4초 딜레이 (순차 호출)
- Telegram: 분당 30건, 일일 무제한

---

## 📊 성과 추적

### DB 기록
- `trades` 테이블: 실현 손익 (sell_profit, sell_loss, switch)
- `seed_growth` 테이블: 일별 자산 성장 추적
- `analysis` 테이블: AI 판단 이력 (검증용)
- `performance` 테이블: 주간 정확도 집계

### 웹 대시보드
- 실시간 손익 (평가손익, 수익률)
- 실현 손익 (제세금 포함 정확한 계산)
- AI 판단 정확도 그래프

---

## 🤝 기여 및 라이선스

이 프로젝트는 개인용 투자 시스템으로 개발되었습니다.

### 주의사항
- 투자 손실에 대한 책임은 전적으로 사용자에게 있습니다
- AI 판단은 참고용이며, 절대적이지 않습니다
- 백테스트 없이 실전 투입 시 리스크 관리 필수

---

**마지막 업데이트**: 2026-05-03
