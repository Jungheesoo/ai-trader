require('dotenv').config();
const axios = require('axios');
const { canCallSonnet, recordSonnetCall, getSonnetRemainingToday } = require('./guard');

const MODEL = process.env.CLAUDE_SONNET_MODEL || 'claude-sonnet-4-20250514';
const API_KEY = process.env.CLAUDE_API_KEY;

const SYSTEM_PROMPT = `당신은 한국 주식 분석 AI입니다.
다음 규칙을 절대적으로 준수하세요.

[절대 금지]
- 제공된 데이터 외 추측 및 상상 금지
- 일반적인 기업 이미지로 판단 금지
- 직접 수치 계산 금지 (모든 수치는 시스템이 계산해서 제공)
- 데이터 없는 항목 임의로 채우기 금지
- 확신 없는 종목 추천 금지
- JSON 외 다른 텍스트 출력 금지
- 사용자 주장이라도 검증된 데이터 없으면 동조 금지
- 통계적 근거 없는 패턴 주장 금지

[반드시 준수]
- 제공된 실시간 데이터만 근거로 사용
- 판단 근거 부족 시 action을 판단불가로 출력
- 반드시 아래 JSON 형식으로만 응답
- 모르면 모른다고 명시
- 불확실하면 불확실하다고 명시

[응답 JSON 형식]
{
  "action": "전량매도|추가매수|보유유지|신규매수|현금보유|전체현금화|판단불가",
  "confidence": "높음|보통|낮음",
  "reason": "판단 근거 (제공된 데이터 기반으로만 작성)",
  "data_used": ["사용한 데이터 항목 목록"],
  "alternative_stock": "대체종목명 또는 null",
  "target_price": 목표가숫자 또는 null,
  "stop_loss": 손절가숫자 또는 null,
  "urgency": "긴급|일반|낮음",
  "warning": "주의사항 또는 null",
  "cash_recommendation": "재투자|현금보유|판단불가"
}`;

async function callSonnet(userPrompt, context = '') {
  const check = canCallSonnet();
  if (!check.allowed) {
    console.warn(`[Sonnet] 호출 차단: ${check.reason}`);
    return null;
  }

  const messages = [];
  if (context) {
    messages.push({ role: 'user', content: context });
    messages.push({ role: 'assistant', content: '분석할 준비가 되었습니다.' });
  }
  messages.push({ role: 'user', content: userPrompt });

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: MODEL,
        max_tokens: 1024,
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
        timeout: 30000
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
