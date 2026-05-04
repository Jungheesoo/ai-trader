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

// KIS 500 연속 실패 추적 → 자동 복귀
let kisErrorCount = 0;     // 전역 누적 카운터 (PM2 재시작 전까지 유지)
let kisFailCount = 0;
let kisDownSince = null;
let kisRecoveryAt = null;
let kisDownAlerted = false;

// 종목별 마지막 성공 데이터 캐시 (KIS 실패 시 fallback용)
const lastSuccessCache = {};

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
  // 30분 fallback 중이면 KIS 호출 차단
  if (kisRecoveryAt && Date.now() < kisRecoveryAt) {
    return null;
  }

  // 500 재시도 간격: 30초 → 60초 → 120초
  const retryDelays500 = [30000, 60000, 120000];
  // 일반 오류 재시도 간격: 5초 → 10초 → 30초
  const retryDelaysGeneral = [5000, 10000, 30000];

  for (let i = 0; i < retries; i++) {
    try {
      const result = await fn();
      // 성공 시 장애 카운터 초기화 및 복구 알림
      if (kisDownSince) {
        console.log('[KIS] API 정상 복구');
        try {
          const { sendTelegram } = require('./telegram');
          await sendTelegram('✅ KIS API 정상 복구되었습니다. 실시간 데이터 재개.', 'system', 'kis_recovery', false);
        } catch (e) { /* silent */ }
      }
      kisErrorCount = 0;
      kisFailCount = 0;
      kisDownSince = null;
      kisRecoveryAt = null;
      kisDownAlerted = false;
      return result;
    } catch (err) {
      const status = err.response?.status;
      if (err.message === '토큰 없음') return null;
      if (status === 401 || status === 403) {
        console.warn(`[KIS] 인증 오류 ${status} - 재시도 생략`);
        return null;
      }
      if (status === 500) {
        kisFailCount++;
        kisErrorCount++;
        console.warn(`[KIS] 서버 오류 500 (${i + 1}/${retries}회, 누적 ${kisErrorCount}회)`);

        if (kisErrorCount % 3 === 0) {
          try {
            const { sendTelegram } = require('./telegram');
            await sendTelegram(
              `🚨 [KIS API 장애] 서버 오류 500 연속 ${kisErrorCount}회\n영향: 현재가/수급 데이터 조회 불가\n조치: https://apiportal.koreainvestment.com 공지 확인`,
              'system', `kis_error_${kisErrorCount}`, true
            );
          } catch (e) { /* silent */ }
        }

        if (i < retries - 1) {
          console.log(`[KIS] ${retryDelays500[i] / 1000}초 후 재시도...`);
          await delay(retryDelays500[i]);
          continue;
        }
        // 3회 모두 실패 시 fallback 모드 진입
        if (kisFailCount >= 3) {
          if (!kisDownSince) kisDownSince = Date.now();
          kisRecoveryAt = Date.now() + 30 * 60 * 1000;
          if (!kisDownAlerted) {
            kisDownAlerted = true;
            console.warn('[KIS] 3회 연속 실패 → 30분 후 자동 재시도');
          }
        }
        return null;
      }
      console.error(`[KIS] 요청 실패 (${i + 1}/${retries}):`, err.message);
      if (i < retries - 1) await delay(retryDelaysGeneral[i]);
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

async function getCurrentPrices(stockCodes) {
  const result = {};
  for (const code of stockCodes) {
    try {
      const data = await getCurrentPrice(code);
      if (data?.price) result[code] = data.price;
      await new Promise(r => setTimeout(r, 200));
    } catch (e) { /* silent */ }
  }
  return result;
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

async function getInvestorData(stockCode, { noRetry = false, scanMode = false } = {}) {
  const runner = async () => {
    const token = await getToken();
    if (!token) throw new Error('토큰 없음');
    await delay(200);
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

    // 외인 연속 순매수(양수) or 순매도(음수) 일수
    // 예: +3 = 3일 연속 매수, -2 = 2일 연속 매도
    const startIdx = (!d[0].frgn_ntby_qty || d[0].frgn_ntby_qty.trim() === '') ? 1 : 0;
    let foreignConsecutiveDays = 0;
    if (d.length > startIdx) {
      const firstVal = parseInt(d[startIdx].frgn_ntby_qty);
      const isBuying = !isNaN(firstVal) && firstVal > 0;
      for (let i = startIdx; i < d.length; i++) {
        const val = parseInt(d[i].frgn_ntby_qty);
        if (isNaN(val)) break;
        if (isBuying && val > 0) foreignConsecutiveDays++;
        else if (!isBuying && val < 0) foreignConsecutiveDays--;
        else break;
      }
    }

    // 기관 연속 순매수(양수) or 순매도(음수) 일수
    let institutionConsecutiveDays = 0;
    if (d.length > 0) {
      const firstVal = parseInt(d[0].orgn_ntby_qty);
      const isBuying = !isNaN(firstVal) && firstVal > 0;
      for (let i = 0; i < d.length; i++) {
        const val = parseInt(d[i].orgn_ntby_qty);
        if (isNaN(val)) break;
        if (isBuying && val > 0) institutionConsecutiveDays++;
        else if (!isBuying && val < 0) institutionConsecutiveDays--;
        else break;
      }
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
  };
  if (noRetry) {
    try { return await runner(); } catch (e) { return null; }
  }
  // scanMode: 500 오류 재시도 간격을 3초/5초로 단축 (스캔 전체 시간 절약)
  if (scanMode) {
    for (let i = 0; i < 2; i++) {
      try { return await runner(); } catch (e) {
        if (e.response?.status === 500 && i === 0) { await delay(3000); continue; }
        return null;
      }
    }
    return null;
  }
  return requestWithRetry(runner);
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
  if (closes.length < 27) return null;

  const k12 = 2 / 13, k26 = 2 / 27, k9 = 2 / 10;

  // ema12 초기값: 첫 12개 단순평균
  let ema12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
  // ema26 초기값: 첫 26개 단순평균
  let ema26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;

  // i=12~25: ema12만 갱신
  for (let i = 12; i < 26; i++) {
    ema12 = closes[i] * k12 + ema12 * (1 - k12);
  }

  // i=26~끝: ema12·ema26 동시 갱신하며 macdValues 누적
  const macdValues = [];
  for (let i = 26; i < closes.length; i++) {
    ema12 = closes[i] * k12 + ema12 * (1 - k12);
    ema26 = closes[i] * k26 + ema26 * (1 - k26);
    macdValues.push(ema12 - ema26);
  }
  if (macdValues.length < 9) return null;

  // signal 초기값: macdValues 첫 9개 단순평균 후 지수평활
  let signalPrev = macdValues.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
  for (let i = 9; i < macdValues.length - 1; i++) {
    signalPrev = macdValues[i] * k9 + signalPrev * (1 - k9);
  }
  const signalToday = macdValues[macdValues.length - 1] * k9 + signalPrev * (1 - k9);

  const prevMacd = macdValues[macdValues.length - 2];
  const currMacd = macdValues[macdValues.length - 1];

  let crossover = '없음';
  if (prevMacd < signalPrev && currMacd >= signalToday) crossover = '골든크로스';
  else if (prevMacd > signalPrev && currMacd <= signalToday) crossover = '데드크로스';
  else if (currMacd > 0 && currMacd > signalToday) crossover = '상승중';
  else if (currMacd > 0) crossover = '양전환';
  else crossover = '하락중';

  return {
    macdLine: Math.round(currMacd * 100) / 100,
    signal: Math.round(signalToday * 100) / 100,
    crossover
  };
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
    getInvestorData(stockCode).catch(() => null)  // 수급 실패해도 현재가/차트는 유지
  ]);

  // 현재가/차트 실패 시 → 캐시된 마지막 성공 데이터 반환
  if (!priceData || !chartData || chartData.length < 20) {
    if (lastSuccessCache[stockCode]) {
      console.log(`[KIS] ${stockCode} 실패 → 캐시 데이터 사용 (${new Date(lastSuccessCache[stockCode]._cachedAt).toLocaleTimeString('ko-KR')})`);
      return lastSuccessCache[stockCode];
    }
    return null;
  }
  if (!investorData) console.warn(`[KIS] ${stockCode} 수급 데이터 없음 — 현재가/차트만 사용`);

  const closes = chartData.map(d => d.close);
  const highs = chartData.map(d => d.high);
  const lows = chartData.map(d => d.low);
  const volumes = chartData.map(d => d.volume);

  const rsi = calculateRSI(closes);
  const macd = calculateMACD(closes);
  const bb = calculateBollingerBands(closes);
  const volumeRatio = calculateVolumeRatio(volumes);
  const trailingStop = calculateTrailingStop(closes, priceData.price);

  const week52High = Math.max(...highs);
  const week52Low = Math.min(...lows);
  const isNear52High = priceData.price >= week52High * 0.97;
  const isNear52Low = priceData.price <= week52Low * 1.03;

  const foreignNetAmount = investorData?.foreignNet != null
    ? Math.round(investorData.foreignNet * priceData.price)
    : null;

  // 수급 실패 시 캐시의 investor 데이터 재사용
  const cachedInvestor = !investorData && lastSuccessCache[stockCode]?.investor
    ? lastSuccessCache[stockCode].investor
    : null;

  const result = {
    ...priceData,
    rsi,
    macd,
    bollingerBands: bb,
    volumeRatio,
    trailingStop,
    week52High,
    week52Low,
    isNear52High,
    isNear52Low,
    investor: investorData
      ? { ...investorData, foreignNetAmount }
      : cachedInvestor,
    chartData: chartData.slice(-5),
    _cachedAt: Date.now()
  };

  // 성공 데이터 캐시 저장
  lastSuccessCache[stockCode] = result;
  return result;
}

// 거래량 순위 상위 종목 조회 (코스피+코스닥)
async function getVolumeRankStocks(count = 30) {
  return requestWithRetry(async () => {
    const token = await getToken();
    if (!token) throw new Error('토큰 없음');
    await delay(200);
    const res = await axios.get(`${BASE_URL}/uapi/domestic-stock/v1/quotations/volume-rank`, {
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',   // J=코스피+코스닥
        FID_COND_SCR_DIV_CODE: '20171',
        FID_INPUT_ISCD: '0000',
        FID_DIV_CLS_CODE: '0',
        FID_BLNG_CLS_CODE: '0',
        FID_TRGT_CLS_CODE: '111111111',
        FID_TRGT_EXLS_CLS_CODE: '000000',
        FID_INPUT_PRICE_1: '5000',     // 최소 5000원 이상 (잡주 제외)
        FID_INPUT_PRICE_2: '',
        FID_VOL_CNT: '100000',         // 최소 거래량 10만주
        FID_INPUT_DATE_1: ''
      },
      headers: {
        Authorization: `Bearer ${token}`,
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET,
        tr_id: 'FHPST01710000',
        custtype: 'P'
      },
      timeout: 15000
    });
    const output = res.data.output;
    if (!output || !output.length) throw new Error('거래량 순위 데이터 없음');
    return output.slice(0, count).map(d => ({
      code: d.mksc_shrn_iscd,
      name: d.hts_kor_isnm,
      price: parseFloat(d.stck_prpr),
      changeRate: parseFloat(d.prdy_ctrt),
      volume: parseInt(d.acml_vol),
      volumeRatio: parseFloat(d.vol_inrt)  // 거래량 증가율
    })).filter(d => d.code && d.price > 0);
  });
}

// 등락률 상위 종목 조회
async function getChangeRankStocks(count = 30) {
  return requestWithRetry(async () => {
    const token = await getToken();
    if (!token) throw new Error('토큰 없음');
    await delay(200);
    const res = await axios.get(`${BASE_URL}/uapi/domestic-stock/v1/ranking/fluctuation`, {
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_RANK_SORT_CLS_CODE: '0',
        FID_COND_SCR_DIV_CODE: '20170',
        FID_INPUT_ISCD: '0000',
        FID_DIV_CLS_CODE: '0',
        FID_BLNG_CLS_CODE: '0',
        FID_TRGT_CLS_CODE: '111111111',
        FID_TRGT_EXLS_CLS_CODE: '000000',
        FID_INPUT_PRICE_1: '5000',
        FID_INPUT_PRICE_2: '',
        FID_RST_DIV_CODE: '1',         // 1=상승률 순
        FID_INPUT_ISCD_2: '',
        FID_ETC_CLS_CODE: '',
        FID_VOL_CNT: '100000',
        FID_INPUT_DATE_1: ''
      },
      headers: {
        Authorization: `Bearer ${token}`,
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET,
        tr_id: 'FHPST01720000',
        custtype: 'P'
      },
      timeout: 15000
    });
    const output = res.data.output;
    if (!output || !output.length) throw new Error('등락률 순위 데이터 없음');
    return output.slice(0, count).map(d => ({
      code: d.mksc_shrn_iscd,
      name: d.hts_kor_isnm,
      price: parseFloat(d.stck_prpr),
      changeRate: parseFloat(d.prdy_ctrt),
      volume: parseInt(d.acml_vol)
    })).filter(d => d.code && d.price > 0);
  });
}

function isKisDown() {
  return kisRecoveryAt !== null && Date.now() < kisRecoveryAt;
}

async function searchStockCode(stockName) {
  try {
    const token = await getToken();
    if (!token) {
      console.warn('[KIS] 토큰 없음 → 종목 검색 실패');
      return null;
    }
    await delay(400);
    const res = await axios.get(`${BASE_URL}/uapi/domestic-stock/v1/quotations/search-stock-info`, {
      params: {
        PRDT_TYPE_CD: '300',
        PDNO: stockName
      },
      headers: {
        Authorization: `Bearer ${token}`,
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET,
        tr_id: 'CTPF1002R',
        custtype: 'P'
      },
      timeout: 10000
    });
    const output = res.data.output;
    if (!output || !output.length) {
      console.log(`[KIS] 종목 검색 결과 없음: ${stockName}`);
      return null;
    }
    // 첫 번째 결과 반환
    const first = output[0];
    const code = first.pdno || first.prdt_shtn_cd || first.short_code;
    const name = first.prdt_name || first.prdt_abrv_name;
    if (!code) {
      console.warn(`[KIS] 종목코드 없음: ${stockName}`);
      return null;
    }
    console.log(`[KIS] 종목 검색 성공: ${name} (${code})`);
    return { code, name };
  } catch (err) {
    console.warn(`[KIS] 종목 검색 실패 (${stockName}):`, err.message);
    return null;
  }
}

module.exports = {
  getCurrentPrice,
  getCurrentPrices,
  getDailyChart,
  getInvestorData,
  getFullStockData,
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateVolumeRatio,
  calculateTrailingStop,
  isKisDown,
  getVolumeRankStocks,
  getChangeRankStocks,
  searchStockCode
};
