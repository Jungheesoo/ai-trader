const { getDb } = require('../db/database');
const { runAnalysisPipeline } = require('../services/analyzer');
const { isWeekday, isTradingHours } = require('../services/holiday');
const { sendErrorAlert } = require('../services/alert');
const { getPortfolioSummary } = require('../services/portfolio');

let isRunning = false;

async function runMonitor() {
  if (!isWeekday(new Date())) return;
  if (!isTradingHours(new Date())) return;
  if (isRunning) {
    console.warn('[Monitor] 이전 모니터링 진행 중 - 스킵');
    return;
  }

  isRunning = true;
  const timeout = setTimeout(() => { isRunning = false; }, 10 * 60 * 1000);

  try {
    console.log('[Monitor] 장 중 모니터링 시작');
    const portfolio = await getPortfolioSummary();

    if (!portfolio.holdings || portfolio.holdings.length === 0) {
      console.log('[Monitor] 보유 종목 없음 - 스킵');
      return;
    }

    await runAnalysisPipeline(portfolio);
    console.log('[Monitor] 모니터링 완료');
  } catch (err) {
    console.error('[Monitor] 모니터링 오류:', err.message);
    await sendErrorAlert('[Monitor] 장 중 모니터링 실패: ' + err.message);
  } finally {
    clearTimeout(timeout);
    isRunning = false;
  }
}

module.exports = { runMonitor };
