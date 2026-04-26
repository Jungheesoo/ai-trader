const { getDb } = require('../db/database');
const { getFullStockData } = require('./kis');
const { getNaverFinancePrice } = require('./naver');

// KIS 연속 실패 카운터 (프롬프트 섹션 8-4)
let kisFailCount = 0;
let kisBackupMode = false;
let kisBackupAlertSent = false;

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function getTodayHoldings() {
  const db = getDb();
  const today = getToday();
  let holdings = db.prepare('SELECT * FROM holdings WHERE date = ? ORDER BY id').all(today);
  if (!holdings.length) {
    // 전일 데이터 자동 사용
    const lastDate = db.prepare('SELECT MAX(date) as d FROM holdings').get();
    if (lastDate?.d) {
      holdings = db.prepare('SELECT * FROM holdings WHERE date = ? ORDER BY id').all(lastDate.d);
    }
  }
  return holdings;
}

function saveHoldings(date, holdings) {
  const db = getDb();
  db.prepare('DELETE FROM holdings WHERE date = ?').run(date);
  const stmt = db.prepare(
    'INSERT INTO holdings (date, stock_name, stock_code, quantity, avg_price) VALUES (?, ?, ?, ?, ?)'
  );
  for (const h of holdings) {
    stmt.run(date, h.stock_name, h.stock_code || null, h.quantity, h.avg_price);
  }
}

function getPortfolioInput(date) {
  const db = getDb();
  return db.prepare('SELECT * FROM portfolio_input WHERE date = ?').get(date);
}

function savePortfolioInput(date, cash, newInvestment) {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO portfolio_input (date, cash, new_investment, updated_at) VALUES (?, ?, ?, ?)'
  ).run(date, cash, newInvestment, new Date().toISOString());
}

async function enrichHoldingsWithPrices(holdings) {
  const enriched = [];
  for (const h of holdings) {
    let stockData = null;
    if (h.stock_code) {
      // KIS 백업모드가 아니면 먼저 KIS 시도
      if (!kisBackupMode) {
        stockData = await getFullStockData(h.stock_code);
      }

      if (!stockData) {
        kisFailCount++;
        if (!kisBackupMode) {
          kisBackupMode = true;
          if (!kisBackupAlertSent) {
            kisBackupAlertSent = true;
            try {
              const { sendErrorAlert } = require('./alert');
              await sendErrorAlert('⚠️ [KIS API 장애] 한국투자증권 API 실패. 네이버 금융 데이터로 자동 전환합니다.');
            } catch (e) { /* silent */ }
          }
        }
        // 네이버 백업
        const backup = await getNaverFinancePrice(h.stock_code);
        if (backup) {
          stockData = { price: backup.price, source: 'naver_backup', delayed: true };
        }
      } else {
        kisFailCount = 0;
        if (kisBackupMode) {
          kisBackupMode = false;
          kisBackupAlertSent = false;
        }
      }
    }

    const currentPrice = stockData?.price || h.current_price || h.avg_price;
    const profitLoss = (currentPrice - h.avg_price) * h.quantity;
    const profitLossRate = ((currentPrice - h.avg_price) / h.avg_price) * 100;

    enriched.push({
      ...h,
      current_price: currentPrice,
      profit_loss: Math.round(profitLoss),
      profit_loss_rate: Math.round(profitLossRate * 100) / 100,
      stock_value: Math.round(currentPrice * h.quantity),
      rsi: stockData?.rsi || null,
      macd: stockData?.macd?.crossover || null,
      macdLine: stockData?.macd?.macdLine || null,
      volumeRatio: stockData?.volumeRatio || null,
      trailingStop: stockData?.trailingStop || null,
      foreignNet: stockData?.investor?.foreignNet ?? null,
      institutionNet: stockData?.investor?.institutionNet ?? null,
      changeRate: stockData?.changeRate || null,
      isBackup: stockData?.source === 'naver_backup',
      isDelayed: stockData?.delayed || false
    });
  }
  return enriched;
}

function calcTotalAssets(enrichedHoldings, input) {
  const stockValue = enrichedHoldings.reduce((sum, h) => sum + (h.stock_value || 0), 0);
  const cash = input?.cash || 0;
  const newInvestment = input?.new_investment || 0;
  return {
    stockValue,
    cash,
    newInvestment,
    total: stockValue + cash + newInvestment
  };
}

function calcOpportunityCost(currentHolding, candidateStock) {
  if (!currentHolding || !candidateStock) return null;
  const currentUpside = currentHolding.target_price
    ? ((currentHolding.target_price - currentHolding.current_price) / currentHolding.current_price) * 100
    : null;
  const candidateUpside = candidateStock.target_price
    ? ((candidateStock.target_price - candidateStock.price) / candidateStock.price) * 100
    : null;
  if (currentUpside === null || candidateUpside === null) return null;
  return {
    currentUpside: Math.round(currentUpside * 100) / 100,
    candidateUpside: Math.round(candidateUpside * 100) / 100,
    ratio: Math.round((candidateUpside / currentUpside) * 100) / 100,
    shouldSwitch: candidateUpside >= currentUpside * 2
  };
}

function getMinutesUntilClose() {
  const now = new Date();
  const close = new Date();
  close.setHours(15, 30, 0, 0);
  return Math.max(0, Math.round((close - now) / 60000));
}

// 프롬프트 섹션 9-2: 장 마감 1시간 이내 = 오후 2시 30분 이후 신규 진입 자제
// 프롬프트 섹션 10: 금요일 오후 2시 이후 신규 진입 자제
function isAfternoonCutoff() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  // 오후 2시(14:00) 이후 = 금요일 신규 진입 자제 기준
  return h >= 14;
}

function isOneHourBeforeClose() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  // 오후 2시 30분(14:30) 이후 = 장 마감 1시간 이내
  return h > 14 || (h === 14 && m >= 30);
}

function isFridayAfternoon() {
  const now = new Date();
  return now.getDay() === 5 && isAfternoonCutoff();
}

async function getPortfolioSummary() {
  const db = getDb();
  const today = getToday();

  const holdings = getTodayHoldings();
  const input = getPortfolioInput(today) || { cash: 0, new_investment: 0 };
  const enriched = await enrichHoldingsWithPrices(holdings);
  const assets = calcTotalAssets(enriched, input);

  // 최근 AI 분석
  const latestAnalysis = db.prepare(
    "SELECT * FROM analysis WHERE date = ? ORDER BY created_at DESC LIMIT 1"
  ).get(today);

  // 각 종목에 마지막 AI 액션 붙이기
  const holdingsWithAction = enriched.map(h => {
    const lastAnalysis = db.prepare(
      "SELECT action, reason FROM analysis WHERE date = ? AND stock_name LIKE ? ORDER BY created_at DESC LIMIT 1"
    ).get(today, `%${h.stock_name}%`);
    return {
      ...h,
      profitLoss: h.profit_loss,
      profitRate: h.profit_loss_rate,
      lastAction: lastAnalysis?.action || null,
      lastReason: lastAnalysis?.reason?.slice(0, 40) || null
    };
  });

  return {
    holdings: holdingsWithAction,
    stockValue: assets.stockValue,
    cash: assets.cash,
    newInvestment: assets.newInvestment,
    totalAssets: assets.total,
    overallProfitRate: enriched.length > 0
      ? enriched.reduce((sum, h) => sum + (h.profit_loss || 0), 0) /
        Math.max(1, enriched.reduce((sum, h) => sum + h.avg_price * h.quantity, 0)) * 100
      : 0,
    unrealizedPnL: enriched.reduce((sum, h) => sum + (h.profit_loss || 0), 0),
    latestAnalysis,
    nightIssue: null
  };
}

module.exports = {
  getTodayHoldings,
  saveHoldings,
  getPortfolioInput,
  savePortfolioInput,
  enrichHoldingsWithPrices,
  calcTotalAssets,
  calcOpportunityCost,
  getMinutesUntilClose,
  isAfternoonCutoff,
  isOneHourBeforeClose,
  isFridayAfternoon,
  getPortfolioSummary
};
