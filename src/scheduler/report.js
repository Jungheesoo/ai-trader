const { getDb } = require('../db/database');
const { callSonnet } = require('../services/claude-sonnet');
const { sendKakao } = require('../services/kakao');
const { isWeekday } = require('../services/holiday');
const { getPortfolioSummary } = require('../services/portfolio');
const { fetchAllRSS } = require('../services/rss');
const { filterNewsBatch } = require('../services/claude-haiku');
const { sendErrorAlert } = require('../services/alert');

async function runMorningReport() {
  if (!isWeekday(new Date())) return;
  console.log('[Report] 모닝 리포트 시작');

  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);

    // 포트폴리오 요약 계산
    const portfolio = await getPortfolioSummary();

    // watchlist 상위 3종목
    const watchlist = db.prepare(
      'SELECT * FROM watchlist WHERE date = ? ORDER BY rowid LIMIT 3'
    ).all(today);

    // RSS 수집 후 Haiku 필터링
    let relevantNews = [];
    try {
      const allNews = await fetchAllRSS();
      const filtered = await filterNewsBatch(allNews, portfolio.holdings);
      relevantNews = filtered.filter(n => n.relevant);
    } catch (e) {
      console.warn('[Report] 뉴스 수집 실패:', e.message);
    }

    // 오늘 요일 체크
    const dayOfWeek = new Date().getDay();
    const isFriday = dayOfWeek === 5;
    const isMonday = dayOfWeek === 1;

    // Sonnet 호출
    const prompt = buildMorningPrompt(portfolio, watchlist, relevantNews, isFriday, isMonday);
    const result = await callSonnet(prompt, 'morning_report');

    if (!result) {
      await sendKakao('⚠️ 모닝 리포트 AI 분석 실패. 데이터 직접 확인 필요.\n👉 http://' + (process.env.SERVER_IP || 'localhost') + ':' + (process.env.PORT || 3000));
      return;
    }

    // 리포트 메시지 생성
    const message = formatMorningReport(portfolio, watchlist, result, isFriday, isMonday);
    await sendKakao(message);

    // 분석 결과 DB 저장
    if (portfolio.holdings.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO analysis (date, stock_name, action, confidence, reason, data_used, alternative_stock, target_price, stop_loss, urgency, cash_recommendation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      stmt.run(
        today,
        portfolio.holdings.map(h => h.stock_name).join(','),
        result.action,
        result.confidence,
        result.reason,
        JSON.stringify(result.data_used || []),
        result.alternative_stock,
        result.target_price,
        result.stop_loss,
        result.urgency,
        result.cash_recommendation
      );
    }

    console.log('[Report] 모닝 리포트 발송 완료');
  } catch (err) {
    console.error('[Report] 모닝 리포트 오류:', err.message);
    await sendErrorAlert('[Report] 모닝 리포트 실패: ' + err.message);
  }
}

function buildMorningPrompt(portfolio, watchlist, news, isFriday, isMonday) {
  const now = new Date();
  const minutesUntilClose = Math.max(0, Math.floor((new Date(now.toDateString() + ' 15:30:00') - now) / 60000));

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
      foreign_net: h.foreignNet,
      institution_net: h.institutionNet
    })),
    watchlist_top3: watchlist.map(w => ({
      stock_name: w.stock_name,
      rsi: w.rsi,
      macd: w.macd,
      volume_ratio: w.volume_ratio
    })),
    relevant_news: news.slice(0, 5).map(n => ({ title: n.title, reason: n.reason, urgency: n.urgency, impact: n.impact })),
    market_context: {
      day_of_week: ['일', '월', '화', '수', '목', '금', '토'][new Date().getDay()],
      is_friday: isFriday,
      is_monday: isMonday,
      minutes_until_close: minutesUntilClose,
      report_type: 'morning'
    }
  };
}

function formatMorningReport(portfolio, watchlist, ai, isFriday, isMonday) {
  const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\. /g, '.').replace('.', '');
  const serverUrl = `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}`;

  let msg = `📊 AI 트레이더 모닝 리포트 ${today}\n\n`;
  msg += `━━━━━━━━━━━━━━\n💼 총 자산 현황\n━━━━━━━━━━━━━━\n`;
  msg += `보유주식: ${Math.round((portfolio.stockValue || 0) / 10000)}만원\n`;
  msg += `현금: ${Math.round((portfolio.cash || 0) / 10000)}만원\n`;
  msg += `총 운용: ${Math.round((portfolio.totalAssets || 0) / 10000)}만원\n`;

  const profitSign = (portfolio.overallProfitRate || 0) >= 0 ? '+' : '';
  msg += `전체 수익: ${profitSign}${(portfolio.overallProfitRate || 0).toFixed(1)}%\n\n`;

  if (portfolio.holdings && portfolio.holdings.length > 0) {
    msg += `━━━━━━━━━━━━━━\n📈 종목별 AI 액션\n━━━━━━━━━━━━━━\n`;
    for (const h of portfolio.holdings) {
      const pSign = (h.profitRate || 0) >= 0 ? '+' : '';
      msg += `[${h.stock_name}] ${h.quantity}주\n`;
      msg += `현재가: ${(h.current_price || h.avg_price).toLocaleString()}원 (${pSign}${(h.profitRate || 0).toFixed(1)}%)\n`;
      msg += `수익: ${pSign}${Math.round(h.profitLoss || 0).toLocaleString()}원\n`;
      if (h.rsi) msg += `RSI: ${h.rsi.toFixed(0)} / MACD: ${h.macd || '-'}\n`;
      if (h.trailingStop) msg += `손절가: ${h.trailingStop.toLocaleString()}원 (트레일링)\n`;
      msg += `→ AI 액션: ${ai.action || '판단불가'}\n`;
      if (ai.reason) msg += `근거: ${ai.reason}\n`;
      msg += '\n';
    }
  }

  msg += `━━━━━━━━━━━━━━\n🌍 글로벌 동향\n━━━━━━━━━━━━━━\n`;
  msg += `야간 특이사항: ${portfolio.nightIssue || '없음'}\n\n`;

  if (watchlist && watchlist.length > 0) {
    msg += `━━━━━━━━━━━━━━\n🔍 오늘 주목 종목 TOP3\n━━━━━━━━━━━━━━\n`;
    watchlist.forEach((w, i) => {
      msg += `${i + 1}. ${w.stock_name} / RSI: ${(w.rsi || 0).toFixed(0)} / MACD: ${w.macd || '-'}\n`;
    });
    if (ai.alternative_stock) {
      msg += `추천: ${ai.alternative_stock}`;
      if (ai.target_price) msg += ` / 목표가 ${ai.target_price.toLocaleString()}원`;
      if (ai.stop_loss) msg += ` / 손절가 ${ai.stop_loss.toLocaleString()}원`;
      msg += '\n';
    }
    msg += '\n';
  }

  msg += `━━━━━━━━━━━━━━\n💡 오늘 액션 플랜\n━━━━━━━━━━━━━━\n`;
  msg += `${ai.action || '판단불가'}: ${ai.reason || '-'}\n`;
  if (isFriday) msg += `⚠️ 오늘 금요일: 오후 2시 이후 신규 진입 자제\n`;
  if (isMonday) msg += `⚠️ 오늘 월요일: 주말 효과 하락 가능, 악재 확인 후 진입\n`;
  if (ai.warning) msg += `⚠️ ${ai.warning}\n`;

  msg += `\n👉 ${serverUrl}`;
  return msg;
}

module.exports = { runMorningReport };
