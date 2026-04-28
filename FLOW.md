# AI 트레이더 시스템 플로우

## 전체 구조

```
사용자 (토스증권으로 직접 매매)
    ↑ 텔레그램 알림
    |
[Google Cloud 서버 :3000]
    |
    ├── 스케줄러 (node-cron, Asia/Seoul)
    ├── 웹 UI (Express)
    ├── AI 분석 (Claude Haiku + Sonnet)
    ├── 데이터 수집 (KIS REST + KIS WebSocket / 네이버 / RSS / DART)
    ├── 알림 (텔레그램 Bot API)
    └── SQLite DB (better-sqlite3, WAL)
```

---

## 하루 타임라인

```
07:00  카카오 Refresh Token 만료 체크 (매일)

08:00  [평일] ① 웹 UI 링크 카카오 발송
              ② 60개 종목 퀀트 스캔 시작 (Claude 호출 없음)

08:10  [평일] 자산 입력 마감
              → 입력 완료: 입력 데이터 사용
              → 미입력: 전일 데이터 자동 사용

08:30  [평일] 모닝 리포트 (Sonnet 1회)
              → 텔레그램 발송

09:00  [평일] KIS WebSocket 연결 (보유 종목 실시간 체결/호가)

09:00  [평일] 장 중 모니터링 시작 (30분마다)

09:30  [월요일만] 주말 효과 판단 (Sonnet 1회)

13:30  [금요일만] 주말 리스크 특별 점검 (Sonnet 1회)

15:30  장 마감

15:35  [평일] KIS WebSocket 연결 해제

16:00  [평일] 마감 리포트 (Sonnet 1회) + 일별 시드 성장 저장

16:30  [마지막 금요일] 월간 리포트 (Sonnet 1회)
              → 월간 매매 집계, 시드 성장률, AI 적중률, 다음 달 전략

23:00  야간 미국 시장 모니터링 (Haiku만, Sonnet 없음)

02:00  야간 미국 시장 모니터링 (Haiku만, Sonnet 없음)

일요일 10:00  주간 성과 리포트 (Sonnet 없음)
              → trades 테이블 기반 실현 손익, 승률, 시드 변화
```

---

## 장 중 모니터링 파이프라인 (30분마다)

```
1단계: 퀀트 계산 (코드, Claude 없음)
   ├── KIS REST API: 현재가, 거래량, 외국인/기관 수급
   │     └── 데이터 공백(장 중) → 전일 수급 자동 fallback
   ├── KIS 실패 시 → 네이버 금융 자동 백업 (종목별 독립 fallback)
   ├── 장 외 시간 → DB 저장값 반환 (KIS/네이버 호출 없음)
   ├── RSI, MACD, 볼린저밴드, 거래량배수, 트레일링스탑 계산
   ├── 외국인 5일 누적 수급, 연속 매수/매도일 계산
   └── 보유 종목별 수익률 계산

1-b단계: WebSocket 실시간 (KIS 연결 중일 때)
   ├── H0STCNT0: 체결 tick (5분 window, 최대 300건)
   │     ├── getStrength(): 최근 N분 평균 체결강도
   │     └── get5MinChange(): 5분 전 대비 가격 변화율
   ├── H0STASP0: 호가 잔량
   │     ├── getBuyWall(): 매수호가 1~5 잔량 합계
   │     └── getSellWall(): 매도호가 1~5 잔량 합계
   └── checkAlerts(): 조건 충족 시 즉시 카카오 발송 (Claude 없음)
         ├── 5분 -3% 이상 급락
         ├── 목표가(매수가+5%) 도달
         └── 트레일링 스탑 도달

2단계: 뉴스 수집 (Claude 없음)
   ├── RSS: 한국경제, 매일경제, 연합뉴스, Google News (다중 URL fallback)
   ├── 네이버 뉴스 API (보유 종목별 + 시장 키워드 확장)
   ├── DART 공시 체크
   └── news_cache로 중복 제거

3단계: Haiku 필터링
   ├── 입력: title + body[:200] (max_tokens 150)
   ├── 보유 종목 영향 여부 문맥 판단
   └── relevant: true인 뉴스만 다음 단계로

4단계: Sonnet 호출 조건 판단 (아래 중 1개 이상)
   ├── 주가 ±3% 이상 변동
   ├── 거래량 평소 2배 이상
   ├── 외국인/기관 대량 매매 (10만주 초과)
   ├── Haiku가 긴급/주의 뉴스 판단
   ├── DART 신규 공시
   ├── 트레일링 스탑 도달 (고점 -7%)
   ├── 목표가 도달
   ├── RSI 70 이상 또는 30 이하
   └── MACD 골든/데드크로스

5단계: Sonnet 정밀 분석 (조건 해당 시에만)
   ├── 포트폴리오 전체 현황 (BB, 외국인연속일, 수급날짜 포함)
   ├── Haiku 통과 뉴스 최대 5개 (50자 요약)
   ├── watchlist 상위 5종목 (외국인 방향 포함)
   └── 액션 판단: sell_all / buy_more / hold / switch_stock / buy_new / hold_cash / unknown

6단계: 텔레그램 알림
   ├── 긴급(urgent=true): 급락·목표가·트레일링·DART URGENT_BAD — dedup 없이 무조건 발송
   ├── 일반(urgent=false): 동일 stockName+alertType 1시간 내 중복 차단
   └── 텔레그램 실제 제한: 분당 30건 (일 제한 없음)
```

---

## Sonnet 응답 형식

```json
{
  "action": "sell_all|buy_more|hold|switch_stock|buy_new|hold_cash|unknown",
  "reason": "판단 근거",
  "confidence": "high|medium|low",
  "current_upside": 7.2,
  "target_price": 130000,
  "stop_loss": 105000,
  "entry_price": 115000,
  "market_outlook": "시장 전망 한 줄",
  "key_risk": "핵심 리스크",
  "switch_stock": {
    "name": "종목명",
    "code": "006400",
    "reason": "교체 근거",
    "expected_upside": 12.0,
    "target_price": 90000,
    "stop_loss": 72000,
    "entry_price": 80000
  }
}
```

---

## Sonnet 호출 제한 (4중 보호)

```
1. 호출 간격: 마지막 호출 후 최소 60초 (guard.js)
2. 시간당: 최대 3회
3. 일당: 최대 15회 (초과 시 카카오 알림 후 당일 중단)
4. Anthropic Console: 월 $5 한도 (코드와 무관하게 차단)

Sonnet 호출 없음:
  - 야간 미국 시장 모니터링
  - 주간 성과 리포트
  - 퀀트 스캔
  - WebSocket 실시간 알림
```

---

## 매매 완료 입력 플로우 (웹 UI → DB)

```
portfolio.html 매매완료 입력 모달
    ↓
POST /api/portfolio/trades
    ↓
trades 테이블 INSERT
    ├── sell_profit / sell_loss: holdings에서 해당 종목 삭제
    ├── buy: holdings에 추가 또는 avg_price 재계산 후 업데이트
    └── switch: sell + buy 2회 API 호출

매일 16:00 closing.js
    └── saveDailySeedGrowth()
          └── trades 테이블 당일 집계 → seed_growth INSERT
```

---

## AI 역할 분담

```
Claude Haiku (저비용 필터, ~$0.6/월)
  └── 입력: 뉴스 title + body[:200]
  └── 출력: relevant, urgency, impact, summary (max 150 tokens)
  └── 조건: 뉴스 수집 시마다

Claude Sonnet (고비용 정밀 분석, ~$1.5~2/월)
  └── 포트폴리오 종합 판단 → 위 JSON 형식
  └── 조건: 이상 감지 시에만
  └── temperature: 0, JSON 강제, 재시도 없음, timeout 60s
```

---

## 매도/매수 판단 원칙

```
전량매도 (부분매도 절대 금지)
  └── 아래 중 2개 이상 동시 충족 시:
      - 주가 -5% 이상 급락
      - 트레일링 스탑 (고점 -7%) 도달
      - 외국인 + 기관 동시 대량 매도
      - DART 실적쇼크/횡령/배임/소송 공시
      - RSI 70 이상 + 거래량 급감

익절 후 판단 (무조건 재투자 금지)
  ├── 재투자: 시장 긍정 + 대체 종목 존재 + 장 마감 1시간 이상 남음 + 나스닥 -1% 이내
  └── 현금 보유: 시장 하락 / 나스닥 -2% 이상 / 금요일 14:00 이후

신규 진입 자제 조건
  - 장 마감 1시간 이내 (14:30 이후)
  - 금요일 14:00 이후
  - 나스닥 선물 -2% 이상
```

---

## 데이터 소스

| 소스 | 용도 | 장애 시 |
|------|------|---------|
| KIS REST API | 현재가, 수급, 기술지표 | 네이버 금융 자동 전환 |
| KIS WebSocket | 실시간 체결/호가 (장중) | 30초 후 자동 재연결 |
| 네이버 뉴스 API | 종목별 뉴스 + 시장 키워드 | 스킵 |
| DART API | 공시 감지 + URGENT_BAD 본문 분석 (fetchDisclosureBody, 5초 타임아웃) | 스킵 |
| RSS (다중 URL fallback) | 글로벌/국내 이슈 | 다음 URL 시도 |
| 네이버 금융 크롤링 | KIS 백업 현재가 | - |
| Yahoo Finance v8 | SOX(반도체지수)·환율 (15분 지연) | null 반환 |

---

## 텔레그램 알림 종류 및 발송 횟수

```
고정 (평일 기준):
  - 08:00 웹 UI 링크           1건
  - 08:30 모닝 리포트           1건
  - 16:00 마감 리포트           1건
  소계: 3건

조건부:
  - 장 중 긴급 알림            최대 10건
  - WebSocket 실시간 알림      목표가/급락/스탑
  - 야간 이슈 알림             최대 2건
  소계: 최대 12건

긴급(urgent=true): 횟수 제한 없음 (급락·목표가·트레일링·DART URGENT_BAD·에러)
일반(urgent=false): 동일 종목+유형 1시간 내 중복 차단
전송 방식: 텔레그램 Bot API (parse_mode HTML, 토큰 갱신 불필요, 분당 30건 실제 제한)

주기적:
  - 일요일 10:00 주간 성과 리포트
  - 매월 마지막 금요일 16:30 월간 리포트
```

---

## 웹 UI 구성

```
/ (대시보드)
  └── 총 자산, 보유 종목 현황, 오늘 AI 액션, Sonnet 사용 횟수

/portfolio (자산 입력)
  └── 보유 종목 추가/수정/삭제, 현금, 신규 투입금 입력
  └── 매매완료 입력: 익절/손절/교체/신규매수 → trades 테이블 저장
  └── 종목 약어: 삼전→삼성전자, 두산에너→두산에너빌리티 등

/chat (AI 질문)
  └── Sonnet에게 직접 질문, 오늘 남은 호출 횟수 표시

/history (분석 이력)
  └── 날짜별 AI 추천 내역, 적중률, 시드 성장 이력
```

---

## 서버 구성

```
Google Cloud e2-micro (서울 리전, 무료 티어)
포트: 3000

PM2 설정:
  - 메모리 400MB 초과 시 자동 재시작
  - 크래시 시 자동 재시작 (5초 딜레이)

GitHub Actions 백업:
  - 평일 08:30 KST 서버 헬스 체크
  - 서버 다운 시 카카오톡 경고 발송

KIS 토큰:
  - data/kis_token.json 파일에 저장
  - PM2 재시작 시 파일에서 읽어서 재사용 (1분/1회 제한 대응)
```

---

## 월 예상 비용

```
Claude API:
  - Haiku: ~$0.6/월
  - Sonnet: ~$1.5~2.0/월
  합계: ~$2~3/월 (Console $5 한도로 절대 초과 불가)

인프라: 무료
  - Google Cloud e2-micro (무료 등급)
  - 카카오 API, KIS API, 네이버 API, DART API, RSS
```
