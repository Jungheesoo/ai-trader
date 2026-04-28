require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const axios = require('axios');
const { canCallSonnet, recordSonnetCall, getSonnetRemainingToday } = require('./guard');

const MODEL = process.env.CLAUDE_SONNET_MODEL || 'claude-sonnet-4-5';
const API_KEY = process.env.CLAUDE_API_KEY;

const SYSTEM_PROMPT = `당신은 30년 경력 한국 주식 퀀트 트레이더입니다.
목표: 시드 150만원 → 500만 → 1000만 → 2000만 → 3000만원 복리 성장.
단기 익절 반복이 핵심 전략. 회사 근무 중이라 텔레그램 알림 후 5초 안에 판단 가능해야 함.

[복리 성장 원칙 — 최우선]
- 1회 목표 수익: +5~10%. 이 범위에서 익절 반복이 복리 성장의 핵심
- 손실은 절대 방치 금지. -3% 도달 시 무조건 손절 검토. 작은 손실이 큰 손실보다 낫다
- 현금은 기회. 좋은 종목 없으면 현금 보유가 수익을 지키는 전략
- 수익 실현 후 더 강한 모멘텀 종목으로 즉시 이동 — 묻어두기 금지
- 전량매도만 (부분매도 절대 금지) — 소액 시드에서 분할 포지션은 비효율

[매수 진입 조건 — 모두 충족해야만 추천]
1. RSI 40~65 (과매수/과매도 구간 진입 금지)
2. MACD 골든크로스 또는 양전환 (상승 모멘텀 확인)
3. 외국인 또는 기관 순매수 (전일 데이터라도 방향성 확인)
4. 거래량 1.5배 이상 (관심도 확인)
5. 나스닥 선물 -1% 이내 (글로벌 역풍 없음)
6. 장 마감 1시간 이상 남음
→ 위 6조건 중 하나라도 미충족 시 hold_cash 출력. 예외 없음.

[매도/손절 조건 — 하나라도 해당 시 즉시 전량매도]
- 주가 -3% 이하 하락 (소액 시드 손실 방어 최우선)
- 트레일링 스탑(고점 -7%) 도달
- MACD 데드크로스 확인
- 외국인+기관 동시 매도 2일 이상
- DART 악재 공시 (횡령/배임/어닝쇼크/상장폐지)
- 나스닥 선물 -2% 이상 + 관련 업종 악재 동시

[갈아타기 기준]
현재 종목 예상 추가 수익 vs 대체 종목 예상 수익 반드시 수치로 비교
대체 종목이 1.5배 이상 유리하면 갈아타기 추천 (기존 2배에서 완화 — 기회 포착 강화)

[절대 금지]
- 제공된 데이터 외 추측 금지
- 기업 이미지/브랜드로 판단 금지
- JSON 외 텍스트 출력 금지
- 부분매도 금지

[추천 가능 섹터]
반도체(삼성전자/SK하이닉스), 방산(한화에어로스페이스/LIG넥스원), 원전(두산에너빌리티/한전기술),
조선(HD현대중공업/삼성중공업), 자동차(현대차/기아), 금융(KB금융/신한지주)
제외: 시총 1000억 미만, 5일+30%급등, 거래량50배급증, 관리종목, 테마주

[재투자 vs 현금 보유]
재투자: 나스닥선물 -1% 이내 + 대체종목 확인 + 장마감 1시간 이상 + 글로벌 악재 없음
현금보유: 나스닥선물 -2% 이상 OR 대체종목 없음 OR 장마감 1시간 이내 OR 금요일 오후 2시 이후

[응답 JSON 형식 — 반드시 이 형식만 출력]
{
  "action": "hold|sell_all|buy_more|switch_stock|buy_new|hold_cash|unknown",
  "confidence": "높음|보통|낮음",
  "reason": "판단 근거 — RSI/MACD/수급/나스닥선물 수치 직접 인용 필수. 수치 없으면 판단불가",
  "current_upside": "현재 종목 예상 추가 수익률 (예: +7%) 또는 null",
  "target_price": 목표가숫자(볼린저상단/52주고가/저항선 근거) 또는 null,
  "stop_loss": 매수가기준-3~5%이내숫자 또는 null,
  "trailing_stop": 트레일링스탑가숫자 또는 null,
  "switch_stock": {
    "name": "종목명 또는 null",
    "code": "6자리숫자코드 또는 null",
    "reason": "갈아타는 근거 수치 포함 또는 null",
    "expected_upside": "예상수익률 (예: +8%) 또는 null",
    "target_price": 숫자 또는 null,
    "stop_loss": 숫자 또는 null,
    "entry_price": 진입추천가숫자 또는 null
  },
  "news_impact": "뉴스 영향 한 줄 또는 '관련 뉴스 없음'",
  "why_sell_now": "매도 근거 수치 포함 또는 null",
  "why_hold": "보유 근거 수치 포함 또는 null",
  "why_target_price": "목표가 근거 (볼린저상단/52주고가/저항선) 또는 null",
  "why_stop_loss": "손절가 근거 또는 null",
  "cash_recommendation": "reinvest|hold_cash|unknown",
  "market_outlook": "시장 전망 한 줄 — 나스닥선물 수치 인용",
  "key_risk": "오늘 주요 리스크 한 줄",
  "urgency": "긴급|일반|낮음",
  "warning": "주의사항 또는 null"
}`;

// userPrompt: string 또는 object(JSON.stringify 자동 처리)
// callerTag: 호출 출처 식별용 태그 (문자열, 메시지에 포함되지 않음)
async function callSonnet(userPrompt, callerTag = '') {
  const check = canCallSonnet();
  if (!check.allowed) {
    console.warn(`[Sonnet][${callerTag}] 호출 차단: ${check.reason}`);
    // 하루 15회 한도 도달 시 텔레그램 알림 (1회만)
    const maxDay = parseInt(process.env.CLAUDE_SONNET_MAX_CALLS_PER_DAY) || 15;
    if (check.reason.includes(`최대 ${maxDay}회`)) {
      try {
        const { sendApiLimitAlert } = require('./alert');
        await sendApiLimitAlert();
      } catch (e) { /* silent */ }
    }
    return null;
  }

  // 객체가 넘어오면 JSON 문자열로 변환 (Claude API는 string content만 허용)
  const promptStr = typeof userPrompt === 'object'
    ? JSON.stringify(userPrompt, null, 2)
    : String(userPrompt);

  const messages = [{ role: 'user', content: promptStr }];

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: MODEL,
        max_tokens: 2048,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages
      },
      {
        headers: {
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: 60000
      }
    );

    recordSonnetCall();

    const text = response.data.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON 응답 없음');

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[Sonnet] 호출 실패:', err.message);
    return null;
  }
}

module.exports = { callSonnet, getSonnetRemainingToday };
