const { callSonnet } = require('../services/claude-sonnet');
const { sendTelegram } = require('../services/telegram');
const { sendErrorAlert } = require('../services/alert');
const { getPortfolioSummary } = require('../services/portfolio');

async function runFridayCheck() {
  const now = new Date();
  if (now.getDay() !== 5) return; // 금요일만

  console.log('[Friday] 금요일 주말 특별 점검 시작');

  try {
    const portfolio = await getPortfolioSummary();
    const serverUrl = `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}`;

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
        rsi: h.rsi,
        macd: h.macd,
        volume_ratio: h.volumeRatio,
        foreign_net: h.foreignNet,
        institution_net: h.institutionNet
      })),
      market_context: {
        day_of_week: '금',
        is_friday: true,
        minutes_until_close: 120,
        report_type: 'friday_special',
        note: '금요일 오후: 주말 리스크 판단. 오후 2시 이후 신규 진입 자제. 금요일 오후 약세 통계적 근거 있음.'
      }
    };

    const result = await callSonnet(prompt, 'friday_check');

    let msg = `📋 금요일 주말 점검\n\n`;

    if (portfolio.holdings && portfolio.holdings.length > 0) {
      msg += `━━━━━━━━━━━━━━\n📈 현재 종목 현황\n━━━━━━━━━━━━━━\n`;
      for (const h of portfolio.holdings) {
        const pSign = (h.profitRate || 0) >= 0 ? '+' : '';
        msg += `[${h.stock_name}] ${pSign}${(h.profitRate || 0).toFixed(1)}% / ${(h.current_price || h.avg_price).toLocaleString()}원\n`;
        if (h.rsi) msg += `RSI ${h.rsi.toFixed(0)}${h.rsi >= 70 ? '(과매수⚠️)' : ''} / MACD: ${h.macd || '-'}\n`;
      }
      msg += '\n';
    }

    msg += `━━━━━━━━━━━━━━\n🤖 AI 주말 리스크 판단\n━━━━━━━━━━━━━━\n`;
    if (result) {
      msg += `판단: ${result.action || '판단불가'} [신뢰도: ${result.confidence || '?'}]\n\n`;
      msg += `${result.reason || '-'}\n\n`;
      if (result.why_sell_now) msg += `💰 익절 권고 이유:\n${result.why_sell_now}\n\n`;
      if (result.why_hold) msg += `🤚 보유 유지 이유:\n${result.why_hold}\n\n`;
      if (result.why_cash) msg += `💵 현금 보유 이유:\n${result.why_cash}\n\n`;
      if (result.news_impact) msg += `📰 뉴스 영향: ${result.news_impact}\n\n`;
      if (result.target_price) msg += `🎯 목표가: ${result.target_price.toLocaleString()}원\n`;
      if (result.stop_loss) msg += `🛡 손절가: ${result.stop_loss.toLocaleString()}원\n`;
      if (result.target_price || result.stop_loss) msg += '\n';
    } else {
      msg += `AI 분석 불가 — 주말 리스크 고려 현금 보유 검토 권장\n\n`;
    }

    msg += `━━━━━━━━━━━━━━\n⚠️ 주의사항\n━━━━━━━━━━━━━━\n`;
    msg += `오늘 금요일: 오후 2시 이후 신규 진입 자제\n`;
    msg += `월요일: 주말 악재 확인 후 진입 판단\n`;
    if (result?.warning) msg += `${result.warning}\n`;
    msg += `\n👉 ${serverUrl}`;

    await sendTelegram(msg);
    console.log('[Friday] 금요일 특별 점검 발송 완료');
  } catch (err) {
    console.error('[Friday] 금요일 점검 오류:', err.message);
    await sendErrorAlert('[Friday] 금요일 특별 점검 실패: ' + err.message);
  }
}

module.exports = { runFridayCheck };
