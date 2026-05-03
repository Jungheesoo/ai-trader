# 프로젝트 동작 흐름

> 코드 없이 AI Trader가 어떻게 작동하는지 이해하기 위한 문서

---

## 🎯 전체 시스템 개요

AI Trader는 **3개의 핵심 사이클**로 작동합니다:

1. **수집(Collect)**: 뉴스, 시장 데이터, 실시간 체결 정보 수집
2. **분석(Analyze)**: Claude AI가 데이터를 종합하여 매수/매도/보유 판단
3. **알림(Notify)**: 판단 결과를 텔레그램으로 전송, 사용자는 수동으로 거래 실행

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│  데이터 수집  │ ---> │  AI 분석     │ ---> │ 텔레그램 알림 │
│  (자동)      │      │  (자동)      │      │  (자동)      │
└─────────────┘      └─────────────┘      └─────────────┘
                                                   │
                                                   v
                                          ┌─────────────┐
                                          │ 사용자 거래  │
                                          │  (수동)      │
                                          └─────────────┘
```

---

## 📅 일일 작동 흐름 (타임라인)

### 새벽 (00:00~08:00) - 뉴스 사전 수집

```
00:00, 01:00, ..., 07:00 (매시간)
├─ RSS 뉴스 수집 (네이버, 연합, 매경, 한경)
├─ Haiku AI로 빠르게 필터링 ("이 뉴스 한국 주식에 영향 있나?")
├─ 이벤트 종목 후보 발견 시 dawn_candidates 테이블 저장
└─ 08:00 스캔 단계에서 우선 분석 대상으로 활용
```

**목적**: 장 시작 전 이벤트 종목 사전 포착 (예: 밤사이 대규모 수주 뉴스)

---

### 아침 (08:00~09:05) - 오늘의 전략 수립

#### 08:00 - 종목 스캔 (AI 없이 기계적 스크리닝)

```
1. KIS API로 거래량/등락률 순위 상위 40종목씩 수집 (총 80종목)
2. 새벽 포착한 이벤트 종목 추가
3. 잡주 필터링 (스팩, 우선주, 5일 +30% 급등주 제외)
4. 각 종목별 기술적 분석:
   - 일봉 60개 수집
   - RSI, MACD, 거래량 비율 계산
   - 외국인/기관 수급 5일치 수집
5. 점수 산정 (RSI+MACD+수급+거래량)
   - RSI 40~65: 3점 (황금구간)
   - MACD 골든크로스: 3점
   - 외국인+기관 동시 매수: 3점
   - 거래량 2배 이상: 2점
6. 5점 이상 종목만 watchlist 테이블 저장 (상위 10개)
```

**결과**: 오늘 AI가 분석할 후보 종목 10개 선정

#### 08:30 - 모닝 리포트 (Sonnet 1회 호출)

```
입력:
  - watchlist 10종목 정보
  - 어젯밤 수집한 뉴스 (relevant=true만)
  - 미국 SOX 반도체 지수
  - 달러/원 환율
  - 오늘 날짜 (월요일 여부 등)

Sonnet 판단:
  - "오늘 시장 분위기 어떤가?" (상승/하락/중립)
  - "어떤 섹터가 유망한가?" (반도체/방산/원전 등)
  - "현금 보유 vs 진입 타이밍?"
  - "주의할 리스크는?"

출력:
  - 텔레그램으로 모닝 리포트 발송
  - morning_strategy 테이블에 저장
```

**목적**: 오늘 장 시작 전 전체 시장 전망 파악

#### 08:50 - WebSocket 사전 연결 (조용히)

```
1. 보유종목 코드 리스트 로드
2. KIS WebSocket 연결 시도 (에러 시 조용히 무시)
3. 09:00 정식 연결 전 미리 준비
```

#### 09:00 - WebSocket 정식 연결

```
1. 보유종목(최대 10개) 실시간 체결/호가 구독
2. 5분 윈도우로 틱 데이터 수집 시작
   - tickData[종목코드] = [최근 300개 체결]
   - hokaData[종목코드] = {매수호가, 매도호가, 잔량}
```

#### 09:05 - 종목 추천 (Sonnet 1회 호출)

```
입력:
  - watchlist 상위 5종목
  - 각 종목의 실시간 데이터 (09:00~09:05 WS 수집본)
  - 08:30 모닝 전략

Sonnet 판단:
  - "이 중 어느 종목을 매수할까?"
  - "진입가는?"
  - "목표가, 손절가는?"

출력:
  - 텔레그램으로 매수 추천 발송
  - morning_strategy 테이블 업데이트
```

**목적**: 장 시작 직후 실시간 데이터 반영한 구체적 매수 추천

---

### 장중 (09:00~15:30) - 보유종목 실시간 모니터링

#### 30분마다 (09:00, 09:30, 10:00, ..., 15:30)

```
조건 체크:
  1. 보유종목이 있는가?
  2. 보유종목의 RSI/current_price가 DB에 있는가?
  3. 다음 중 하나라도 해당하는가?
     - 5분 동안 -3% 이상 급락 (WS 틱 데이터 분석)
     - 긴급 뉴스 발생 (Haiku urgency='긴급')

조건 만족 시:
  - Sonnet 호출
  - 입력: 보유종목 정보 + 실시간 데이터 + 뉴스
  - 판단: "매도? 보유? 다른 종목으로 갈아타기?"
  - 출력: 텔레그램 알림

조건 불만족 시:
  - Sonnet 호출 안 함 (비용 절감)
  - 단순 로그만 기록
```

#### 실시간 알림 (WS 데이터 기반)

WebSocket이 체결 데이터를 받을 때마다 자동으로 다음을 체크:

```
checkAlerts() 함수:
  1. 5분 -3% 급락
     - 최근 300틱 중 최고가 대비 현재가 -3% 이상
     - 즉시 텔레그램 발송 (urgent=true)

  2. 목표가 도달
     - current_price >= target_price
     - 즉시 텔레그램 발송 (urgent=true)

  3. 트레일링 스탑 이탈
     - 최고가 대비 -5% 하락
     - 즉시 텔레그램 발송 (urgent=true)
```

---

### 마감 (15:35~16:00) - 오늘 정리

#### 15:35 - WebSocket 연결 종료

```
1. 모든 구독 해제
2. WS 연결 종료
3. tickData/hokaData 메모리 정리
```

#### 16:00 - 마감 리포트 (Sonnet 1회 호출)

```
입력:
  - 보유종목 현황 (평가손익, 실질손익)
  - 오늘 실현 손익 (trades 테이블 집계)
  - 오늘 Sonnet 호출 횟수
  - 미국 SOX/환율 (장 마감 후 반영)

Sonnet 판단:
  - "오늘 수익/손실 어땠나?"
  - "내일 전략은?" (보유 계속 vs 매도 vs 갈아타기)
  - "리스크는?"

출력:
  - 텔레그램 마감 리포트
  - seed_growth 테이블에 오늘 자산 기록
```

**추가 작업**:
- 금요일 13:30 - 주말 점검 리포트
- 마지막 금요일 16:30 - 월간 성과 리포트

---

### 야간 (23:00, 02:00) - 미국 시장 모니터링

```
1. 나스닥, S&P500, 다우 현재 등락률 크롤링 (Google Finance)
2. 나스닥 -3% 이상 급락 시 즉시 긴급 알림
3. 미국 경제 뉴스 수집 (RSS)
4. Haiku로 필터링 (Sonnet 미호출 - 비용 절감)
5. 긴급 이슈 발견 시 텔레그램 발송
```

**목적**: 한국 장 시작 전 미국 악재 사전 포착

---

## 🔄 핵심 데이터 흐름

### 1. 종목 스캔 → 추천 파이프라인

```
[08:00 scan.js]
  KIS 거래량/등락률 순위 API (80종목)
          ↓
  기술적 분석 (RSI, MACD, 수급)
          ↓
  점수 산정 (5점 이상만 통과)
          ↓
  watchlist 테이블 저장 (상위 10개)
          ↓
[08:30 report.js]
  Sonnet: watchlist + 뉴스 → 모닝 전략
          ↓
[09:05 recommendation.js]
  Sonnet: watchlist + 실시간 데이터 → 매수 추천
          ↓
[사용자]
  텔레그램 확인 → HTS에서 수동 매수
          ↓
[포트폴리오 입력]
  웹 대시보드에서 보유종목 입력
          ↓
[장중 monitor.js]
  Sonnet: 보유종목 분석 → 매도/보유 판단
```

### 2. 뉴스 필터링 파이프라인

```
[RSS 수집]
  네이버뉴스, 연합뉴스, 매경, 한경
          ↓
[Haiku 1차 필터링]
  관련성 판단 (relevant: true/false)
  urgency 분류 (긴급/주의/정보)
  affected_sectors 추출 (반도체/방산 등)
  candidate_stocks 추출 (종목명)
          ↓
[DB 저장]
  news_cache 테이블 (중복 방지)
          ↓
[Sonnet 2차 분석]
  relevant=true 뉴스만 전달
  보유종목/watchlist 맥락 추가
  구체적 행동 판단
```

**비용 최적화**:
- 글로벌 거시 키워드 (트럼프, 나스닥, 연준) → Haiku 건너뛰고 자동 통과
- 관련 없는 뉴스 (부동산, 연예) → Haiku에서 차단
- Sonnet은 최종 판단에만 사용

### 3. 실시간 체결 → 알림 파이프라인

```
[09:00 WS 연결]
  KIS WebSocket 구독 (보유종목)
          ↓
[체결 데이터 수신]
  매초마다 tickData 배열에 추가
  최근 300개 (약 5분) 유지
          ↓
[checkAlerts() 자동 실행]
  틱 데이터 분석 (급락/목표가/트레일링)
          ↓
[조건 만족 시]
  sendTelegram(urgent=true)
  즉시 알림, 중복 차단 없음
```

---

## 🗂️ 모듈별 역할 분리

### `src/index.js` - 오케스트레이터
- Express 서버 시작
- cron 스케줄 등록
- 라우트 연결
- **다른 모듈 직접 실행 안 함, 스케줄만 관리**

### `src/scheduler/*` - 시간 기반 작업
| 파일 | 역할 | Sonnet 호출 |
|------|------|-------------|
| scan.js | 종목 스캔 (기계적) | ❌ |
| report.js | 모닝 리포트 | ✅ 1회 |
| recommendation.js | 종목 추천 | ✅ 1회 |
| monitor.js | 장중 모니터링 | ✅ 조건부 |
| closing.js | 마감 리포트 | ✅ 1회 |
| night.js | 야간 미국 시장 | ❌ (Haiku만) |

### `src/services/*` - 핵심 비즈니스 로직
| 파일 | 역할 | 외부 의존성 |
|------|------|-------------|
| claude-sonnet.js | Sonnet API 호출 | Anthropic API |
| claude-haiku.js | Haiku 뉴스 필터링 | Anthropic API |
| guard.js | Sonnet rate limiting | DB |
| kis.js | KIS REST API | KIS API |
| kis-websocket.js | KIS WS 실시간 | KIS WS |
| telegram.js | 알림 발송 | Telegram Bot API |
| portfolio.js | 보유종목 계산 | DB + kis.js + naver.js |
| analyzer.js | 모니터링 파이프라인 조율 | 모든 services |
| rss.js | 뉴스 수집 | RSS 피드 |
| naver.js | 기술적 지표 크롤링 | 네이버 증권 |
| dart.js | 공시 조회 | DART API |

### `src/routes/*` - 웹 API
- `portfolio.js` - 보유종목 CRUD, 매매 기록
- `chat.js` - AI 채팅 (Sonnet)
- `history.js` - 분석 이력 조회
- `stream.js` - SSE 실시간 알림 스트림

### `src/db/*` - 데이터 계층
- `database.js` - SQLite WAL 초기화, getDb() 헬퍼
- `schema.sql` - 테이블 스키마 정의

---

## 🧠 AI 분석 로직 (코드 없이 설명)

### Sonnet이 받는 입력 (JSON 구조)

```json
{
  "portfolio_summary": {
    "total_assets": 5000000,
    "stock_value": 3000000,
    "cash": 2000000,
    "overall_profit_rate": 5.2
  },
  "holdings": [
    {
      "stock_name": "삼성전자",
      "current_price": 75000,
      "avg_price": 71000,
      "quantity": 40,
      "profit_rate": 5.6,
      "rsi": 55,
      "macd": "골든크로스",
      "foreign_net": 50000,
      "institution_net": 30000,
      "trailing_stop": 71250
    }
  ],
  "watchlist": [
    {
      "stock_name": "SK하이닉스",
      "rsi": 58,
      "macd": "양전환",
      "volume_ratio": 2.5,
      "score": 8
    }
  ],
  "news": [
    {
      "title": "반도체 수출 20% 증가",
      "urgency": "주의",
      "affected_sectors": ["반도체"]
    }
  ],
  "market_context": {
    "sox_index": "+2.3%",
    "usd_krw": 1320,
    "report_type": "morning"
  }
}
```

### Sonnet이 출력하는 JSON

```json
{
  "action": "hold",
  "reason": "삼성전자 RSI 55로 과열 아님, 외국인 순매수 지속. 반도체 수출 호재로 상승 여력 있음.",
  "confidence": "high",
  "current_upside": 3.5,
  "target_price": 78000,
  "stop_loss": 71000,
  "market_outlook": "반도체 섹터 긍정적, SOX 지수 상승 추세",
  "key_risk": "나스닥 조정 시 동반 하락 가능성"
}
```

**action 종류**:
- `hold` - 보유 계속
- `sell_all` - 전량 매도
- `buy_more` - 추가 매수
- `switch_stock` - 갈아타기 (A 매도 → B 매수)
- `buy_new` - 신규 진입 (현금 → 매수)
- `hold_cash` - 현금 보유 유지

### AI 판단 프로세스 (내부 추론)

1. **맥락 파악**
   - 오늘 날짜 확인 (월요일? 금요일?)
   - 미국 시장 상황 (나스닥 급락? 상승?)
   - 보유종목 손익 상태

2. **기술적 지표 해석**
   - RSI 70 이상 → 과매수 (매도 신호)
   - RSI 30 이하 → 과매도 (매수 신호)
   - MACD 골든크로스 → 상승 전환
   - 거래량 급증 + 외국인 매수 → 강한 상승

3. **뉴스 영향 분석**
   - 긍정 뉴스 + 보유종목 섹터 일치 → 보유 유지
   - 부정 뉴스 + 급락 → 매도 고려
   - 대체 종목 호재 → 갈아타기 검토

4. **리스크 관리**
   - 손실 -5% 이상 → 손절 권고
   - 목표가 도달 → 익절 권고
   - 월요일 주말 효과 → 진입 보류
   - 금요일 → 주말 리스크 경고

5. **최종 판단**
   - `action` 결정
   - `confidence` 산정 (high/medium/low)
   - `reason` 작성 (한국어, 간결하게)

---

## 💾 상태 관리

### 메모리 (휘발성)
- `tickData` - 최근 5분 체결 데이터 (WS 연결 중에만)
- `hokaData` - 현재 호가 (WS 연결 중에만)
- `lastSonnetCallTime` - 마지막 Sonnet 호출 시각 (PM2 재시작 시 DB 복원)
- `hourCallCount` - 현재 시간대 Sonnet 호출 횟수

### DB (영구 저장)
| 테이블 | 저장 시점 | 용도 |
|--------|-----------|------|
| holdings | 사용자 입력 시 | 보유종목 현황 |
| trades | 매매 완료 입력 시 | 실현 손익 기록 |
| watchlist | 08:00 스캔 완료 시 | 오늘의 후보 종목 |
| analysis | Sonnet 호출 시 | AI 판단 이력 |
| alerts | 텔레그램 발송 시 | 중복 차단용 |
| api_calls | Sonnet/Haiku 호출 시 | rate limit 관리 |
| seed_growth | 16:00 마감 시 | 일별 자산 성장 추적 |
| news_cache | RSS 수집 시 | 뉴스 중복 방지 |

### 상태 변화 트리거

```
[사용자 입력]
  웹 → POST /api/portfolio/holdings
       → holdings 테이블 INSERT
       → WS 재연결 (종목 변경 시)

[매매 완료]
  웹 → POST /api/portfolio/trades
       → trades 테이블 INSERT
       → holdings 테이블 UPDATE (수량 차감)

[스캔 완료]
  scan.js → watchlist DELETE (오늘 기존 데이터)
           → watchlist INSERT (새 10개)

[Sonnet 호출]
  callSonnet() → api_calls UPDATE
                → analysis INSERT
                → guard.js lastSonnetCallTime 업데이트
```

---

## 🎨 왜 이렇게 설계했는가?

### 1. Haiku + Sonnet 2단계 필터링
**이유**: 비용 절감 + 정확도 유지
- Haiku: 1K 토큰 $0.0001 (저렴, 빠름) → 뉴스 100개 필터링해도 $0.03
- Sonnet: 1K 토큰 $0.015 (비쌈, 정밀) → 최종 판단에만 사용
- 만약 Sonnet으로 전체 뉴스 분석 시 → 일일 $10 초과

### 2. WebSocket 실시간 수집
**이유**: API 호출 횟수 제한 회피
- KIS REST API: 초당 20건 제한
- WS: 연결 1회로 무제한 수신 가능
- 급락 감지 시 즉시 알림 (API 폴링은 30초 지연)

### 3. 스케줄러 분리 (scan → report → recommendation)
**이유**: Sonnet 호출 최소화
- scan.js: AI 없이 기계적 스크리닝 (60종목 → 10종목)
- report.js: Sonnet 1회로 전체 시장 분석
- recommendation.js: Sonnet 1회로 구체적 매수 추천
- 통합 시 Sonnet 3회 → 분리 시 2회로 절감

### 4. 조건부 Sonnet (장중 모니터링)
**이유**: 불필요한 호출 방지
- 30분마다 무조건 호출 시 → 12회 (하루 한도 초과)
- 급락/뉴스 시에만 호출 → 평균 2~3회
- 평온한 날은 0회 → 한도 다음 날로 이월

### 5. DB 기반 중복 차단 (텔레그램)
**이유**: 알림 피로도 감소
- 같은 종목 같은 이유로 1시간 내 반복 알림 차단
- 긴급 알림(급락, 목표가)만 중복 허용
- 사용자가 놓칠 중요 알림은 보장, 스팸은 차단

---

**마지막 업데이트**: 2026-05-03
