const { callSonnet } = require('../services/claude-sonnet');
const { sendTelegram } = require('../services/telegram');
const { sendErrorAlert } = require('../services/alert');
const { getPortfolioSummary } = require('../services/portfolio');
const { isWeekday } = require('../services/holiday');

async function runMondayCheck() {
  const now = new Date();
  if (now.getDay() !== 1) return; // 월요일만
  if (!isWeekday(now)) return;

  console.log('[Monday] 월요일 주말 효과 판단 시작');

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
        change_rate: h.changeRate,
        profit_rate: h.profitRate,
        rsi: h.rsi,
        macd: h.macd,
        volume_ratio: h.volumeRatio
      })),
      market_context: {
        day_of_week: '월',
        is_monday: true,
        minutes_until_close: 360,
        report_type: 'monday_check',
        note: '월요일: 주말 효과 하락 가능. 급락 시 악재 여부 먼저 확인. 악재 없는 단순 주말 효과라면 매수 기회. KOSPI 24년 통계 기반.'
      }
    };

    const result = await callSonnet(prompt, 'monday_check');

    let msg = `📋 월요일 주말 효과 판단\n\n`;

    if (portfolio.holdings && portfolio.holdings.length > 0) {
      msg += `━━━━━━━━━━━━━━\n📈 장 초반 현황\n━━━━━━━━━━━━━━\n`;
      for (const h of portfolio.holdings) {
        const pSign = (h.profitRate || 0) >= 0 ? '+' : '';
        const changeSign = (h.changeRate || 0) >= 0 ? '+' : '';
        msg += `[${h.stock_name}] 현재가: ${(h.current_price || h.avg_price).toLocaleString()}원\n`;
        msg += `오늘 등락: ${changeSign}${(h.changeRate || 0).toFixed(1)}% / 수익률: ${pSign}${(h.profitRate || 0).toFixed(1)}%\n`;
        if (h.rsi) msg += `RSI ${h.rsi.toFixed(0)} / MACD: ${h.macd || '-'}\n`;
        if (h.changeRate !== null && h.changeRate < -2) msg += `⚠️ 주말 효과 하락 감지\n`;
        msg += '\n';
      }
    }

    msg += `━━━━━━━━━━━━━━\n🤖 AI 주말 효과 판단\n━━━━━━━━━━━━━━\n`;
    if (result) {
      msg += `판단: ${result.action || '판단불가'} [신뢰도: ${result.confidence || '?'}]\n\n`;
      msg += `${result.reason || '-'}\n\n`;
      if (result.why_sell_now) msg += `💰 익절 권고 이유:\n${result.why_sell_now}\n\n`;
      if (result.why_hold) msg += `🤚 보유 유지 이유:\n${result.why_hold}\n\n`;
      if (result.why_cash) msg += `💵 현금 보유 이유:\n${result.why_cash}\n\n`;
      if (result.news_impact) msg += `📰 뉴스 영향: ${result.news_impact}\n\n`;
      if (result.cash_recommendation === '재투자') {
        msg += `→ 단순 주말 효과로 판단: 악재 없으면 매수 기회\n`;
      } else if (result.cash_recommendation === '현금보유') {
        msg += `→ 악재 가능성 있음: 현금 보유 권장\n`;
      }
      if (result.warning) msg += `⚠️ ${result.warning}\n`;
    } else {
      msg += `AI 분석 불가 — 장 초반 악재 여부 직접 확인 권장\n`;
    }
    msg += `\n👉 ${serverUrl}`;

    await sendTelegram(msg);
    console.log('[Monday] 월요일 주말 효과 판단 발송 완료');
  } catch (err) {
    console.error('[Monday] 월요일 점검 오류:', err.message);
    await sendErrorAlert('[Monday] 월요일 주말 효과 판단 실패: ' + err.message);
  }
}

module.exports = { runMondayCheck };
