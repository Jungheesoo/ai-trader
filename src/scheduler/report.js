const { getDb } = require('../db/database');
const { callSonnet } = require('../services/claude-sonnet');
const { sendKakao } = require('../services/kakao');
const { isWeekday } = require('../services/holiday');
const { getPortfolioSummary } = require('../services/portfolio');
const { fetchAllRSS } = require('../services/rss');
const { filterNewsBatch } = require('../services/claude-haiku');
const { checkNewDisclosures } = require('../services/dart');
const { sendErrorAlert } = require('../services/alert');
const { getTodayKST } = require('../services/dateutil');
const { fetchSoxData, fetchExchangeRate } = require('../services/analyzer');

async function runMorningReport() {
  if (!isWeekday(new Date())) return;
  console.log('[Report] 모닝 리포트 시작');

  try {
    const db = getDb();
    const today = getTodayKST();

    const portfolio = await getPortfolioSummary();

    // watchlist 상위 5종목
    const watchlist = db.prepare(
      'SELECT * FROM watchlist WHERE date = ? ORDER BY rowid LIMIT 5'
    ).all(today);

    // RSS + Haiku 필터링 (최대 30건)
    const watchlistNames = watchlist.map(w => w.stock_name).filter(Boolean);
    let relevantNews = [];
    try {
      const allNews = await fetchAllRSS();
      const filtered = await filterNewsBatch(allNews.slice(0, 30), portfolio.holdings, watchlistNames);
      relevantNews = filtered.filter(n => n.relevant === true);
    } catch (e) {
      console.warn('[Report] 뉴스 수집 실패:', e.message);
    }

    let dartDisclosures = [];
    try {
      dartDisclosures = await checkNewDisclosures(portfolio.holdings);
    } catch (e) {
      console.warn('[Report] DART 수집 실패:', e.message);
    }

    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const isFriday = kst.getUTCDay() === 5;
    const isMonday = kst.getUTCDay() === 1;

    const prompt = buildMorningPrompt(portfolio, watchlist, relevantNews, isFriday, isMonday, dartDisclosures);
    const result = await callSonnet(prompt, 'morning_report');

    if (!result) {
      await sendKakao('⚠️ 모닝 리포트 AI 분석 실패. 데이터 직접 확인 필요.\n👉 http://' + (process.env.SERVER_IP || 'localhost') + ':' + (process.env.PORT || 3000));
      return;
    }

    const message = formatMorningReport(portfolio, watchlist, result, isFriday, isMonday, relevantNews, dartDisclosures);
    await sendKakao(message);

    if (portfolio.holdings.length > 0) {
      db.prepare(
        `INSERT INTO analysis (date, stock_name, action, confidence, reason, data_used, news_impact, why_sell_now, why_hold, why_switch, why_cash, alternative_stock, target_price, stop_loss, urgency, cash_recommendation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        today,
        portfolio.holdings.map(h => h.stock_name).join(','),
        result.action, result.confidence, result.reason,
        JSON.stringify([]),
        result.news_impact || null,
        result.why_sell_now || null, result.why_hold || null,
        result.switch_stock?.reason || null, null,
        result.switch_stock?.name || null,
        result.target_price || null, result.stop_loss || null,
        result.urgency, result.cash_recommendation
      );
    }

    console.log('[Report] 모닝 리포트 발송 완료');
  } catch (err) {
    console.error('[Report] 모닝 리포트 오류:', err.message);
    await sendErrorAlert('[Report] 모닝 리포트 실패: ' + err.message);
  }
}

function buildMorningPrompt(portfolio, watchlist, news, isFriday, isMonday, dartDisclosures = []) {
  const now = new Date();
  const minutesUntilClose = Math.max(0, Math.floor((new Date(now.toDateString() + ' 15:30:00') - now) / 60000));
  const availableCash = (portfolio.cash || 0) + (portfolio.newInvestment || 0);

  return {
    portfolio_summary: {
      total_assets: portfolio.totalAssets,
      stock_value: portfolio.stockValue,
      cash: portfolio.cash,
      new_investment: portfolio.newInvestment,
      overall_profit_rate: portfolio.overallProfitRate
    },
    holdings: portfolio.holdings.map(h => ({
      stock_name: h.stock_name,
      stock_code: h.stock_code,
      quantity: h.quantity,
      avg_price: h.avg_price,
      current_price: h.current_price,
      profit_loss: h.profitLoss,
      profit_rate: h.profitRate,
      rsi: h.rsi,
      macd: h.macd,
      volume_ratio: h.volumeRatio,
      trailing_stop: h.trailingStop,
      bollinger_bands: h.bollingerBands,
      foreign_net: h.foreignNet,
      institution_net: h.institutionNet,
      foreign_net_5days: h.foreignNet5Days,
      foreign_consecutive_days: h.foreignConsecutiveDays,
      institution_consecutive_days: h.institutionConsecutiveDays,
      investor_data_date: h.investorDataDate,
      investor_is_today: h.investorIsToday,
      week52_high: h.week52High,
      week52_low: h.week52Low,
      is_near_52high: h.isNear52High,
      is_near_52low: h.isNear52Low
    })),
    available_cash: (portfolio.cash || 0) + (portfolio.newInvestment || 0),
    watchlist_top5: watchlist
      .filter(w => !w.current_price || w.current_price <= availableCash)
      .map(w => ({
        stock_name: w.stock_name,
        stock_code: w.stock_code,
        rsi: w.rsi,
        macd: w.macd,
        volume_ratio: w.volume_ratio,
        foreign_net: w.foreign_net,
        current_price: w.current_price,
        reason: w.reason,
        buyable_qty: w.current_price && availableCash > 0
          ? Math.floor(availableCash / w.current_price)
          : null
      })),
    relevant_news: news.slice(0, 3).map(n => ({
      title: n.title,
      urgency: n.urgency,
      impact: n.impact
    })),
    dart_disclosures: dartDisclosures.map(d => ({
      stockName: d.stockName, title: d.title, type: d.type, impact: d.impact, icon: d.icon
    })),
    market_context: {
      day_of_week: ['일', '월', '화', '수', '목', '금', '토'][new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCDay()],
      is_friday: isFriday,
      is_monday: isMonday,
      minutes_until_close: minutesUntilClose,
      report_type: 'morning',
      instruction: `투자 가능 현금 ${((portfolio.cash || 0) + (portfolio.newInvestment || 0)).toLocaleString()}원을 기준으로 아래 모든 시나리오를 비교해 가장 수익률이 높은 전략 하나를 선택하라.
[시나리오]
1. 보유 종목 있으면: 계속 보유 vs 전량 매도 후 watchlist 갈아타기 vs 현금 추가 매수
2. 현금만 있으면: watchlist에서 신규 매수 1종목 vs 현금 보유 대기
3. 보유 + 현금: 현금으로 추가 매수 vs 갈아타기 vs 그대로
어떤 시나리오든 매수 추천 시 현재가 기준 몇 주 매수 가능한지 반드시 명시할 것.`
    }
  };
}

function formatMorningReport(portfolio, watchlist, ai, isFriday, isMonday, relevantNews, dartDisclosures = []) {
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const serverUrl = `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}`;

  let msg = `📊 AI 트레이더 모닝 리포트 ${today}\n\n`;

  // 총 자산
  const pnl = portfolio.unrealizedPnL || 0;
  const pnlSign = pnl >= 0 ? '+' : '';
  const profitSign = (portfolio.overallProfitRate || 0) >= 0 ? '+' : '';
  msg += `━━━━━━━━━━━━━━\n💼 총 자산 현황\n━━━━━━━━━━━━━━\n`;
  msg += `총 운용: ${(portfolio.totalAssets || 0).toLocaleString()}원\n`;
  msg += `평가손익: ${pnlSign}${Math.round(pnl).toLocaleString()}원 (${profitSign}${(portfolio.overallProfitRate || 0).toFixed(1)}%)\n`;
  msg += `보유주식: ${(portfolio.stockValue || 0).toLocaleString()}원 / 현금: ${(portfolio.cash || 0).toLocaleString()}원\n\n`;

  // 보유 종목 AI 판단
  if (portfolio.holdings && portfolio.holdings.length > 0) {
    msg += `━━━━━━━━━━━━━━\n📈 보유 종목 AI 판단\n━━━━━━━━━━━━━━\n`;
    for (const h of portfolio.holdings) {
      const pSign = (h.profitRate || 0) >= 0 ? '+' : '';
      msg += `[${h.stock_name}] ${h.quantity}주 · 평단 ${(h.avg_price || 0).toLocaleString()}원\n`;
      msg += `현재가: ${(h.current_price || h.avg_price).toLocaleString()}원 (${pSign}${(h.profitRate || 0).toFixed(1)}%)\n`;
      msg += `수익: ${pSign}${Math.round(h.profitLoss || 0).toLocaleString()}원\n`;
      const rsiStr = h.rsi ? `RSI: ${Math.round(h.rsi)}${h.rsi >= 70 ? '(과매수⚠️)' : h.rsi <= 30 ? '(과매도↑)' : ''}` : 'RSI: 없음';
      msg += `${rsiStr} / MACD: ${h.macd || '없음'}\n`;
      if (h.foreignNet !== null && h.foreignNet !== undefined) {
        const fSign = h.foreignNet >= 0 ? '+' : '';
        const instSign = (h.institutionNet || 0) >= 0 ? '+' : '';
        const dateNote = h.investorDataDate ? (h.investorIsToday ? '' : ` (전일)`) : '';
        msg += `외인: ${fSign}${(h.foreignNet).toLocaleString()}주${dateNote}`;
        if (h.foreignConsecutiveDays > 0) msg += ` (${h.foreignConsecutiveDays}일 연속 매수)`;
        msg += ` / 기관: ${instSign}${(h.institutionNet || 0).toLocaleString()}주\n`;
      }
      if (h.bollingerBands) {
        msg += `BB: 상단 ${h.bollingerBands.upper.toLocaleString()} / 중단 ${h.bollingerBands.middle.toLocaleString()} / 하단 ${h.bollingerBands.lower.toLocaleString()}\n`;
      }
      if (h.trailingStop) msg += `⚡ 트레일링: ${h.trailingStop.toLocaleString()}원\n`;
      msg += '\n';
    }

    msg += `→ AI: ${ai.action || '판단불가'} [신뢰도: ${ai.confidence || '?'}]\n`;
    if (ai.current_upside) msg += `현재 종목 예상 추가 수익: ${ai.current_upside}\n`;
    if (ai.target_price) msg += `🎯 목표가: ${Math.round(ai.target_price).toLocaleString()}원${ai.why_target_price ? ` — ${ai.why_target_price}` : ''}\n`;
    if (ai.stop_loss) msg += `🛡 손절가: ${Math.round(ai.stop_loss).toLocaleString()}원${ai.why_stop_loss ? ` — ${ai.why_stop_loss}` : ''}\n`;
    msg += `근거: ${(ai.reason || '-').slice(0, 120)}\n\n`;
  }

  // AI 전략 추천
  const availCash = (portfolio.cash || 0) + (portfolio.newInvestment || 0);
  const sw = ai.switch_stock;
  const isBuy = ['buy_new', 'switch_stock', 'buy_more'].includes(ai.action);
  const sectionTitle = ai.action === 'switch_stock' ? '🔄 갈아타기 추천' : ai.action === 'buy_new' ? '💰 신규 매수 추천' : ai.action === 'buy_more' ? '➕ 추가 매수 추천' : '🔄 AI 전략';
  msg += `━━━━━━━━━━━━━━\n${sectionTitle}\n━━━━━━━━━━━━━━\n`;
  msg += `투자 가능 현금: ${availCash.toLocaleString()}원\n`;
  if (sw && sw.name) {
    msg += `추천 종목: ${sw.name}${sw.code ? `(${sw.code})` : ''}\n`;
    if (sw.entry_price) {
      const buyableQty = availCash > 0 ? Math.floor(availCash / sw.entry_price) : 0;
      msg += `진입가: ${sw.entry_price.toLocaleString()}원 → 최대 ${buyableQty}주 매수 가능\n`;
    }
    if (sw.target_price) msg += `🎯 목표가: ${sw.target_price.toLocaleString()}원\n`;
    if (sw.stop_loss) msg += `🛡 손절가: ${sw.stop_loss.toLocaleString()}원\n`;
    if (ai.current_upside && sw.expected_upside) msg += `현재 종목 ${ai.current_upside} vs 대체 ${sw.expected_upside} 예상\n`;
    if (sw.reason) msg += `이유: ${sw.reason.slice(0, 100)}\n`;
  } else if (ai.cash_recommendation === '현금보유') {
    msg += `→ 현금 보유 유지\n`;
    if (ai.why_cash) msg += `이유: ${ai.why_cash.slice(0, 100)}\n`;
  } else if (portfolio.holdings?.length > 0) {
    msg += `→ 현재 종목 보유 유지\n`;
    if (ai.why_hold) msg += `이유: ${ai.why_hold.slice(0, 100)}\n`;
  }
  msg += '\n';

  // 오늘 주목 종목 TOP3 (watchlist)
  if (watchlist && watchlist.length > 0) {
    msg += `━━━━━━━━━━━━━━\n🔍 오늘 주목 종목 TOP${Math.min(3, watchlist.length)}\n━━━━━━━━━━━━━━\n`;
    watchlist.slice(0, 3).forEach((w, i) => {
      msg += `${i + 1}. ${w.stock_name} / RSI:${Math.round(w.rsi || 0)}\n`;
      if (w.reason) msg += `   이유: ${w.reason}\n`;
    });
    msg += '\n';
  }

  // DART 공시
  if (dartDisclosures && dartDisclosures.length > 0) {
    msg += `━━━━━━━━━━━━━━\n📋 오늘 DART 공시\n━━━━━━━━━━━━━━\n`;
    dartDisclosures.forEach(d => {
      msg += `${d.icon} [${d.stockName}] ${d.title}\n`;
    });
    msg += '\n';
  }

  // 주요 뉴스 (최대 3건)
  if (relevantNews && relevantNews.length > 0) {
    msg += `━━━━━━━━━━━━━━\n📰 주요 뉴스 (최대 3건)\n━━━━━━━━━━━━━━\n`;
    relevantNews.slice(0, 3).forEach(n => {
      const icon = n.urgency === '긴급' ? '🔴' : n.impact === '긍정' ? '🟢' : n.impact === '부정' ? '🟠' : '🟡';
      msg += `${icon} ${n.title}\n`;
    });
    msg += '\n';
  }

  // 시장 전망
  msg += `━━━━━━━━━━━━━━\n🌍 시장 전망\n━━━━━━━━━━━━━━\n`;
  if (ai.market_outlook) msg += `전망: ${ai.market_outlook}\n`;
  if (ai.key_risk) msg += `리스크: ${ai.key_risk}\n`;
  msg += `현금 추천: ${ai.cash_recommendation || '판단불가'}\n`;
  if (isFriday) msg += `⚠️ 금요일: 오후 2시 이후 신규 진입 자제\n`;
  if (isMonday) msg += `⚠️ 월요일: 주말 효과 하락 가능, 악재 확인 후 진입\n`;
  if (ai.warning) msg += `⚠️ ${ai.warning}\n`;
  msg += '\n';

  msg += `👉 ${serverUrl}`;
  return msg;
}

module.exports = { runMorningReport };
