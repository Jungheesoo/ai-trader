require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getTodayKST, nowKST } = require('./dateutil');

const BASE_URL = process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
const TOKEN_FILE = path.resolve(__dirname, '../../data/kis_token.json');

let kisToken = null;
let tokenExpiry = 0;
let isRefreshing = false;
let nextRetryAt = 0;

function loadTokenFromFile() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return;
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (data.access_token && data.expires_at && Date.now() < data.expires_at) {
      kisToken = data.access_token;
      tokenExpiry = data.expires_at;
      console.log('[KIS] 파일에서 토큰 로드 성공 (만료까지', Math.round((tokenExpiry - Date.now()) / 60000), '분)');
    }
  } catch {
    // 파일 읽기 실패 시 무시하고 새로 발급
  }
}

function saveTokenToFile(token, expiresAt) {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token: token, expires_at: expiresAt }), 'utf8');
  } catch {
    // 저장 실패해도 메모리 토큰으로 계속 동작
  }
}

loadTokenFromFile();

async function getToken() {
  // 메모리 토큰 유효하면 바로 반환
  if (kisToken && Date.now() < tokenExpiry) return kisToken;

  // 60초 내 실패한 적 있으면 대기
  if (Date.now() < nextRetryAt) {
    console.warn('[KIS] 토큰 발급 대기 중 (', Math.round((nextRetryAt - Date.now()) / 1000), '초 후 재시도)');
    return null;
  }

  // 중복 발급 방지
  if (isRefreshing) {
    await new Promise(r => setTimeout(r, 2000));
    return kisToken;
  }

  isRefreshing = true;
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  const baseUrl = process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
  try {
    const res = await axios.post(`${baseUrl}/oauth2/tokenP`, {
      grant_type: 'client_credentials',
      appkey: appKey,
      appsecret: appSecret
    }, {
      timeout: 10000,
      headers: {
        'content-type': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    });
    kisToken = res.data.access_token;
    tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    saveTokenToFile(kisToken, tokenExpiry);
    console.log('[KIS] 토큰 발급 성공');
    return kisToken;
  } catch (err) {
    console.error('[KIS] 토큰 발급 실패:', err.message);
    nextRetryAt = Date.now() + 60000; // 60초 후 재시도
    return null;
  } finally {
    isRefreshing = false;
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
      const status = err.response?.status;
      // 재시도 무의미한 케이스: 즉시 포기
      if (err.message === '토큰 없음') return null;
      if (status === 500 || status === 403 || status === 401) {
        console.warn(`[KIS] 서버 오류 ${status} - 재시도 생략`);
        return null;
      }
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
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET,
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
    const today = getTodayKST().replace(/-/g, '');
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
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET,
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
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET,
        tr_id: 'FHKST01010900'
      },
      timeout: 10000
    });
    const d = res.data.output;
    if (!d || !d.length) throw new Error('수급 데이터 없음');

    // 오늘 데이터(d[0]) 외인 빈값이면 전일(d[1]) 사용
    let dataRow = d[0];
    let isToday = true;
    if (!dataRow.frgn_ntby_qty || dataRow.frgn_ntby_qty.trim() === '') {
      if (d[1]) {
        dataRow = d[1];
        isToday = false;
        console.log(`[KIS] 외인/기관 전일 데이터 사용 (${dataRow.stck_bsop_date || '날짜미상'})`);
      }
    }

    const foreignNet = dataRow.frgn_ntby_qty && dataRow.frgn_ntby_qty.trim() !== ''
      ? parseInt(dataRow.frgn_ntby_qty)
      : null;
    const institutionNet = dataRow.orgn_ntby_qty && dataRow.orgn_ntby_qty.trim() !== ''
      ? parseInt(dataRow.orgn_ntby_qty)
      : null;

    // 최근 5일 외인 순매수 합산
    const foreignNet5Days = d.slice(0, 5).reduce((sum, row) => {
      const val = row.frgn_ntby_qty && row.frgn_ntby_qty.trim() !== '' ? parseInt(row.frgn_ntby_qty) : 0;
      return sum + (isNaN(val) ? 0 : val);
    }, 0);

    // 외인 연속 순매수 일수 (오늘 빈값이면 d[1]부터 계산)
    const startIdx = (!d[0].frgn_ntby_qty || d[0].frgn_ntby_qty.trim() === '') ? 1 : 0;
    let foreignConsecutiveDays = 0;
    for (let i = startIdx; i < d.length; i++) {
      const val = parseInt(d[i].frgn_ntby_qty);
      if (!isNaN(val) && val > 0) foreignConsecutiveDays++;
      else break;
    }

    // 기관 연속 순매수 일수
    let institutionConsecutiveDays = 0;
    for (let i = 0; i < d.length; i++) {
      const val = parseInt(d[i].orgn_ntby_qty);
      if (!isNaN(val) && val > 0) institutionConsecutiveDays++;
      else break;
    }

    return {
      foreignNet: foreignNet ?? null,
      institutionNet: institutionNet ?? null,
      dataDate: dataRow.stck_bsop_date || null,
      isToday,
      foreignNet5Days,
      foreignConsecutiveDays,
      institutionConsecutiveDays
    };
  });
}

function getDateBefore(days) {
  const d = nowKST();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// 기술적 지표 계산 (코드에서 직접 계산 - Claude에 계산 요청 금지)
function calculateRSI(closes, period = 14) {
  // Wilder's Smoothed RSI — 표준 HTS와 동일한 결과
  if (!closes || closes.length < period + 1) return null;

  // 첫 번째 평균 손익 (시드값)
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's 스무딩: 이후 데이터에 지수 평균 적용
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
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
  if (macdValues.length >= 2 && signal !== null) {
    const prev = macdValues[macdValues.length - 2];
    const curr = macdValues[macdValues.length - 1];
    if (prev < signal && curr >= signal) crossover = '골든크로스';
    else if (prev > signal && curr <= signal) crossover = '데드크로스';
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
