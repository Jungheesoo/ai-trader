const { getDb } = require('../db/database');
const { getFullStockData } = require('./kis');
const { getNaverFinancePrice } = require('./naver');

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
      stockData = await getFullStockData(h.stock_code);
      if (!stockData) {
        // KIS 실패 시 네이버 백업
        const backup = await getNaverFinancePrice(h.stock_code);
        if (backup) {
          stockData = { price: backup.price, source: 'naver_backup', delayed: true };
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
      foreignNet: stockData?.investor?.foreignNet || null,
      institutionNet: stockData?.investor?.institutionNet || null,
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

function isAfternoonCutoff() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  return h > 14 || (h === 14 && m >= 30);
}

function isFridayAfternoon() {
  const now = new Date();
  return now.getDay() === 5 && isAfternoonCutoff();
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
  isFridayAfternoon
};
