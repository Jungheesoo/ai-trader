const { callSonnet } = require('../services/claude-sonnet');
const { sendKakao } = require('../services/kakao');
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

    let msg = `📋 [금요일 주말 점검]\n\n`;
    if (result) {
      msg += `시장 상황: ${result.reason || '-'}\n`;
      msg += `→ ${result.action || '판단불가'}\n`;
      if (result.cash_recommendation === '현금보유') {
        msg += `→ 오후 신규 진입 자제 추천\n`;
      } else if (result.cash_recommendation === '재투자') {
        msg += `→ 보유 유지 추천\n`;
      }
      msg += `→ 월요일 진입 전략: 주말 악재 확인 후 판단\n`;
      if (result.warning) msg += `⚠️ ${result.warning}\n`;
    } else {
      msg += `AI 분석 불가 - 주말 리스크 고려 현금 보유 검토 권장\n`;
    }
    msg += `\n👉 ${serverUrl}`;

    await sendKakao(msg);
    console.log('[Friday] 금요일 특별 점검 발송 완료');
  } catch (err) {
    console.error('[Friday] 금요일 점검 오류:', err.message);
    await sendErrorAlert('[Friday] 금요일 특별 점검 실패: ' + err.message);
  }
}

module.exports = { runFridayCheck };
