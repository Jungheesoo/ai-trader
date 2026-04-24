const { callSonnet } = require('../services/claude-sonnet');
const { sendKakao } = require('../services/kakao');
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

    let msg = `📋 [월요일 주말 효과 판단]\n\n`;

    if (portfolio.holdings && portfolio.holdings.length > 0) {
      for (const h of portfolio.holdings) {
        if (h.changeRate !== null && h.changeRate < -2) {
          msg += `⚠️ ${h.stock_name}: ${h.changeRate.toFixed(1)}% 하락\n`;
        }
      }
    }

    if (result) {
      msg += `판단: ${result.reason || '-'}\n`;
      msg += `→ ${result.action || '판단불가'}\n`;
      if (result.cash_recommendation === '재투자') {
        msg += `→ 단순 주말 효과 판단: 매수 기회 검토\n`;
      } else {
        msg += `→ 악재 확인 필요: 현금 보유 권장\n`;
      }
      if (result.warning) msg += `⚠️ ${result.warning}\n`;
    } else {
      msg += `AI 분석 불가 - 장 초반 악재 여부 직접 확인 권장\n`;
    }
    msg += `\n👉 ${serverUrl}`;

    await sendKakao(msg);
    console.log('[Monday] 월요일 주말 효과 판단 발송 완료');
  } catch (err) {
    console.error('[Monday] 월요일 점검 오류:', err.message);
    await sendErrorAlert('[Monday] 월요일 주말 효과 판단 실패: ' + err.message);
  }
}

module.exports = { runMondayCheck };
