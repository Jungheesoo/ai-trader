require('dotenv').config();
const axios = require('axios');
const { recordHaikuCall } = require('./guard');

const MODEL = process.env.CLAUDE_HAIKU_MODEL || 'claude-haiku-20240307';
const API_KEY = process.env.CLAUDE_API_KEY;

const SYSTEM_PROMPT = `당신은 뉴스 영향도 분류 AI입니다.
제공된 뉴스가 보유 종목에 영향을 주는지 판단하세요.
키워드 방식이 아닌 문맥 전체를 읽고 판단하세요.
JSON 외 다른 텍스트 출력 금지.
데이터 없이 추측 금지.

[응답 JSON 형식]
{
  "relevant": true 또는 false,
  "urgency": "긴급|주의|정보",
  "impact": "긍정|부정|중립",
  "reason": "판단 근거 한 줄 (데이터 기반)"
}`;

async function filterNews(newsText, holdings) {
  const holdingNames = holdings.map(h => h.stock_name).join(', ');
  const prompt = `보유 종목: ${holdingNames}\n\n뉴스 내용:\n${newsText}`;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: MODEL,
        max_tokens: 256,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: 15000
      }
    );

    recordHaikuCall();

    const text = response.data.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON 응답 없음');

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[Haiku] 호출 실패:', err.message);
    return null;
  }
}

async function filterNewsBatch(newsList, holdings) {
  const results = [];
  for (const news of newsList) {
    const text = news.content || news.summary || news.title || '';
    const source = news.content ? '본문' : '요약본';
    const result = await filterNews(`[${source}]\n${text}`, holdings);
    results.push({ news, result });
  }
  return results;
}

module.exports = { filterNews, filterNewsBatch };
