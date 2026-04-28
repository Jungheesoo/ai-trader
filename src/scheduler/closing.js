const { getDb } = require('../db/database');
const { callSonnet } = require('../services/claude-sonnet');
const { sendKakao } = require('../services/kakao');
const { isWeekday } = require('../services/holiday');
const { sendErrorAlert } = require('../services/alert');
const { getPortfolioSummary, saveDailySeedGrowth } = require('../services/portfolio');
const { getTodayKST } = require('../services/dateutil');
const { fetchSoxData, fetchExchangeRate } = require('../services/analyzer');

async function runClosingReport() {
  if (!isWeekday(new Date())) return;
  console.log('[Closing] 마감 리포트 시작');

  try {
    const db = getDb();
    const today = getTodayKST();
    const portfolio = await getPortfolioSummary();

    // 오늘 AI 호출 횟수
    const apiCalls = db.prepare(
      "SELECT call_count_today FROM api_calls WHERE date = ? AND model = 'sonnet' ORDER BY id DESC LIMIT 1"
    ).get(today);
    const sonnetCount = apiCalls?.call_count_today || 0;

    // 오늘 알림 발송 수
    const alertCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM alerts WHERE date = ?'
    ).get(today);

    // 현금 보유 판단 횟수
    const cashHoldCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM analysis WHERE date = ? AND cash_recommendation = '현금보유'"
    ).get(today);

    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const dayOfWeek = kst.getUTCDay();
    const isTomorrow = dayOfWeek === 5 ? '월' : ['일', '월', '화', '수', '목', '금', '토'][dayOfWeek + 1 > 6 ? 0 : dayOfWeek + 1];
    const isBeforeMonday = dayOfWeek === 5; // 금요일이면 다음날 월요일

    const [sox, exRate] = await Promise.all([fetchSoxData(), fetchExchangeRate()]);

    const prompt = {
      portfolio_summary: {
        total_assets: portfolio.totalAssets,
        stock_value: portfolio.stockValue,
        cash: portfolio.cash,
        overall_profit_rate: portfolio.overallProfitRate
      },
      holdings: portfolio.holdings.map(h => ({
        stock_name: h.stock_name,
        stock_code: h.stock_code,
        current_price: h.current_price,
        avg_price: h.avg_price,
        quantity: h.quantity,
        profit_rate: h.profitRate,
        profit_loss: h.profitLoss,
        rsi: h.rsi,
        macd: h.macd,
        volume_ratio: h.volumeRatio,
        bollinger_bands: h.bollingerBands,
        foreign_net: h.foreignNet,
        foreign_net_amount: h.foreignNetAmount,
        institution_net: h.institutionNet,
        foreign_net_5days: h.foreignNet5Days,
        foreign_consecutive_days: h.foreignConsecutiveDays,
        institution_consecutive_days: h.institutionConsecutiveDays,
        investor_data_date: h.investorDataDate,
        investor_is_today: h.investorIsToday,
        week52_high: h.week52High,
        week52_low: h.week52Low,
        is_near_52high: h.isNear52High,
        is_near_52low: h.isNear52Low,
        trailing_stop: h.trailingStop
      })),
      today_stats: {
        sonnet_calls: sonnetCount,
        alert_count: alertCount?.cnt || 0,
        cash_hold_count: cashHoldCount?.cnt || 0
      },
      market_context: {
        today,
        report_time: 'KST 16:00 마감리포트 — 오늘 장 마감 후 분석',
        day_of_week: ['일', '월', '화', '수', '목', '금', '토'][dayOfWeek],
        is_before_monday: isBeforeMonday,
        sox_index: sox ?? '미국 장 개장 전 — SOX 전일종가 기준 반영 불가',
        usd_krw: exRate ?? '미국 장 개장 전 — 환율 전일종가 기준 반영 불가',
        report_type: 'closing'
      }
    };

    const result = await callSonnet(prompt, 'closing_report');

    // 오늘 실현 손익 (trades 테이블 집계)
    const todayTrades = db.prepare(
      "SELECT trade_type, SUM(profit_loss) as total, COUNT(*) as cnt FROM trades WHERE date = ? AND trade_type IN ('sell_profit', 'sell_loss', 'switch') GROUP BY trade_type"
    ).all(today);

    const message = formatClosingReport(portfolio, sonnetCount, alertCount?.cnt || 0, cashHoldCount?.cnt || 0, result, isBeforeMonday, todayTrades);
    await sendKakao(message);

    // 시드 성장 기록 (trades 기반으로 정확한 실현손익 저장)
    saveDailySeedGrowth();

    console.log('[Closing] 마감 리포트 발송 완료');
  } catch (err) {
    console.error('[Closing] 마감 리포트 오류:', err.message);
    await sendErrorAlert('[Closing] 마감 리포트 실패: ' + err.message);
  }
}

function formatClosingReport(portfolio, sonnetCount, alertCount, cashHoldCount, ai, isBeforeMonday, todayTrades = []) {
  const today = getTodayKST();
  const serverUrl = `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}`;

  let msg = `📋 AI 트레이더 마감 결산 ${today}\n\n`;

  // ── 오늘 손익
  msg += `━━━━━━━━━━━━━━\n💰 오늘 손익\n━━━━━━━━━━━━━━\n`;
  if (portfolio.holdings && portfolio.holdings.length > 0) {
    for (const h of portfolio.holdings) {
      const pSign = (h.profitRate || 0) >= 0 ? '+' : '';
      msg += `[${h.stock_name}] ${pSign}${(h.profitRate || 0).toFixed(1)}% / ${pSign}${Math.round(h.profitLoss || 0).toLocaleString()}원\n`;
      msg += `현재가: ${(h.current_price || 0).toLocaleString()}원 / 평단: ${(h.avg_price || 0).toLocaleString()}원\n`;
      const rsiStr = h.rsi ? `RSI ${h.rsi.toFixed(0)}${h.rsi >= 70 ? '(과매수)' : h.rsi <= 30 ? '(과매도)' : ''}` : '';
      if (rsiStr) msg += `${rsiStr} / MACD: ${h.macd || '-'}\n`;
      if (h.bollingerBands) {
        msg += `BB: 상단 ${h.bollingerBands.upper.toLocaleString()} / 중단 ${h.bollingerBands.middle.toLocaleString()} / 하단 ${h.bollingerBands.lower.toLocaleString()}\n`;
      }
      if (h.foreignNet !== null && h.foreignNet !== undefined) {
        const fSign = h.foreignNet >= 0 ? '+' : '';
        const instSign = (h.institutionNet || 0) >= 0 ? '+' : '';
        const dateNote = h.investorDataDate ? (h.investorIsToday ? '(확정)' : `(전일)`) : '';
        msg += `외인: ${fSign}${h.foreignNet.toLocaleString()}주${dateNote}`;
        if (h.foreignConsecutiveDays > 0) msg += ` (${h.foreignConsecutiveDays}일 연속)`;
        msg += ` / 기관: ${instSign}${(h.institutionNet || 0).toLocaleString()}주\n`;
        if (h.foreignNet5Days != null) msg += `외인 5일 합산: ${h.foreignNet5Days >= 0 ? '+' : ''}${h.foreignNet5Days.toLocaleString()}주\n`;
      }
      if (h.trailingStop) msg += `트레일링: ${h.trailingStop.toLocaleString()}원\n`;
      msg += '\n';
    }
    const totalSign = (portfolio.overallProfitRate || 0) >= 0 ? '+' : '';
    const pnlSign = (portfolio.unrealizedPnL || 0) >= 0 ? '+' : '';
    msg += `총 평가손익: ${pnlSign}${Math.round(portfolio.unrealizedPnL || 0).toLocaleString()}원\n`;
    msg += `누적 수익률: ${totalSign}${(portfolio.overallProfitRate || 0).toFixed(1)}%\n\n`;
  } else if (todayTrades && todayTrades.length > 0) {
    // 오늘 전량 매도 — 보유종목 없음, 실현 손익으로 대체
    let netPL = 0;
    for (const t of todayTrades) netPL += (t.total || 0);
    const netSign = netPL >= 0 ? '+' : '';
    msg += `오늘 전량 매도 완료 (보유종목 없음)\n`;
    msg += `오늘 실현 손익: ${netSign}${Math.round(netPL).toLocaleString()}원\n`;
    const totalSign = (portfolio.overallProfitRate || 0) >= 0 ? '+' : '';
    msg += `누적 수익률: ${totalSign}${(portfolio.overallProfitRate || 0).toFixed(1)}%\n\n`;
  } else {
    msg += `현금 보유 중 (매매 없음)\n`;
    const totalSign = (portfolio.overallProfitRate || 0) >= 0 ? '+' : '';
    msg += `누적 수익률: ${totalSign}${(portfolio.overallProfitRate || 0).toFixed(1)}%\n\n`;
  }

  // ── AI 내일 전망
  msg += `━━━━━━━━━━━━━━\n🌍 내일 전망 및 전략\n━━━━━━━━━━━━━━\n`;
  if (ai) {
    msg += `판단: ${ai.action || '판단불가'} [신뢰도: ${ai.confidence || '?'}]\n\n`;
    msg += `${ai.reason || '-'}\n\n`;
    if (ai.why_sell_now) msg += `💰 익절 이유: ${ai.why_sell_now}\n\n`;
    if (ai.why_hold) msg += `🤚 보유 이유: ${ai.why_hold}\n\n`;
    if (ai.why_cash) msg += `💵 현금 보유 이유: ${ai.why_cash}\n\n`;
    if (ai.news_impact) msg += `📰 뉴스 영향: ${ai.news_impact}\n\n`;
    if (ai.target_price) msg += `🎯 목표가: ${ai.target_price.toLocaleString()}원\n`;
    if (ai.stop_loss) msg += `🛡 손절가: ${ai.stop_loss.toLocaleString()}원\n`;
    if (ai.target_price || ai.stop_loss) msg += '\n';
  }

  // ── 오늘 실현 손익
  if (todayTrades && todayTrades.length > 0) {
    msg += `━━━━━━━━━━━━━━\n💰 오늘 실현 손익\n━━━━━━━━━━━━━━\n`;
    let netPL = 0;
    for (const t of todayTrades) {
      const sign = (t.total || 0) >= 0 ? '+' : '';
      if (t.trade_type === 'sell_profit' || t.trade_type === 'switch') {
        msg += `익절: ${sign}${Math.round(t.total || 0).toLocaleString()}원 (${t.cnt}건)\n`;
      } else if (t.trade_type === 'sell_loss') {
        msg += `손절: ${Math.round(t.total || 0).toLocaleString()}원 (${t.cnt}건)\n`;
      }
      netPL += (t.total || 0);
    }
    const netSign = netPL >= 0 ? '+' : '';
    msg += `순 실현 손익: ${netSign}${Math.round(netPL).toLocaleString()}원\n\n`;
  }

  // ── 운영 현황
  msg += `━━━━━━━━━━━━━━\n📊 오늘 AI 운영\n━━━━━━━━━━━━━━\n`;
  msg += `Sonnet 호출: ${sonnetCount}회 / 15회\n`;
  msg += `알림 발송: ${alertCount}건\n`;
  msg += `현금 보유 판단: ${cashHoldCount}회\n\n`;

  // ── 주의사항
  if (isBeforeMonday || ai?.warning || ai?.urgency === '긴급') {
    msg += `━━━━━━━━━━━━━━\n⚠️ 주의사항\n━━━━━━━━━━━━━━\n`;
    if (isBeforeMonday) msg += `월요일: 주말 효과 하락 가능, 악재 확인 후 진입\n`;
    if (ai?.warning) msg += `${ai.warning}\n`;
    msg += '\n';
  }

  msg += `👉 ${serverUrl}`;
  return msg;
}

module.exports = { runClosingReport };
