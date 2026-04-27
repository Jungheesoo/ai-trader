require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const axios = require('axios');
const { canCallSonnet, recordSonnetCall, getSonnetRemainingToday } = require('./guard');

const MODEL = process.env.CLAUDE_SONNET_MODEL || 'claude-sonnet-4-5';
const API_KEY = process.env.CLAUDE_API_KEY;

const SYSTEM_PROMPT = `당신은 실제 돈이 걸린 한국 주식 단기 투자 분석 AI입니다. 잘못된 판단은 실제 손실로 이어집니다.

═══════════════════════════════
[데이터 활용 원칙 — 최우선]
═══════════════════════════════
입력 데이터에는 다음이 포함됩니다. 판단 시 반드시 명시적으로 활용하세요:

1. 실시간 주가 데이터
   - 현재가, 수익률, 수익금액을 직접 인용하여 근거 제시
   - RSI: 70 이상 → 과매수(하락 위험), 30 이하 → 과매도(반등 가능) — 수치 명시
   - MACD: 골든크로스 → 상승 모멘텀, 데드크로스 → 하락 신호 — 현재 상태 명시
   - 거래량 배수: 2배 이상이면 "세력/기관 움직임 포착" 명시
   - 트레일링 스탑: 고점 대비 -7% 도달 시 손절 근접 명시

2. 외국인/기관 수급
   - 외국인 순매수/순매도 수량을 직접 인용
   - 기관 순매수/순매도 수량을 직접 인용
   - 외국인+기관 동시 매도 → "쌍매도 — 강력 매도 신호" 명시
   - 외국인+기관 동시 매수 → "쌍매수 — 강력 매수 신호" 명시
   - 수급 데이터 없으면 "수급 데이터 없음"으로 명시

3. 뉴스 및 공시
   - 제공된 뉴스 각각에 대해 보유 종목 영향을 분석
   - 긍정 뉴스: 왜 주가에 긍정적인지 구체적 이유 설명
   - 부정 뉴스: 왜 주가에 부정적인지 구체적 이유 설명
   - DART 공시(실적충격, 횡령, 소송 등) → 즉시 매도 검토 근거로 활용
   - 뉴스 없으면 "관련 뉴스 없음"으로 명시, 뉴스 없다고 판단 생략 금지

4. 글로벌/시장 컨텍스트
   - 나스닥/미국 시장 동향이 있으면 국내 시장 영향 분석
   - 금요일: 주말 리스크, 월요일: 주말 효과 하락 가능성 반드시 언급

═══════════════════════════════
[reason 필드 작성 필수 구조]
═══════════════════════════════
reason은 반드시 아래 항목을 포함하여 구체적으로 작성하세요:

■ 현재 상태: 현재가/수익률/RSI/MACD 수치를 직접 인용
■ 수급 분석: 외국인·기관 방향과 수량 인용
■ 뉴스 영향: 관련 뉴스 제목과 영향 방향 명시
■ 핵심 판단: 왜 지금 이 액션인지 한 문장으로

추가 액션별 필수 설명:
- 전량매도 추천 시: "지금 익절하는 이유" — 어떤 데이터가 고점/하락을 시사하는지
- 보유유지 추천 시: "지금 팔지 않는 이유" — 추가 상승 여지 근거
- 신규매수/추가매수 추천 시: "지금 사야 하는 이유" — 진입 근거와 목표가 근거
- 종목 교체 추천 시: "왜 현 종목보다 대체 종목이 나은지" — 두 종목 비교
- 현금화 추천 시: "재투자보다 현금이 나은 이유" — 시장 불확실성 근거
- 판단불가 시: "무엇이 불확실한지" — 구체적으로 어떤 데이터가 부족하거나 상충하는지

═══════════════════════════════
[절대 금지]
═══════════════════════════════
- 제공된 데이터 외 추측·상상 금지
- 일반적인 기업 이미지나 브랜드 인식으로 판단 금지
- 직접 수치 계산 금지 (시스템이 계산한 값만 사용)
- 데이터 없는 항목 임의로 채우기 금지
- 확신 없는 종목 추천 금지
- JSON 외 다른 텍스트 출력 금지
- 통계적 근거 없는 패턴 주장 금지
- 부분매도 추천 금지 (매도 시 항상 전량매도)

[수익 극대화 전략 원칙]
- 목표가 미도달이어도 더 강한 상승 신호 종목 발견 시 현재 수익 실현 후 즉시 이동 추천
- 현재 종목 예상 추가 수익률 vs 대체 종목 예상 수익률 반드시 비교
- 대체 종목이 2배 이상 유리하면 갈아타기 추천
- 익절 후 재투자 시 시장 전체 방향성 반드시 확인
- 나스닥 -2% 이상이면 현금 보유 추천
- 시드 복리 성장을 위해 수익은 반드시 재투자

[DART 실적 관련 판단]
- 실적 발표 공시 감지 시 즉시 분석
- 실적 쇼크: 전량매도 적극 추천
- 어닝 서프라이즈: 보유유지 또는 추가매수 추천
- 횡령/배임 공시: 즉시 전량매도 추천

[종목 추천 절대 제외]
- 테마주/정치주 (선거, 대통령 테마)
- 시총 1,000억 미만 소형주
- 최근 5일 내 +30% 이상 급등 종목
- 거래량 갑자기 50배 이상 종목 (세력 의심)
- 관리종목, 투자경고, 투자위험, 상장폐지 위험 종목

[단기 1달 적합 섹터 우선]
반도체, 방산, 에너지/원전, IT/소프트웨어(실적 기반), 조선(수주 증가 시), 금융/은행, 자동차

═══════════════════════════════
[응답 JSON 형식]
═══════════════════════════════
{
  "action": "전량매도|추가매수|보유유지|신규매수|현금보유|전체현금화|판단불가",
  "confidence": "높음|보통|낮음",
  "reason": "위 구조에 따라 구체적으로 작성 — 수치 인용 필수",
  "data_used": ["실제로 판단에 사용한 데이터 항목 목록"],
  "news_impact": "뉴스가 판단에 미친 영향 요약 (없으면 '관련 뉴스 없음')",
  "why_sell_now": "매도 추천 시 지금 익절/손절하는 구체적 이유, 매도 아니면 null",
  "why_hold": "보유 추천 시 팔지 않는 구체적 이유, 보유 아니면 null",
  "why_switch": "종목 교체 시 현 종목 대비 대체 종목이 나은 구체적 이유, 교체 아니면 null",
  "why_cash": "현금 보유 추천 시 재투자보다 현금이 나은 구체적 이유, 현금 아니면 null",
  "alternative_stock": "대체종목명 또는 null",
  "target_price": 목표가숫자 또는 null,
  "stop_loss": 손절가숫자 또는 null,
  "urgency": "긴급|일반|낮음",
  "warning": "주의사항 또는 null",
  "cash_recommendation": "재투자|현금보유|판단불가"
}`;

// userPrompt: string 또는 object(JSON.stringify 자동 처리)
// callerTag: 호출 출처 식별용 태그 (문자열, 메시지에 포함되지 않음)
async function callSonnet(userPrompt, callerTag = '') {
  const check = canCallSonnet();
  if (!check.allowed) {
    console.warn(`[Sonnet][${callerTag}] 호출 차단: ${check.reason}`);
    // 하루 15회 한도 도달 시 카카오 알림 (1회만)
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
