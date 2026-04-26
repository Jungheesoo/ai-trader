require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const axios = require('axios');
const { recordHaikuCall } = require('./guard');

const MODEL = process.env.CLAUDE_HAIKU_MODEL || 'claude-haiku-4-5-20251001';
const API_KEY = process.env.CLAUDE_API_KEY;

// 글로벌 거시 이슈 — 보유 종목 무관하게 항상 통과시킬 키워드
const MACRO_KEYWORDS = [
  'Trump', '트럼프', 'tariff', '관세', 'Fed', '연준', 'interest rate', '금리',
  'NASDAQ', '나스닥', 'S&P', 'Dow', '다우', '미국증시', '뉴욕증시',
  'KOSPI', '코스피', '코스닥', '외국인', '기관',
  '반도체', 'semiconductor', '방산', 'defense', '원전', 'nuclear',
  '환율', 'dollar', '달러', '엔화', '위안화',
  '경기침체', 'recession', '인플레이션', 'inflation', '고용지표',
  '중국', 'China', '대만', 'Taiwan', '러시아', '우크라이나',
  '수주', '계약', '공급망', 'supply chain'
];

function isMacroNews(text) {
  const lower = text.toLowerCase();
  return MACRO_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

const SYSTEM_PROMPT = `당신은 한국 주식 투자를 위한 뉴스 영향도 분류 AI입니다.
키워드 방식이 아닌 문맥 전체를 읽고 판단하세요.
JSON 외 다른 텍스트 출력 금지.

[판단 기준 — relevant: true로 분류할 조건]
다음 중 하나라도 해당하면 반드시 relevant: true로 분류:
1. 보유 종목에 직접 영향 (실적, 수주, 인사, 악재 등)
2. 보유 종목이 속한 섹터 전체에 영향 (반도체, 방산, 원전, 자동차 등)
3. 신규 진입 가능한 한국 주요 종목에 영향
4. 트럼프 발언/정책 (관세, 무역, 외교 — 한국 수출 기업에 간접 영향)
5. 미국 시장(나스닥/S&P500/Fed) 동향 — 한국 시장 전반에 영향
6. 환율(달러/원) 변동 — 수출 기업 수익에 직접 영향
7. 중국 경제/정책 — 한국 반도체·배터리·소재 수요에 영향
8. 글로벌 공급망 이슈 (반도체 부족, 원자재 가격 등)

[relevant: false로 분류할 조건]
- 한국 주식시장과 완전히 무관한 해외 내정 뉴스
- 부동산, 암호화폐, 국내 정치(선거/인사) 단순 뉴스
- 연예·스포츠·사건·사고

[candidate_stocks 필드]
뉴스가 긍정적 영향을 줄 수 있는 한국 종목명을 최대 3개 명시.
(예: 수주 뉴스 → 해당 건설사, 트럼프 방산 증액 → 한화에어로스페이스, LIG넥스원)
없으면 빈 배열.

[응답 JSON 형식]
{
  "relevant": true 또는 false,
  "urgency": "긴급|주의|정보",
  "impact": "긍정|부정|중립",
  "reason": "판단 근거 한 줄 — 어떤 섹터/종목에 왜 영향을 주는지 명시",
  "affected_sectors": ["반도체", "방산"] 또는 [],
  "candidate_stocks": ["종목명1", "종목명2"] 또는 []
}`;

async function filterNews(newsText, holdings, watchlistNames = []) {
  const holdingNames = holdings.map(h => h.stock_name).join(', ');
  const watchlistStr = watchlistNames.length > 0 ? `\n관심 후보 종목: ${watchlistNames.join(', ')}` : '';
  const prompt = `보유 종목: ${holdingNames}${watchlistStr}\n\n뉴스 내용:\n${newsText}`;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: MODEL,
        max_tokens: 300,
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

// 반환: [{...newsFields, relevant, urgency, impact, reason, affected_sectors, candidate_stocks}, ...]
// watchlistNames: watchlist 상위 종목명 배열 — Haiku가 후보 종목 뉴스도 포착하도록
async function filterNewsBatch(newsList, holdings, watchlistNames = []) {
  const results = [];
  for (const news of newsList) {
    const text = news.content || news.summary || news.title || '';
    const titleAndText = `${news.title || ''}\n${text}`;

    // 글로벌 거시 키워드 포함 뉴스는 Haiku 판단 없이 즉시 통과 (비용 절감 + 누락 방지)
    if (isMacroNews(titleAndText)) {
      results.push({
        ...news,
        relevant: true,
        urgency: '정보',
        impact: '중립',
        reason: '글로벌 거시 이슈 — 자동 통과',
        affected_sectors: [],
        candidate_stocks: [],
        isMacro: true,
        news,
        result: null
      });
      continue;
    }

    const source = news.content ? '본문' : '요약본';
    const result = await filterNews(`[${source}]\n${titleAndText}`, holdings, watchlistNames);
    results.push({
      ...news,
      relevant: result?.relevant ?? false,
      urgency: result?.urgency ?? '정보',
      impact: result?.impact ?? '중립',
      reason: result?.reason ?? '',
      affected_sectors: result?.affected_sectors ?? [],
      candidate_stocks: result?.candidate_stocks ?? [],
      isMacro: false,
      news,
      result
    });
  }
  return results;
}

module.exports = { filterNews, filterNewsBatch, isMacroNews };
