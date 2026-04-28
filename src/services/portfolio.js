const { getDb } = require('../db/database');
const { getFullStockData, isKisDown } = require('./kis');
const { getNaverFinancePrice } = require('./naver');
const { getTodayKST } = require('./dateutil');
const { getMarketStatus } = require('../utils/market');


function getToday() {
  return getTodayKST();
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
  const db = getDb();
  const today = getToday();
  const marketStatus = getMarketStatus(); // regular / pre / after / break / closed
  const shouldCallKIS = marketStatus !== 'closed';
  const enriched = [];

  for (const h of holdings) {
    let stockData = null;

    if (h.stock_code) {
      if (shouldCallKIS) {
        // 정규장 + 프리마켓 + 애프터마켓: KIS 호출
        if (!isKisDown()) {
          stockData = await getFullStockData(h.stock_code);
        }
        if (!stockData) {
          if (!isKisDown()) console.warn(`[Portfolio] KIS 실패(${h.stock_code}) → 네이버 백업`);
          const backup = await getNaverFinancePrice(h.stock_code);
          if (backup) {
            stockData = { price: backup.price, source: 'naver_backup', delayed: true };
          }
        }
      } else {
        // 완전 휴장(18:00~08:00, 주말): KIS/네이버 호출 없이 DB 저장값 사용
        console.log(`[Portfolio] 휴장(${marketStatus}) → ${h.stock_code} KIS 호출 스킵, DB 저장값 사용`);
      }
    }

    const currentPrice = stockData?.price || h.current_price || h.avg_price;
    const profitLoss = (currentPrice - h.avg_price) * h.quantity;
    const profitLossRate = ((currentPrice - h.avg_price) / h.avg_price) * 100;

    // KIS 호출 성공 시 현재가 DB 즉시 업데이트 (정규장 + 프리/애프터마켓 포함)
    if (shouldCallKIS && stockData?.price && h.stock_code) {
      try {
        db.prepare(
          'UPDATE holdings SET current_price = ?, profit_loss = ?, profit_loss_rate = ? WHERE date = ? AND stock_code = ?'
        ).run(stockData.price, Math.round(profitLoss), Math.round(profitLossRate * 100) / 100, today, h.stock_code);
      } catch (e) { /* DB 업데이트 실패 무시 */ }
    }

    // DB에 저장된 과거 현재가 중 최고가로 트레일링 스탑 계산
    const dbHighPrice = db.prepare(
      'SELECT MAX(current_price) as high FROM holdings WHERE stock_code = ? AND current_price IS NOT NULL'
    ).get(h.stock_code)?.high || null;
    const trailingStopBase = dbHighPrice
      ? Math.max(dbHighPrice, currentPrice)
      : (stockData?.week52High || currentPrice);
    const trailingStopDb = Math.round(trailingStopBase * 0.93);

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
      trailingStop: trailingStopDb,
      bollingerBands: stockData?.bollingerBands ?? null,
      week52High: stockData?.week52High ?? null,
      week52Low: stockData?.week52Low ?? null,
      isNear52High: stockData?.isNear52High ?? false,
      isNear52Low: stockData?.isNear52Low ?? false,
      foreignNet: stockData?.investor?.foreignNet ?? null,
      foreignNetAmount: stockData?.investor?.foreignNetAmount ?? null,
      institutionNet: stockData?.investor?.institutionNet ?? null,
      foreignNet5Days: stockData?.investor?.foreignNet5Days ?? null,
      foreignConsecutiveDays: stockData?.investor?.foreignConsecutiveDays ?? null,
      institutionConsecutiveDays: stockData?.investor?.institutionConsecutiveDays ?? null,
      investorDataDate: stockData?.investor?.dataDate ?? null,
      investorIsToday: stockData?.investor?.isToday ?? null,
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
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.getUTCHours() >= 14;
}

function isOneHourBeforeClose() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  return h > 14 || (h === 14 && m >= 30);
}

function isFridayAfternoon() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.getUTCDay() === 5 && isAfternoonCutoff();
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

function saveDailySeedGrowth() {
  const db = getDb();
  const today = getToday();

  const realizedResult = db.prepare(
    "SELECT COALESCE(SUM(profit_loss), 0) as total FROM trades WHERE date = ? AND trade_type IN ('sell_profit', 'sell_loss', 'switch')"
  ).get(today);

  const holdingsRow = db.prepare(
    'SELECT SUM(current_price * quantity) as stockValue FROM holdings WHERE date = ?'
  ).get(today);

  const cashData = db.prepare(
    'SELECT COALESCE(cash, 0) as cash FROM portfolio_input WHERE date = ? ORDER BY id DESC LIMIT 1'
  ).get(today);

  const newInvestmentData = db.prepare(
    'SELECT COALESCE(new_investment, 0) as new_investment FROM portfolio_input WHERE date = ? ORDER BY id DESC LIMIT 1'
  ).get(today);

  const stockValue = holdingsRow?.stockValue || 0;
  const cash = cashData?.cash || 0;
  const newInvestment = newInvestmentData?.new_investment || 0;
  const totalAssets = stockValue + cash + newInvestment;
  const realizedPL = realizedResult?.total || 0;

  const yesterday = db.prepare(
    'SELECT total_assets FROM seed_growth ORDER BY date DESC LIMIT 1'
  ).get();

  const dailyPL = yesterday ? totalAssets - yesterday.total_assets : 0;
  const dailyPLRate = yesterday && yesterday.total_assets > 0
    ? (dailyPL / yesterday.total_assets * 100)
    : 0;

  const sellCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM trades WHERE date = ? AND trade_type IN ('sell_profit', 'sell_loss', 'switch')"
  ).get(today)?.cnt || 0;

  const cashHoldCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM analysis WHERE date = ? AND cash_recommendation = '현금보유'"
  ).get(today)?.cnt || 0;

  db.prepare(
    `INSERT OR REPLACE INTO seed_growth (date, total_assets, stock_value, cash, daily_profit_loss, daily_profit_loss_rate, realized_profit, sell_count, cash_hold_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(today, totalAssets, stockValue, cash, dailyPL, Math.round(dailyPLRate * 100) / 100, realizedPL, sellCount, cashHoldCount);

  console.log(`[SeedGrowth] 저장 완료: ${totalAssets.toLocaleString()}원 (주식 ${stockValue.toLocaleString()}원 + 현금 ${cash.toLocaleString()}원 + 신규 ${newInvestment.toLocaleString()}원, 실현손익: ${realizedPL.toLocaleString()}원)`);
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
  getPortfolioSummary,
  saveDailySeedGrowth
};
