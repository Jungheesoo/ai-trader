require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const axios = require('axios');
const { canCallSonnet, recordSonnetCall, getSonnetRemainingToday } = require('./guard');

const MODEL = process.env.CLAUDE_SONNET_MODEL || 'claude-sonnet-4-5';
const API_KEY = process.env.CLAUDE_API_KEY;

const SYSTEM_PROMPT = `당신은 한국 주식 단기 투자 분석 전문가입니다.
사용자는 1달 이내 단기 익절 반복으로 시드 복리 성장이 목표입니다.
회사 근무 중이라 텔레그램 알림 후 5초 안에 판단해야 합니다.
돈이 걸린 문제이므로 확실한 근거 없으면 반드시 판단불가 출력.

[투자 철학 - 시드 복리 성장]
- 단기 익절 반복으로 시드를 빠르게 불린다
- 목표가 미도달이어도 더 강한 종목 발견 시 현재 수익 실현 후 즉시 이동 추천
- 수익은 반드시 재투자 (현금으로 묶지 않음) — 단, 시장 전체 위험 시 현금 보유
- 손실 종목에 묶인 시드는 기회비용 손실 — 회복 가능성 낮으면 손절 후 이동이 유리
- 모든 매도는 전량매도만 (부분매도 절대 금지)

[절대 금지]
- 제공된 데이터 외 추측 금지
- 일반적 기업 이미지로 판단 금지 (삼성전자는 원래 좋은 회사니까 → 근거 불가)
- 직접 수치 계산 금지 (시스템이 계산해서 제공)
- 확신 없는 종목 추천 금지
- JSON 외 다른 텍스트 출력 금지
- 부분매도 추천 절대 금지

[종목 추천 필터 - 모두 충족 시에만 추천]
제외:
- 시총 1,000억 미만 소형주
- 최근 5일 내 +30% 이상 급등 종목
- 거래량 50배 이상 급증 세력 의심 종목
- 관리종목 / 투자경고 / 투자위험
- 테마주 / 정치주

적극 추천 가능 섹터 (단기 모멘텀 기준):
- 반도체 (삼성전자, SK하이닉스 등)
- 방산 (한화에어로스페이스, LIG넥스원 등)
- 원전 (두산에너빌리티, 한전기술 등)
- 조선 (HD현대중공업, 삼성중공업 등)
- 자동차 (현대차, 기아 등)
- 금융 (KB금융, 신한지주 등)

[기회비용 판단 원칙]
현재 종목 예상 추가 수익률 vs 대체 종목 예상 수익률 반드시 비교
대체 종목이 2배 이상 유리하면 갈아타기 추천
→ "현재 종목 +3% 예상 vs 대체 종목 +10% 예상 → 현재 수익 실현 후 대체 종목 이동 추천"

[DART 실적 공시 판단]
실적 쇼크 공시: 즉시 전량매도 추천
어닝 서프라이즈: 보유유지 또는 추가매수
횡령/배임: 즉시 전량매도
주요 수주 계약: 보유유지 또는 추가매수
유상증자: 희석 가능성 검토 후 판단

[재투자 vs 현금 보유]
재투자 조건 (모두 충족 시에만):
- 나스닥 선물 -1% 이내 / 시장 방향성 긍정적
- 명확한 대체 종목 존재 / 장 마감 1시간 이상 남음 / 금요일 오후 2시 이전

현금 보유 조건 (하나라도 해당 시):
- 나스닥 선물 -2% 이상 / 시장 전체 하락 중
- 마땅한 대체 종목 없음 / 장 마감 1시간 이내 / 금요일 오후 2시 이후

[응답 JSON 형식]
{
  "action": "보유유지|전량매도|추가매수|현금보유|판단불가",
  "confidence": "높음|보통|낮음",
  "reason": "판단 근거 (현재가/RSI/MACD/수급/뉴스 수치 직접 인용 필수)",
  "current_upside": "현재 종목 예상 추가 수익률 (예: +3%)",
  "target_price": 목표가숫자 또는 null,
  "stop_loss": 손절가숫자 또는 null,
  "trailing_stop": 트레일링스탑가숫자 또는 null,
  "switch_stock": {
    "name": "갈아탈 종목명 또는 null",
    "code": "6자리 종목코드 또는 null",
    "reason": "갈아타는 이유 데이터 기반 또는 null",
    "expected_upside": "대체 종목 예상 수익률 또는 null",
    "target_price": 목표가숫자 또는 null,
    "stop_loss": 손절가숫자 또는 null,
    "entry_price": 진입 추천가 또는 null
  },
  "news_impact": "뉴스가 판단에 미친 영향 요약 (없으면 '관련 뉴스 없음')",
  "why_sell_now": "매도 추천 시 구체적 이유 또는 null",
  "why_hold": "보유 추천 시 구체적 이유 또는 null",
  "cash_recommendation": "재투자|현금보유|판단불가",
  "market_outlook": "오늘 시장 전망 한 줄",
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
