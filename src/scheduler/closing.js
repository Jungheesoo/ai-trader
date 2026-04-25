const { getDb } = require('../db/database');
const { callSonnet } = require('../services/claude-sonnet');
const { sendKakao } = require('../services/kakao');
const { isWeekday } = require('../services/holiday');
const { sendErrorAlert } = require('../services/alert');
const { getPortfolioSummary } = require('../services/portfolio');

async function runClosingReport() {
  if (!isWeekday(new Date())) return;
  console.log('[Closing] 마감 리포트 시작');

  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
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

    const dayOfWeek = new Date().getDay();
    const isTomorrow = dayOfWeek === 5 ? '월' : ['일', '월', '화', '수', '목', '금', '토'][dayOfWeek + 1 > 6 ? 0 : dayOfWeek + 1];
    const isBeforeMonday = dayOfWeek === 5; // 금요일이면 다음날 월요일

    const prompt = {
      portfolio_summary: {
        total_assets: portfolio.totalAssets,
        stock_value: portfolio.stockValue,
        cash: portfolio.cash,
        overall_profit_rate: portfolio.overallProfitRate
      },
      holdings: portfolio.holdings.map(h => ({
        stock_name: h.stock_name,
        current_price: h.current_price,
        profit_rate: h.profitRate,
        profit_loss: h.profitLoss,
        rsi: h.rsi,
        macd: h.macd
      })),
      today_stats: {
        sonnet_calls: sonnetCount,
        alert_count: alertCount?.cnt || 0,
        cash_hold_count: cashHoldCount?.cnt || 0
      },
      market_context: {
        day_of_week: ['일', '월', '화', '수', '목', '금', '토'][dayOfWeek],
        is_before_monday: isBeforeMonday,
        report_type: 'closing'
      }
    };

    const result = await callSonnet(prompt, 'closing_report');

    const message = formatClosingReport(portfolio, sonnetCount, alertCount?.cnt || 0, cashHoldCount?.cnt || 0, result, isBeforeMonday);
    await sendKakao(message);

    // 시드 성장 기록
    const realized = db.prepare(
      "SELECT SUM(profit_loss) as total FROM analysis WHERE date = ? AND action LIKE '%매도%'"
    ).get(today);

    const seedStmt = db.prepare(
      `INSERT OR REPLACE INTO seed_growth (date, total_assets, stock_value, cash, daily_profit_loss, daily_profit_loss_rate, realized_profit, sell_count, cash_hold_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    seedStmt.run(
      today,
      portfolio.totalAssets,
      portfolio.stockValue,
      portfolio.cash,
      portfolio.unrealizedPnL || 0,
      portfolio.overallProfitRate || 0,
      realized?.total || 0,
      db.prepare("SELECT COUNT(*) as cnt FROM analysis WHERE date = ? AND action LIKE '%매도%'").get(today)?.cnt || 0,
      cashHoldCount?.cnt || 0
    );

    console.log('[Closing] 마감 리포트 발송 완료');
  } catch (err) {
    console.error('[Closing] 마감 리포트 오류:', err.message);
    await sendErrorAlert('[Closing] 마감 리포트 실패: ' + err.message);
  }
}

function formatClosingReport(portfolio, sonnetCount, alertCount, cashHoldCount, ai, isBeforeMonday) {
  const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\. /g, '.').replace('.', '');
  const serverUrl = `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}`;

  let msg = `📋 오늘 결산 ${today}\n\n`;
  msg += `━━━━━━━━━━━━━━\n💰 오늘 손익\n━━━━━━━━━━━━━━\n`;

  if (portfolio.holdings && portfolio.holdings.length > 0) {
    for (const h of portfolio.holdings) {
      const pSign = (h.profitRate || 0) >= 0 ? '+' : '';
      msg += `${h.stock_name}: ${pSign}${(h.profitRate || 0).toFixed(1)}% (${pSign}${Math.round(h.profitLoss || 0).toLocaleString()}원)\n`;
    }
  }

  const totalSign = (portfolio.overallProfitRate || 0) >= 0 ? '+' : '';
  msg += `총 평가손익: ${totalSign}${Math.round(portfolio.unrealizedPnL || 0).toLocaleString()}원\n`;
  msg += `누적 수익: ${totalSign}${(portfolio.overallProfitRate || 0).toFixed(1)}%\n\n`;

  msg += `━━━━━━━━━━━━━━\n📊 AI 운영 현황\n━━━━━━━━━━━━━━\n`;
  msg += `Sonnet: ${sonnetCount}회 / 15회\n`;
  msg += `알림: ${alertCount}건\n`;
  msg += `현금 보유 판단: ${cashHoldCount}회\n\n`;

  msg += `━━━━━━━━━━━━━━\n🌍 내일 전망\n━━━━━━━━━━━━━━\n`;
  if (ai) {
    msg += `${ai.reason || '-'}\n`;
    msg += `내일 전략: ${ai.action || '판단불가'}\n`;
  }
  if (isBeforeMonday) {
    msg += `⚠️ 월요일: 주말 효과 하락 가능, 악재 확인 후 진입\n`;
  }
  if (ai?.warning) msg += `⚠️ ${ai.warning}\n`;

  msg += `\n👉 ${serverUrl}`;
  return msg;
}

module.exports = { runClosingReport };
