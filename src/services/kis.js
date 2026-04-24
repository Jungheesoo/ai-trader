require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
const APP_KEY = process.env.KIS_APP_KEY;
const APP_SECRET = process.env.KIS_APP_SECRET;

let kisToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (kisToken && Date.now() < tokenExpiry) return kisToken;
  try {
    const res = await axios.post(`${BASE_URL}/oauth2/tokenP`, {
      grant_type: 'client_credentials',
      appkey: APP_KEY,
      appsecret: APP_SECRET
    }, { timeout: 10000 });
    kisToken = res.data.access_token;
    tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    return kisToken;
  } catch (err) {
    console.error('[KIS] 토큰 발급 실패:', err.message);
    return null;
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestWithRetry(fn, retries = 3) {
  const delays = [5000, 10000, 30000];
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      console.error(`[KIS] 요청 실패 (${i + 1}/${retries}):`, err.message);
      if (i < retries - 1) await delay(delays[i]);
    }
  }
  return null;
}

async function getCurrentPrice(stockCode) {
  return requestWithRetry(async () => {
    const token = await getToken();
    if (!token) throw new Error('토큰 없음');
    await delay(100);
    const res = await axios.get(`${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price`, {
      params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: stockCode },
      headers: {
        Authorization: `Bearer ${token}`,
        appkey: APP_KEY,
        appsecret: APP_SECRET,
        tr_id: 'FHKST01010100'
      },
      timeout: 10000
    });
    const d = res.data.output;
    if (!d) throw new Error('데이터 없음');
    const price = parseFloat(d.stck_prpr);
    if (!price || price < 0 || isNaN(price)) throw new Error('유효하지 않은 주가');
    return {
      stockCode,
      price,
      change: parseFloat(d.prdy_vrss),
      changeRate: parseFloat(d.prdy_ctrt),
      volume: parseInt(d.acml_vol),
      highPrice: parseFloat(d.stck_hgpr),
      lowPrice: parseFloat(d.stck_lwpr)
    };
  });
}

async function getDailyChart(stockCode, days = 60) {
  return requestWithRetry(async () => {
    const token = await getToken();
    if (!token) throw new Error('토큰 없음');
    await delay(100);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const res = await axios.get(`${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`, {
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: stockCode,
        FID_INPUT_DATE_1: getDateBefore(days),
        FID_INPUT_DATE_2: today,
        FID_PERIOD_DIV_CODE: 'D',
        FID_ORG_ADJ_PRC: '0'
      },
      headers: {
        Authorization: `Bearer ${token}`,
        appkey: APP_KEY,
        appsecret: APP_SECRET,
        tr_id: 'FHKST03010100'
      },
      timeout: 15000
    });
    return (res.data.output2 || []).map(d => ({
      date: d.stck_bsop_date,
      close: parseFloat(d.stck_clpr),
      open: parseFloat(d.stck_oprc),
      high: parseFloat(d.stck_hgpr),
      low: parseFloat(d.stck_lwpr),
      volume: parseInt(d.acml_vol)
    })).filter(d => d.close > 0);
  });
}

async function getInvestorData(stockCode) {
  return requestWithRetry(async () => {
    const token = await getToken();
    if (!token) throw new Error('토큰 없음');
    await delay(100);
    const res = await axios.get(`${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-investor`, {
      params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: stockCode },
      headers: {
        Authorization: `Bearer ${token}`,
        appkey: APP_KEY,
        appsecret: APP_SECRET,
        tr_id: 'FHKST01010900'
      },
      timeout: 10000
    });
    const d = res.data.output;
    if (!d || !d.length) throw new Error('수급 데이터 없음');
    const latest = d[0];
    return {
      foreignNet: parseInt(latest.frgn_ntby_qty) || 0,
      institutionNet: parseInt(latest.orgn_ntby_qty) || 0
    };
  });
}

function getDateBefore(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// 기술적 지표 계산 (코드에서 직접 계산 - Claude에 계산 요청 금지)
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return Math.round(100 - (100 / (1 + rs)));
}

function calculateEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateMACD(closes) {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  if (ema12 === null || ema26 === null) return null;
  const macdLine = ema12 - ema26;

  // Signal line (9-period EMA of MACD)
  const macdValues = [];
  for (let i = 26; i <= closes.length; i++) {
    const e12 = calculateEMA(closes.slice(0, i), 12);
    const e26 = calculateEMA(closes.slice(0, i), 26);
    if (e12 && e26) macdValues.push(e12 - e26);
  }
  const signal = calculateEMA(macdValues, 9);

  let crossover = '없음';
  if (macdValues.length >= 2) {
    const prev = macdValues[macdValues.length - 2];
    const curr = macdValues[macdValues.length - 1];
    if (prev < (signal || 0) && curr >= (signal || 0)) crossover = '골든크로스';
    else if (prev > (signal || 0) && curr <= (signal || 0)) crossover = '데드크로스';
    else if (curr > 0) crossover = '상승중';
    else crossover = '하락중';
  }
  return { macdLine: Math.round(macdLine * 100) / 100, signal: signal ? Math.round(signal * 100) / 100 : null, crossover };
}

function calculateBollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  const recent = closes.slice(-period);
  const sma = recent.reduce((a, b) => a + b, 0) / period;
  const variance = recent.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: Math.round(sma + stdDev * std),
    middle: Math.round(sma),
    lower: Math.round(sma - stdDev * std)
  };
}

function calculateVolumeRatio(volumes, period = 20) {
  if (volumes.length < period + 1) return null;
  const avgVolume = volumes.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  if (avgVolume === 0) return null;
  return Math.round((volumes[volumes.length - 1] / avgVolume) * 100) / 100;
}

function calculateTrailingStop(closes, currentPrice, rate = 0.07) {
  const highPrice = Math.max(...closes.slice(-20), currentPrice);
  return Math.round(highPrice * (1 - rate));
}

async function getFullStockData(stockCode) {
  const [priceData, chartData, investorData] = await Promise.all([
    getCurrentPrice(stockCode),
    getDailyChart(stockCode, 60),
    getInvestorData(stockCode)
  ]);

  if (!priceData || !chartData || chartData.length < 20) return null;

  const closes = chartData.map(d => d.close);
  const volumes = chartData.map(d => d.volume);

  const rsi = calculateRSI(closes);
  const macd = calculateMACD(closes);
  const bb = calculateBollingerBands(closes);
  const volumeRatio = calculateVolumeRatio(volumes);
  const trailingStop = calculateTrailingStop(closes, priceData.price);

  return {
    ...priceData,
    rsi,
    macd,
    bollingerBands: bb,
    volumeRatio,
    trailingStop,
    investor: investorData,
    chartData: chartData.slice(-5)
  };
}

module.exports = {
  getCurrentPrice,
  getDailyChart,
  getInvestorData,
  getFullStockData,
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateVolumeRatio,
  calculateTrailingStop
};
