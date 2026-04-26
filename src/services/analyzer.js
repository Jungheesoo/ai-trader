const { callSonnet } = require('./claude-sonnet');
const { filterNewsBatch } = require('./claude-haiku');
const { getMinutesUntilClose, isFridayAfternoon, isOneHourBeforeClose } = require('./portfolio');
const axios = require('axios');
const cheerio = require('cheerio');

async function fetchUsMarketStatus() {
  try {
    const indices = [
      { name: 'NASDAQ', url: 'https://www.google.com/finance/quote/.IXIC:INDEXNASDAQ' },
      { name: 'S&P500', url: 'https://www.google.com/finance/quote/.INX:INDEXSP' },
      { name: '다우', url: 'https://www.google.com/finance/quote/.DJI:INDEXDJX' }
    ];
    const results = [];
    for (const idx of indices) {
      try {
        const res = await axios.get(idx.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
          timeout: 8000
        });
        const $ = cheerio.load(res.data);
        const changeText = $('[jsname="Fe7oBc"]').first().attr('aria-label') || '';
        const numMatch = changeText.match(/(\d+\.?\d*)\s*%/);
        const isDown = /down/i.test(changeText);
        const changeRate = numMatch ? parseFloat(numMatch[1]) * (isDown ? -1 : 1) : null;
        results.push({ name: idx.name, changeRate });
      } catch {
        results.push({ name: idx.name, changeRate: null });
      }
    }
    return results;
  } catch {
    return [];
  }
}

// Sonnet 호출 조건 체크 (프롬프트 섹션 12 전체 반영)
function shouldCallSonnet(holding, news = [], watchlistCandidate = null) {
  const reasons = [];

  // 1. 주가 ±3% 이상 변동
  if (holding.changeRate !== null && Math.abs(holding.changeRate) >= 3) {
    reasons.push(`주가 ${holding.changeRate}% 변동`);
  }
  // 2. 거래량 평소 대비 2배 이상
  if (holding.volumeRatio !== null && holding.volumeRatio >= 2) {
    reasons.push(`거래량 ${holding.volumeRatio}배`);
  }
  // 3. 외국인 대량 매도/매수
  if (holding.foreignNet !== null && Math.abs(holding.foreignNet) > 100000) {
    reasons.push('외국인 대량 매매');
  }
  // 4. 기관 대량 매도/매수
  if (holding.institutionNet !== null && Math.abs(holding.institutionNet) > 100000) {
    reasons.push('기관 대량 매매');
  }
  // 5. Haiku yes 뉴스
  if (news.length > 0) {
    reasons.push('영향 뉴스 감지');
  }
  // 6. 트레일링 스탑 도달 (고점 -7%)
  if (holding.trailingStop && holding.current_price <= holding.trailingStop) {
    reasons.push('트레일링 스탑 도달');
  }
  // 7. 목표가 도달
  if (holding.target_price && holding.current_price >= holding.target_price) {
    reasons.push('목표가 도달');
  }
  // 8. RSI 70 이상 또는 30 이하
  if (holding.rsi !== null && (holding.rsi >= 70 || holding.rsi <= 30)) {
    reasons.push(`RSI ${holding.rsi}`);
  }
  // 9. MACD 데드크로스 또는 골든크로스
  if (holding.macd === '데드크로스' || holding.macd === '골든크로스') {
    reasons.push(`MACD ${holding.macd}`);
  }
  // 10. 기회비용 계산 - 대체 종목이 현재 종목보다 2배 이상 유리
  if (watchlistCandidate && holding.current_price && holding.avg_price) {
    const currentUpside = holding.target_price
      ? ((holding.target_price - holding.current_price) / holding.current_price) * 100
      : null;
    const candidateUpside = watchlistCandidate.target_price
      ? ((watchlistCandidate.target_price - watchlistCandidate.current_price) / watchlistCandidate.current_price) * 100
      : null;
    if (currentUpside !== null && candidateUpside !== null && candidateUpside >= currentUpside * 2) {
      reasons.push(`기회비용: ${watchlistCandidate.stock_name} 대체 유리 (${candidateUpside.toFixed(1)}% vs ${currentUpside.toFixed(1)}%)`);
    }
  }

  return { should: reasons.length > 0, reasons };
}

function buildSonnetPrompt(enrichedHoldings, assets, relevantNews, watchlist, context, dartDisclosures = [], usMarket = [], candidateStocks = []) {
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
외국인순매수: ${h.foreignNet?.toLocaleString() ?? '데이터없음'}주
기관순매수: ${h.institutionNet?.toLocaleString() ?? '데이터없음'}주
트레일링스탑: ${h.trailingStop?.toLocaleString() ?? '데이터없음'}원`
  ).join('\n---');

  const usMarketText = usMarket.length > 0
    ? usMarket.map(m => `${m.name}: ${m.changeRate !== null ? (m.changeRate >= 0 ? '+' : '') + m.changeRate + '%' : '데이터없음'}`).join(' / ')
    : '데이터없음 (크롤링 실패)';

  const newsText = relevantNews.length > 0
    ? relevantNews.map(n =>
        `[${n.source || n.news?.source}] ${n.title || n.news?.title} (영향:${n.impact || '중립'}, 긴급도:${n.urgency || '정보'})\n${(n.content || n.summary || n.news?.content || n.news?.summary || '').slice(0, 300)}`
      ).join('\n\n')
    : '영향 뉴스 없음';

  // DART 공시 텍스트
  const dartText = dartDisclosures.length > 0
    ? dartDisclosures.map(d =>
        `${d.icon} [${d.stockName}] ${d.title} (${d.date}) — 영향: ${d.impact}\n공시URL: ${d.url}`
      ).join('\n')
    : '신규 공시 없음';

  // 관심 종목 vs 보유 종목 비교 텍스트
  const watchlistText = (watchlist || []).slice(0, 10).map(w =>
    `${w.stock_name}: RSI ${w.rsi}, MACD ${w.macd}, 거래량배수 ${w.volume_ratio}`
  ).join('\n');

  // Haiku가 뉴스에서 포착한 신규 진입 후보 종목
  const candidateText = candidateStocks.length > 0
    ? candidateStocks.join(', ')
    : '없음';

  return `분석 요청 시각: ${now.toLocaleString('ko-KR')} (${dayName}요일)
장 마감까지: ${minutesLeft}분
미국증시 실시간: ${usMarketText}
${isFriday ? '⚠️ 오늘은 금요일입니다. 주말 리스크 고려 필요.' : ''}
${isMonday ? '⚠️ 오늘은 월요일입니다. 주말 효과 가능성 고려.' : ''}

=== 총 자산 현황 ===
보유주식 평가액: ${assets.stockValue.toLocaleString()}원
현금: ${assets.cash.toLocaleString()}원
신규투입금: ${assets.newInvestment.toLocaleString()}원
총 운용 가능: ${assets.total.toLocaleString()}원

=== 보유 종목 상세 ===
${holdingsText}

=== DART 신규 공시 (오늘) ===
${dartText}

=== 관련 뉴스 (Haiku 필터 통과, 최대 15건) ===
${newsText}

=== 뉴스 기반 신규 진입 후보 (Haiku 포착) ===
${candidateText}

=== 관심 종목 TOP10 (퀀트 스캔) — 보유 종목 교체 여부 직접 판단 ===
${watchlistText || '스캔 데이터 없음'}
※ 보유 종목 현재 상태와 위 후보 종목들을 직접 비교하여, 갈아타기가 유리한지 명시적으로 판단하라.

${context || ''}

위 데이터만을 근거로 분석하세요. 데이터가 없는 항목은 판단불가로 처리하세요.
부분매도 절대 금지. 모든 매도는 전량매도만 추천.

[DART 공시 판단 기준]
- 🚨 긴급(악재): 즉시 매도 검토 필수 근거로 활용
- ✅ 호재(수주/계약): 보유 유지 또는 추가매수 근거로 활용
- 📊 실적발표: 내용 해석 후 긍/부 판단 (수치 없으면 판단불가)

[전량매도 권고 조건 - 아래 중 2개 이상 동시 충족 시]
- 주가 -5% 이상 급락
- 트레일링 스탑(고점 -7%) 도달
- 외국인 + 기관 동시 대량 매도
- DART 악재 공시 (횡령/배임/소송/어닝쇼크)
- 동일 악재 3개 이상 매체 동시 보도
- 미국 증시 -3% 이상 + 관련 업종 악재 동시
- RSI 70 이상 + 거래량 급감 동시

[익절 후 재투자 vs 현금 보유 판단 기준]
장 마감까지: ${minutesLeft}분
${isOneHourBeforeClose() ? '⚠️ 장 마감 1시간 이내(14:30 이후) - 신규 진입 자제. cash_recommendation을 현금보유로 설정.' : ''}
${isFridayAfternoon() ? '⚠️ 금요일 오후 14:00 이후 - 신규 진입 자제. cash_recommendation을 현금보유로 설정.' : ''}
${isFriday && !isFridayAfternoon() ? '오늘 금요일: 오후 2시 이후 신규 진입 자제 예정.' : ''}
${isMonday ? '오늘 월요일: 주말 효과 하락 가능. 급락 시 악재 없으면 매수 기회로 판단.' : ''}

재투자 허용 조건 (모두 충족 시에만): 시장 방향성 긍정, 명확한 대체 종목 존재, 장 마감 1시간 이상 남음, 글로벌 악재 없음
현금 보유 조건 (하나라도 해당 시): 시장 하락 중, 마땅한 대체 종목 없음, 장 마감 1시간 이내, 주말 효과 우려`;
}

async function analyzePortfolio(enrichedHoldings, assets, allNews, watchlist, context = '', dartDisclosures = []) {
  // Haiku 비용 제어: 장 중 최대 30건, 긴급 공시 있으면 우선 처리
  const MAX_HAIKU_NEWS = 30;
  const newsToFilter = allNews.slice(0, MAX_HAIKU_NEWS);
  console.log(`[Haiku] 뉴스 필터링 ${newsToFilter.length}건 (전체 ${allNews.length}건 중)`);

  // watchlist 종목명 → Haiku에 전달해 보유 외 종목 뉴스도 포착
  const watchlistNames = (watchlist || []).slice(0, 10).map(w => w.stock_name).filter(Boolean);

  const haikuResults = await filterNewsBatch(newsToFilter, enrichedHoldings, watchlistNames);
  const relevantNews = haikuResults.filter(n => n.relevant === true);

  // Haiku가 포착한 신규 진입 후보 종목 — 중복 제거
  const candidateStocks = [...new Set(
    haikuResults.flatMap(n => n.candidate_stocks || []).filter(Boolean)
  )];

  // 이상 감지 체크 (퀀트 + 뉴스)
  let triggerReasons = [];
  for (const h of enrichedHoldings) {
    const holdingNews = relevantNews.filter(n =>
      (n.title || '').includes(h.stock_name)
    );
    const { should, reasons } = shouldCallSonnet(h, holdingNews);
    if (should) triggerReasons.push(...reasons);
  }
  if (relevantNews.some(n => n.urgency === '긴급')) triggerReasons.push('긴급 뉴스');

  // DART 긴급 공시 → 무조건 Sonnet 호출
  const urgentDart = dartDisclosures.filter(d => d.isUrgent);
  if (urgentDart.length > 0) triggerReasons.push(`DART 긴급공시: ${urgentDart.map(d => d.title).join(', ')}`);

  // DART 호재 공시 → Sonnet 호출 트리거
  const positiveDart = dartDisclosures.filter(d => d.isPositive);
  if (positiveDart.length > 0) triggerReasons.push(`DART 호재공시: ${positiveDart.map(d => d.title).join(', ')}`);

  if (triggerReasons.length === 0 && !context) {
    return { triggered: false, relevantNews, dartDisclosures };
  }

  // 미국증시 실시간 지수 크롤링 (Haiku 우회 — 직접 Sonnet에 전달)
  const usMarket = await fetchUsMarketStatus();

  const prompt = buildSonnetPrompt(enrichedHoldings, assets, relevantNews, watchlist, context, dartDisclosures, usMarket, candidateStocks);
  const result = await callSonnet(prompt);

  return { triggered: true, triggerReasons, relevantNews, dartDisclosures, analysis: result };
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

// runAnalysisPipeline: monitor.js / routes/portfolio.js에서 호출
// portfolio.getPortfolioSummary() 결과를 받아 전체 분석 파이프라인 실행
async function runAnalysisPipeline(portfolioSummary) {
  const { getDb } = require('../db/database');
  const { fetchAllRSS } = require('./rss');
  const { getNaverNews } = require('./naver');
  const { checkDart } = require('./dart');
  const { sendUrgentAlert, sendApiLimitAlert } = require('./alert');
  const { getSonnetRemainingToday } = require('./claude-sonnet');

  if (getSonnetRemainingToday() <= 0) {
    await sendApiLimitAlert();
    return;
  }

  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const holdings = portfolioSummary.holdings || [];
  if (holdings.length === 0) return;

  // 뉴스 수집 (news_cache로 오늘 이미 수집한 뉴스 URL 중복 방지)
  const cachedUrls = new Set(
    db.prepare('SELECT url FROM news_cache WHERE date = ?').all(today).map(r => r.url)
  );

  let allNews = [];
  try {
    const rss = await fetchAllRSS();
    const newRss = rss.filter(n => n.url && !cachedUrls.has(n.url));
    // 새 뉴스만 캐시 저장
    const cacheStmt = db.prepare('INSERT OR IGNORE INTO news_cache (date, source, title, url, content) VALUES (?, ?, ?, ?, ?)');
    for (const n of newRss) {
      cacheStmt.run(today, n.source || '', n.title || '', n.url || '', n.content || '');
    }
    allNews.push(...newRss);
  } catch (e) { console.warn('[Pipeline] RSS 실패:', e.message); }

  try {
    for (const h of holdings) {
      if (h.stock_name) {
        const naverNews = await getNaverNews(h.stock_name);
        const newNaver = naverNews.filter(n => n.url && !cachedUrls.has(n.url));
        allNews.push(...newNaver);
      }
    }
  } catch (e) { console.warn('[Pipeline] 네이버 뉴스 실패:', e.message); }

  // DART 공시 체크 — 신규 공시 수집 및 즉시 알림
  let dartDisclosures = [];
  try {
    const { checkNewDisclosures } = require('./dart');
    const { sendKakao } = require('./kakao');
    const SERVER_URL = `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}`;

    dartDisclosures = await checkNewDisclosures(holdings);

    // 중요 공시(긴급/호재/실적) 즉시 카카오 알림
    const notifyDart = dartDisclosures.filter(d => d.isImportant);
    for (const d of notifyDart) {
      let msg = `${d.icon} [DART 공시] ${d.stockName}\n\n`;
      msg += `${d.title}\n`;
      msg += `영향: ${d.impact} / 발생일: ${d.date}\n`;
      if (d.isUrgent) msg += `\n⚠️ 악재성 공시 — 즉시 확인 필요\n`;
      if (d.isPositive) msg += `\n✅ 호재성 공시 — AI 분석 진행 중\n`;
      msg += `\n📎 ${d.url}\n👉 ${SERVER_URL}`;
      await sendKakao(msg, d.stockName, `dart_${d.type}`);
    }
  } catch (e) { console.warn('[Pipeline] DART 체크 실패:', e.message); }

  const assets = {
    stockValue: portfolioSummary.stockValue,
    cash: portfolioSummary.cash,
    newInvestment: portfolioSummary.newInvestment,
    total: portfolioSummary.totalAssets
  };

  // watchlist 로드
  const watchlist = db.prepare('SELECT * FROM watchlist WHERE date = ? ORDER BY rowid LIMIT 10').all(today);

  const result = await analyzePortfolio(holdings, assets, allNews, watchlist, '', dartDisclosures);

  if (result.triggered && result.analysis) {
    const a = result.analysis;

    // 보유 종목별로 개별 알림 (첫 번째 종목에만 보내던 버그 수정)
    if (a.action && a.action !== '보유유지' && a.action !== '판단불가') {
      for (const holding of holdings) {
        await sendUrgentAlert(holding, a, result.relevantNews || []);
      }
    }

    // DB 저장 (new 컬럼 포함)
    db.prepare(
      `INSERT INTO analysis (date, stock_name, action, confidence, reason, data_used, news_impact, why_sell_now, why_hold, why_switch, why_cash, alternative_stock, target_price, stop_loss, urgency, cash_recommendation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      today,
      holdings.map(h => h.stock_name).join(','),
      a.action, a.confidence, a.reason,
      JSON.stringify(a.data_used || []),
      a.news_impact || null,
      a.why_sell_now || null, a.why_hold || null,
      a.why_switch || null, a.why_cash || null,
      a.alternative_stock, a.target_price, a.stop_loss, a.urgency, a.cash_recommendation
    );
  }
}

module.exports = {
  analyzePortfolio,
  runAnalysisPipeline,
  runMorningReport,
  runClosingReport,
  runFridayCheck,
  runMondayCheck,
  shouldCallSonnet
};
