const { callSonnet } = require('./claude-sonnet');
const { filterNewsBatch } = require('./claude-haiku');
const { getMinutesUntilClose, isFridayAfternoon, isOneHourBeforeClose } = require('./portfolio');
const axios = require('axios');
const cheerio = require('cheerio');
const { getTodayKST } = require('./dateutil');

async function fetchUsMarketStatus() {
  // Yahoo Finance v8 API — 크롤링 불필요, 구조적 JSON 응답
  const symbols = [
    { name: 'NASDAQ', symbol: '^IXIC' },
    { name: 'S&P500', symbol: '^GSPC' },
    { name: '나스닥선물', symbol: 'NQ=F' },
    { name: 'S&P선물', symbol: 'ES=F' }
  ];
  const results = [];
  for (const idx of symbols) {
    try {
      const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(idx.symbol)}`, {
        params: { interval: '1d', range: '1d' },
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 8000
      });
      const meta = res.data?.chart?.result?.[0]?.meta;
      if (!meta) { results.push({ name: idx.name, changeRate: null }); continue; }
      const changeRate = meta.regularMarketPrice && meta.previousClose
        ? Math.round(((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 10000) / 100
        : null;
      results.push({ name: idx.name, changeRate, price: meta.regularMarketPrice ?? null });
    } catch {
      results.push({ name: idx.name, changeRate: null });
    }
  }
  return results;
}

// Sonnet 호출 조건 체크
function shouldCallSonnet(holding, news = [], watchlistCandidate = null) {
  const reasons = [];

  // 1. 주가 상승 +3% (익절 검토) 또는 하락 -2% (손절 검토) — 방향 분리
  if (holding.changeRate !== null && holding.changeRate >= 3) {
    reasons.push(`주가 +${holding.changeRate}% 상승`);
  }
  if (holding.changeRate !== null && holding.changeRate <= -3) {
    reasons.push(`주가 ${holding.changeRate}% 하락 — 손절 검토`);
  }
  // 2. 거래량 2배 이상 + 가격 방향 결합
  if (holding.volumeRatio !== null && holding.volumeRatio >= 2 && holding.changeRate !== null) {
    reasons.push(`거래량 ${holding.volumeRatio}배 + ${holding.changeRate >= 0 ? '상승' : '하락'}`);
  }
  // 3. 외국인 순매도 전환 (시총 대비 — 절대값 대신 연속 매도일 기준)
  if (holding.foreignConsecutiveDays !== null && holding.foreignConsecutiveDays <= -2) {
    reasons.push(`외국인 ${Math.abs(holding.foreignConsecutiveDays)}일 연속 매도`);
  }
  if (holding.foreignNet !== null && holding.foreignNet > 50000) {
    reasons.push('외국인 대량 매수');
  }
  // 4. 기관 연속 매도
  if (holding.institutionConsecutiveDays !== null && holding.institutionConsecutiveDays <= -2) {
    reasons.push(`기관 ${Math.abs(holding.institutionConsecutiveDays)}일 연속 매도`);
  }
  // 5. Haiku 필터 통과 뉴스
  if (news.length > 0) {
    reasons.push('영향 뉴스 감지');
  }
  // 6. 트레일링 스탑 도달 (고점 -7%) — 최우선 손절
  if (holding.trailingStop && holding.current_price <= holding.trailingStop) {
    reasons.push('트레일링 스탑 도달');
  }
  // 7. 목표가 도달 — 익절
  if (holding.target_price && holding.current_price >= holding.target_price) {
    reasons.push('목표가 도달');
  }
  // 8. RSI 75 이상 (과매수 과열) + 거래량 감소 동반 시만 익절 시그널
  if (holding.rsi !== null && holding.rsi >= 75 && holding.volumeRatio !== null && holding.volumeRatio < 1) {
    reasons.push(`RSI ${holding.rsi} 과열 + 거래량 감소`);
  }
  // 9. RSI 28 이하 — 과매도 (반등 or 추가 하락 판단)
  if (holding.rsi !== null && holding.rsi <= 28) {
    reasons.push(`RSI ${holding.rsi} 과매도`);
  }
  // 10. MACD 데드크로스 — 매도 시그널 (골든크로스는 매수 시그널, 여기선 제외)
  if (holding.macd === '데드크로스') {
    reasons.push('MACD 데드크로스');
  }

  return { should: reasons.length > 0, reasons };
}

function buildSonnetPrompt(enrichedHoldings, assets, relevantNews, watchlist, context, dartDisclosures = [], usMarket = [], candidateStocks = []) {
  const now = new Date();
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const dayName = dayNames[kst.getUTCDay()];
  const minutesLeft = getMinutesUntilClose();
  const isFriday = kst.getUTCDay() === 5;
  const isMonday = kst.getUTCDay() === 1;

  const holdingsText = enrichedHoldings.map(h => {
    const bbText = h.bollingerBands
      ? `상단 ${h.bollingerBands.upper.toLocaleString()} / 중단 ${h.bollingerBands.middle.toLocaleString()} / 하단 ${h.bollingerBands.lower.toLocaleString()}`
      : '데이터없음';
    const investorDateNote = h.investorDataDate
      ? (h.investorIsToday ? '(오늘)' : `(전일 ${h.investorDataDate})`)
      : '';

    const foreignNetAmountStr = h.foreignNetAmount != null
      ? ` (${h.foreignNetAmount >= 0 ? '+' : ''}${Math.round(h.foreignNetAmount / 100000000 * 10) / 10}억원)`
      : '';
    const week52Str = h.week52High
      ? `52주고가 ${h.week52High.toLocaleString()}원${h.isNear52High ? ' ⚠️신고가근접' : ''} / 52주저가 ${h.week52Low?.toLocaleString() ?? '-'}원${h.isNear52Low ? ' ⚠️신저가근접' : ''}`
      : '데이터없음';

    // 볼린저밴드 내 현재가 위치 (상단/중단/하단 어디에 가까운지)
    let bbPosition = '데이터없음';
    if (h.bollingerBands && h.current_price) {
      const { upper, middle, lower } = h.bollingerBands;
      const range = upper - lower;
      if (range > 0) {
        const pct = Math.round(((h.current_price - lower) / range) * 100);
        if (pct >= 80) bbPosition = `상단근접(${pct}%)⚠️과매수`;
        else if (pct >= 50) bbPosition = `중단~상단(${pct}%)`;
        else if (pct >= 20) bbPosition = `중단~하단(${pct}%)`;
        else bbPosition = `하단근접(${pct}%)↑반등구간`;
      }
    }

    // 수익 단계 판단
    const profitStage = h.profit_loss_rate >= 7 ? '익절검토(+7%초과)' :
                        h.profit_loss_rate >= 3 ? '수익중(+3~7%)' :
                        h.profit_loss_rate >= 0 ? '소폭수익(0~3%)' :
                        h.profit_loss_rate >= -3 ? '소폭손실(-3%이내)' : '손절검토(-3%초과)⚠️';

    return `
종목: ${h.stock_name} (${h.stock_code || '-'})
보유: ${h.quantity}주 / 평단가: ${h.avg_price.toLocaleString()}원 / 총매수금: ${Math.round(h.avg_price * h.quantity).toLocaleString()}원
현재가: ${h.current_price.toLocaleString()}원 / 수익률: ${h.profit_loss_rate}% → ${profitStage}
평가손익: ${h.profit_loss >= 0 ? '+' : ''}${h.profit_loss.toLocaleString()}원
목표가: ${h.target_price ? h.target_price.toLocaleString() + '원' : '미설정'} / 손절가: ${h.stop_loss ? h.stop_loss.toLocaleString() + '원' : '미설정'}
─ 기술지표 ─
RSI: ${h.rsi ?? '데이터없음'}${h.rsi >= 70 ? ' ⚠️과매수' : h.rsi <= 30 ? ' ↑과매도반등' : ''}
MACD: ${h.macd ?? '데이터없음'} / MACD선: ${h.macdLine ?? '-'}
거래량배수: ${h.volumeRatio ?? '데이터없음'}${h.volumeRatio >= 2 ? 'x ⚠️급증' : h.volumeRatio < 0.5 ? 'x ↓관심감소' : 'x'}
볼린저밴드: ${bbText} → 현재가위치: ${bbPosition}
52주: ${week52Str}
트레일링스탑: ${h.trailingStop?.toLocaleString() ?? '데이터없음'}원${h.trailingStop && h.current_price <= h.trailingStop ? ' ⚠️도달!' : ''}
─ 수급 ${investorDateNote} ─
외국인: ${h.foreignNet !== null ? (h.foreignNet >= 0 ? '+' : '') + h.foreignNet.toLocaleString() + '주' + foreignNetAmountStr : '데이터없음'} / 5일합산: ${h.foreignNet5Days !== null ? (h.foreignNet5Days >= 0 ? '+' : '') + h.foreignNet5Days.toLocaleString() + '주' : '-'} / 연속: ${h.foreignConsecutiveDays !== null ? h.foreignConsecutiveDays + '일' : '-'}
기관: ${h.institutionNet !== null ? (h.institutionNet >= 0 ? '+' : '') + h.institutionNet.toLocaleString() + '주' : '데이터없음'} / 연속: ${h.institutionConsecutiveDays !== null ? h.institutionConsecutiveDays + '일' : '-'}`;
  }).join('\n---');

  const usMarketText = usMarket.length > 0
    ? usMarket.map(m => `${m.name}: ${m.changeRate !== null ? (m.changeRate >= 0 ? '+' : '') + m.changeRate + '%' : '데이터없음'}${m.futures !== undefined ? ` (선물 ${m.futures !== null ? (m.futures >= 0 ? '+' : '') + m.futures + '%' : '데이터없음'})` : ''}`).join(' / ')
    : '데이터없음 (크롤링 실패)';

  // 뉴스 최적화: 최대 5건, 제목 + 50자 요약만 전달 (Sonnet 입력 토큰 절감)
  const newsText = relevantNews.length > 0
    ? relevantNews.slice(0, 5).map(n => {
        const title = n.title || n.news?.title || '';
        const summary = (n.summary || n.content || n.news?.summary || n.news?.content || '').slice(0, 50);
        const impact = n.impact || '중립';
        const urgency = n.urgency || '정보';
        return `[${impact}/${urgency}] ${title}${summary ? ' — ' + summary : ''}`;
      }).join('\n')
    : '영향 뉴스 없음';

  // DART 공시 텍스트
  const dartText = dartDisclosures.length > 0
    ? dartDisclosures.map(d =>
        `${d.icon} [${d.stockName}] ${d.title} (${d.date}) — 영향: ${d.impact}\n공시URL: ${d.url}`
      ).join('\n')
    : '신규 공시 없음';

  // watchlist 상위 5종목 (갈아타기/신규 후보 비교용)
  const availCashForWl = (assets.cash || 0) + (assets.newInvestment || 0);
  const watchlistText = (watchlist || []).slice(0, 5).map(w => {
    const foreignDir = w.foreign_net > 0 ? '외인매수' : w.foreign_net < 0 ? '외인매도' : '외인중립';
    const institutionDir = w.institution_net > 0 ? '기관매수' : w.institution_net < 0 ? '기관매도' : '기관중립';
    const buyableQty = w.current_price && availCashForWl > 0 ? Math.floor(availCashForWl / w.current_price) : null;
    const priceStr = w.current_price ? `현재가 ${w.current_price.toLocaleString()}원` : '가격없음';
    const buyStr = buyableQty !== null ? ` → 최대 ${buyableQty}주 매수가능` : '';
    return `${w.stock_name}(${w.stock_code || '-'}) ${priceStr}${buyStr}\n  RSI:${w.rsi ?? '-'} MACD:${w.macd ?? '-'} 거래량:${w.volume_ratio ?? '-'}x ${foreignDir} ${institutionDir} | ${w.reason || ''}`;
  }).join('\n');

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
투자 가능 현금: ${(assets.cash + assets.newInvestment).toLocaleString()}원

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

[분석 원칙 — 반드시 준수]
- 데이터 없는 항목은 "판단불가"로 처리. 추측 금지.
- 긍정적으로 포장하지 말 것. 불확실하면 현금 보유가 정답.
- 매수 추천은 아래 조건을 모두 충족할 때만: 외국인 또는 기관 순매수 확인 + RSI 40~65 + 상승 추세 + 뚜렷한 상승 근거 존재
- 조건 하나라도 불확실하면 매수 추천 금지. "현금 보유"로 판단.
- 목표가는 반드시 근거(52주 고가/저항선/업종 PER) 기반으로 설정. 근거 없으면 설정 금지.
- 손절가는 매수가 기준 -5% 이내로 반드시 설정.
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

투자 가능 현금: ${(assets.cash + assets.newInvestment).toLocaleString()}원

[지금 당장 해야 할 행동 — 아래 5가지 시나리오 중 하나를 선택]
시나리오1 보유유지: 현재 종목이 목표가까지 추가 상승 가능하고 리스크 없음
시나리오2 전량매도(익절): 수익률 +5% 이상 또는 목표가 도달 또는 더 좋은 종목 발견
시나리오3 전량매도(손절): 수익률 -3% 이하 또는 트레일링스탑 도달 또는 악재 확인
시나리오4 갈아타기: 현재 종목 매도 후 watchlist 종목으로 이동 (1.5배 이상 유리할 때)
시나리오5 현금매수: 현금으로 watchlist 신규 매수 (6조건 모두 충족 시에만)
시나리오6 현금보유: 위 조건 미충족. 기다리는 것도 전략.

→ 선택한 시나리오와 이유를 수치로 명시
→ 매수 추천 시: 투자가능현금 ${(assets.cash + assets.newInvestment).toLocaleString()}원 / 진입가 / 최대주수 / 목표가 / 손절가 반드시 포함
→ 확신 없으면 시나리오6(현금보유) 선택. 애매한 추천은 손실로 이어짐.`;
}

async function analyzePortfolio(enrichedHoldings, assets, allNews, watchlist, context = '', dartDisclosures = []) {
  if (!enrichedHoldings || enrichedHoldings.length === 0) {
    console.log('[Sonnet] holdings 없음 → 호출 스킵');
    return { triggered: false, relevantNews: [], dartDisclosures };
  }
  const firstH = enrichedHoldings[0];
  if (!firstH.current_price) {
    console.log('[Sonnet] current_price 없음 → 호출 스킵');
    return { triggered: false, relevantNews: [], dartDisclosures };
  }
  if (!firstH.rsi) {
    console.warn('[Sonnet] RSI 없음 — KIS 데이터 불완전. 뉴스/DART 기반으로만 분석 진행');
  }
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
  const relevantNews = haikuResults.filter(r => r.relevant === true);
  const prompt = buildSonnetPrompt(enrichedHoldings, assets, relevantNews, watchlist, '이것은 모닝 리포트입니다. 오늘 하루 전체 전략을 제시하세요.');
  return callSonnet(prompt);
}

async function runClosingReport(enrichedHoldings, assets, allNews) {
  const haikuResults = await filterNewsBatch(allNews.slice(0, 10), enrichedHoldings);
  const relevantNews = haikuResults.filter(r => r.relevant === true);
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
  const today = getTodayKST();
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

    // 중요 공시(긴급/호재/실적) 즉시 텔레그램 알림
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

    // switch_stock 유효성 검증
    if (a.switch_stock?.name) {
      // 6자리 코드 형식 검증
      if (a.switch_stock.code && !/^\d{6}$/.test(a.switch_stock.code)) {
        console.warn(`[Pipeline] switch_stock.code 무효: ${a.switch_stock.code} → null 처리`);
        a.switch_stock.code = null;
      }
      // watchlist에 없는 종목 추천 차단 (Sonnet 환각 방지)
      const watchlistNames = watchlist.map(w => w.stock_name);
      const watchlistCodes = watchlist.map(w => w.stock_code).filter(Boolean);
      const inWatchlist = watchlistNames.includes(a.switch_stock.name) ||
        (a.switch_stock.code && watchlistCodes.includes(a.switch_stock.code));
      if (!inWatchlist) {
        console.warn(`[Pipeline] switch_stock '${a.switch_stock.name}' watchlist 미포함 → 차단`);
        a.switch_stock = null;
        if (['switch_stock', 'buy_new'].includes(a.action)) a.action = '판단불가';
      }
    }

    if (a.action && a.action !== '보유유지' && a.action !== '판단불가') {
      await sendUrgentAlert(holdings[0], a, result.relevantNews || []);
    }

    // 보유 종목에 목표가/손절가 자동 저장
    if (holdings.length > 0 && (a.target_price || a.stop_loss)) {
      const today2 = getTodayKST();
      for (const h of holdings) {
        if (h.stock_code) {
          db.prepare('UPDATE holdings SET target_price = ?, stop_loss = ? WHERE stock_code = ? AND date = ?')
            .run(a.target_price || null, a.stop_loss || null, h.stock_code, today2);
        } else {
          db.prepare('UPDATE holdings SET target_price = ?, stop_loss = ? WHERE stock_name = ? AND date = ?')
            .run(a.target_price || null, a.stop_loss || null, h.stock_name, today2);
        }
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

// 현금만 있을 때 장 중 watchlist 기반 진입 탐색
// Sonnet 호출 조건: watchlist 상위 종목 중 외국인+기관 동시 매수 + RSI 40~65 + 골든크로스
async function runCashMonitor(portfolioSummary) {
  const { getDb } = require('../db/database');
  const { fetchAllRSS } = require('./rss');
  const { sendKakao } = require('./kakao');
  const { getSonnetRemainingToday } = require('./claude-sonnet');
  const { isOneHourBeforeClose, isFridayAfternoon } = require('./portfolio');

  if (getSonnetRemainingToday() <= 0) return;
  if (isOneHourBeforeClose() || isFridayAfternoon()) {
    console.log('[CashMonitor] 장 마감 임박 or 금요일 오후 — 신규 진입 자제');
    return;
  }

  const db = getDb();
  const today = getTodayKST();
  const availCash = (portfolioSummary.cash || 0) + (portfolioSummary.newInvestment || 0);

  // watchlist에서 조건 충족 종목 필터 (냉정 기준)
  const watchlist = db.prepare('SELECT * FROM watchlist WHERE date = ? ORDER BY rowid').all(today);
  if (watchlist.length === 0) {
    console.log('[CashMonitor] watchlist 없음 - 스킵');
    return;
  }

  // 조건: RSI 40~65 + 외국인 또는 기관 순매수 + MACD 골든크로스 or 상승 + 현금으로 최소 1주 매수 가능
  const qualified = watchlist.filter(w =>
    w.rsi >= 40 && w.rsi <= 65 &&
    (w.foreign_net > 0 || w.institution_net > 0) &&
    (w.macd === '골든크로스' || w.macd === '상승중') &&
    w.current_price > 0 && availCash >= w.current_price
  );

  if (qualified.length === 0) {
    console.log(`[CashMonitor] 조건 충족 종목 없음 (RSI 40~65 + 수급 매수 + MACD 상승 + 현금 ${availCash.toLocaleString()}원으로 1주 이상 매수 가능) — 현금 보유 유지`);
    return;
  }

  console.log(`[CashMonitor] 조건 충족 ${qualified.length}종목 → Sonnet 분석 호출`);

  // 뉴스 수집
  let allNews = [];
  try {
    allNews = await fetchAllRSS();
  } catch (e) { /* silent */ }

  const haikuResults = await filterNewsBatch(allNews.slice(0, 20), [], qualified.map(w => w.stock_name));
  const relevantNews = haikuResults.filter(n => n.relevant === true);
  const candidateStocks = qualified.map(w => w.stock_name);

  const assets = {
    stockValue: 0,
    cash: portfolioSummary.cash || 0,
    newInvestment: portfolioSummary.newInvestment || 0,
    total: availCash
  };

  const SERVER_URL = `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}`;
  const now = new Date();
  const minutesLeft = require('./portfolio').getMinutesUntilClose();

  const prompt = `분석 요청 시각: ${now.toLocaleString('ko-KR')}
장 마감까지: ${minutesLeft}분
현재 보유 종목: 없음 (전량 현금 보유 중)

=== 총 자산 현황 ===
현금: ${availCash.toLocaleString()}원
투자 가능 현금: ${availCash.toLocaleString()}원

=== watchlist 조건 충족 종목 (외국인/기관 매수 + RSI 40~65 + MACD 상승) ===
${qualified.slice(0, 5).map(w => {
  const buyableQty = w.current_price ? Math.floor(availCash / w.current_price) : null;
  return `${w.stock_name}(${w.stock_code}): 현재가 ${w.current_price?.toLocaleString() ?? '-'}원, RSI ${Math.round(w.rsi ?? 0)}, MACD ${w.macd}, 거래량배수 ${w.volume_ratio ?? '-'}, 외인 ${w.foreign_net > 0 ? '+' : ''}${w.foreign_net?.toLocaleString() ?? 0}주, 기관 ${w.institution_net > 0 ? '+' : ''}${w.institution_net?.toLocaleString() ?? 0}주${buyableQty !== null ? `, 최대 ${buyableQty}주 매수 가능` : ''}`;
}).join('\n')}

=== 관련 뉴스 ===
${relevantNews.length > 0 ? relevantNews.slice(0, 3).map(n => `[${n.impact}] ${n.title}`).join('\n') : '관련 뉴스 없음'}

[분석 원칙 — 반드시 준수]
- 현금을 지키는 것이 최우선. 손실 가능성이 조금이라도 있으면 매수 금지.
- 매수 추천 조건: 외국인+기관 동시 순매수 확인 + RSI 40~65 + 상승 추세 명확 + 장 마감 1시간 이상 남음 + 뚜렷한 상승 근거
- 위 조건 중 하나라도 불확실하면 action을 반드시 hold_cash로 설정.
- 매수 추천 시 진입가, 목표가(근거 명시), 손절가(진입가 -5% 이내), 최대 매수 주수 반드시 포함.
- 과장 금지. 데이터 없는 항목 추측 금지.

위 종목 중 지금 당장 매수해도 되는 종목이 있으면 buy_new로, 없으면 hold_cash로 판단하라.
👉 ${SERVER_URL}`;

  const result = await callSonnet(prompt);
  if (!result) return;

  if (result.action === 'buy_new' && result.switch_stock?.name) {
    const sw = result.switch_stock;
    const buyableQty = sw.entry_price ? Math.floor(availCash / sw.entry_price) : null;
    let msg = `💰 [신규진입 추천] ${sw.name}\n\n`;
    msg += `현금: ${availCash.toLocaleString()}원\n`;
    if (sw.entry_price) msg += `진입가: ${sw.entry_price.toLocaleString()}원`;
    if (buyableQty) msg += ` → 최대 ${buyableQty}주\n`;
    else msg += '\n';
    if (sw.target_price) msg += `🎯 목표가: ${sw.target_price.toLocaleString()}원\n`;
    if (sw.stop_loss) msg += `🛡 손절가: ${sw.stop_loss.toLocaleString()}원\n`;
    if (sw.reason) msg += `\n이유: ${sw.reason.slice(0, 150)}\n`;
    if (result.key_risk) msg += `⚠️ 리스크: ${result.key_risk.slice(0, 100)}\n`;
    msg += `\n👉 ${SERVER_URL}`;
    if (msg.length > 4000) msg = msg.slice(0, 3990) + '…\n\n👉 ' + SERVER_URL;
    await sendKakao(msg, sw.name, 'cash_monitor_buy');
  } else {
    console.log('[CashMonitor] Sonnet 판단: 현금 보유 유지 —', result.reason?.slice(0, 80));
  }
}

module.exports = {
  analyzePortfolio,
  runAnalysisPipeline,
  runCashMonitor,
  runMorningReport,
  runClosingReport,
  runFridayCheck,
  runMondayCheck,
  shouldCallSonnet
};
