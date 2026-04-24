const { callSonnet } = require('./claude-sonnet');
const { filterNewsBatch } = require('./claude-haiku');
const { getMinutesUntilClose, isFridayAfternoon } = require('./portfolio');

// Sonnet 호출 조건 체크 (12가지)
function shouldCallSonnet(holding, news = []) {
  const reasons = [];

  if (holding.changeRate !== null && Math.abs(holding.changeRate) >= 3) {
    reasons.push(`주가 ${holding.changeRate}% 변동`);
  }
  if (holding.volumeRatio !== null && holding.volumeRatio >= 2) {
    reasons.push(`거래량 ${holding.volumeRatio}배`);
  }
  if (holding.foreignNet !== null && Math.abs(holding.foreignNet) > 100000) {
    reasons.push('외국인 대량 매매');
  }
  if (holding.institutionNet !== null && Math.abs(holding.institutionNet) > 100000) {
    reasons.push('기관 대량 매매');
  }
  if (news.length > 0) {
    reasons.push('영향 뉴스 감지');
  }
  if (holding.trailingStop && holding.current_price <= holding.trailingStop) {
    reasons.push('트레일링 스탑 도달');
  }
  if (holding.rsi !== null && (holding.rsi >= 70 || holding.rsi <= 30)) {
    reasons.push(`RSI ${holding.rsi}`);
  }
  if (holding.macd === '데드크로스' || holding.macd === '골든크로스') {
    reasons.push(`MACD ${holding.macd}`);
  }

  return { should: reasons.length > 0, reasons };
}

function buildSonnetPrompt(enrichedHoldings, assets, relevantNews, watchlist, context) {
  const now = new Date();
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const dayName = dayNames[now.getDay()];
  const minutesLeft = getMinutesUntilClose();
  const isFriday = now.getDay() === 5;
  const isMonday = now.getDay() === 1;

  const holdingsText = enrichedHoldings.map(h => `
종목: ${h.stock_name} (${h.stock_code || '-'})
보유수량: ${h.quantity}주
평단가: ${h.avg_price.toLocaleString()}원
현재가: ${h.current_price.toLocaleString()}원
수익률: ${h.profit_loss_rate}% (${h.profit_loss > 0 ? '+' : ''}${h.profit_loss.toLocaleString()}원)
RSI: ${h.rsi ?? '데이터없음'}
MACD: ${h.macd ?? '데이터없음'}
거래량배수: ${h.volumeRatio ?? '데이터없음'}
외국인순매수: ${h.foreignNet?.toLocaleString() ?? '데이터없음'}
기관순매수: ${h.institutionNet?.toLocaleString() ?? '데이터없음'}
트레일링스탑: ${h.trailingStop?.toLocaleString() ?? '데이터없음'}원`
  ).join('\n---');

  const newsText = relevantNews.length > 0
    ? relevantNews.map(n => `[${n.news.source}] ${n.news.title}\n${n.news.content || n.news.summary}`).join('\n\n')
    : '영향 뉴스 없음';

  const watchlistText = (watchlist || []).slice(0, 10).map(w =>
    `${w.stock_name}: RSI ${w.rsi}, MACD ${w.macd}, 거래량배수 ${w.volume_ratio}`
  ).join('\n');

  return `분석 요청 시각: ${now.toLocaleString('ko-KR')} (${dayName}요일)
장 마감까지: ${minutesLeft}분
${isFriday ? '⚠️ 오늘은 금요일입니다. 주말 리스크 고려 필요.' : ''}
${isMonday ? '⚠️ 오늘은 월요일입니다. 주말 효과 가능성 고려.' : ''}

=== 총 자산 현황 ===
보유주식 평가액: ${assets.stockValue.toLocaleString()}원
현금: ${assets.cash.toLocaleString()}원
신규투입금: ${assets.newInvestment.toLocaleString()}원
총 운용 가능: ${assets.total.toLocaleString()}원

=== 보유 종목 상세 ===
${holdingsText}

=== 관련 뉴스 (Haiku 필터 통과) ===
${newsText}

=== 관심 종목 TOP10 (퀀트 스캔 결과) ===
${watchlistText || '스캔 데이터 없음'}

${context || ''}

위 데이터만을 근거로 분석하세요. 데이터가 없는 항목은 판단불가로 처리하세요.
부분매도 추천 절대 금지. 모든 매도는 전량매도만 추천.
익절 후 재투자 vs 현금 보유 판단: 장 마감까지 ${minutesLeft}분 남음. ${minutesLeft < 60 ? '장 마감 1시간 이내 - 신규 진입 자제.' : ''}
${isFridayAfternoon() ? '금요일 오후 - 신규 진입 자제 권고.' : ''}`;
}

async function analyzePortfolio(enrichedHoldings, assets, allNews, watchlist, context = '') {
  // Haiku 필터링
  const haikuResults = await filterNewsBatch(allNews, enrichedHoldings);
  const relevantNews = haikuResults.filter(r => r.result?.relevant === true);

  // 이상 감지 체크
  let triggerReasons = [];
  for (const h of enrichedHoldings) {
    const { should, reasons } = shouldCallSonnet(h, relevantNews.filter(n =>
      n.news.title?.includes(h.stock_name)
    ));
    if (should) triggerReasons.push(...reasons);
  }
  if (relevantNews.some(n => n.result?.urgency === '긴급')) {
    triggerReasons.push('긴급 뉴스');
  }

  if (triggerReasons.length === 0 && !context) {
    return { triggered: false, relevantNews };
  }

  const prompt = buildSonnetPrompt(enrichedHoldings, assets, relevantNews, watchlist, context);
  const result = await callSonnet(prompt);

  return { triggered: true, triggerReasons, relevantNews, analysis: result };
}

async function runMorningReport(enrichedHoldings, assets, allNews, watchlist) {
  const haikuResults = await filterNewsBatch(allNews.slice(0, 20), enrichedHoldings);
  const relevantNews = haikuResults.filter(r => r.result?.relevant === true);
  const prompt = buildSonnetPrompt(enrichedHoldings, assets, relevantNews, watchlist, '이것은 모닝 리포트입니다. 오늘 하루 전체 전략을 제시하세요.');
  return callSonnet(prompt);
}

async function runClosingReport(enrichedHoldings, assets, allNews) {
  const haikuResults = await filterNewsBatch(allNews.slice(0, 10), enrichedHoldings);
  const relevantNews = haikuResults.filter(r => r.result?.relevant === true);
  const prompt = buildSonnetPrompt(enrichedHoldings, assets, relevantNews, [], '이것은 마감 리포트입니다. 오늘 결산 및 내일 전략을 제시하세요.');
  return callSonnet(prompt);
}

async function runFridayCheck(enrichedHoldings, assets) {
  const prompt = buildSonnetPrompt(enrichedHoldings, assets, [], [], '금요일 오후 1시 30분 주말 특별 점검입니다. 주말 리스크와 다음 주 월요일 전략을 판단하세요.');
  return callSonnet(prompt);
}

async function runMondayCheck(enrichedHoldings, assets, news) {
  const prompt = buildSonnetPrompt(enrichedHoldings, assets, news, [], '월요일 오전 주말 효과 판단입니다. 24년 KOSPI 통계상 월요일 약세 가능성과 주말 악재 여부를 확인하세요.');
  return callSonnet(prompt);
}

module.exports = {
  analyzePortfolio,
  runMorningReport,
  runClosingReport,
  runFridayCheck,
  runMondayCheck,
  shouldCallSonnet
};
