'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const WebSocket = require('ws');
const axios = require('axios');
const { isMarketOpen } = require('../utils/market');

const WS_URL = 'wss://openapi.koreainvestment.com:21000';
const BASE_URL = process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';

// 메모리 내 데이터 (최근 5분치만 유지, e2-micro 1GB RAM 고려)
const tickData = {};   // { [stockCode]: [{time, price, strength}] }
const hokaData = {};   // { [stockCode]: {buyWall, sellWall, updatedAt} }

let ws = null;
let approvalKey = null;
let reconnectTimer = null;
let subscribedCodes = [];
let isConnecting = false;

const TICK_MAX_MINUTES = 5;
const TICK_CLEANUP_MS = TICK_MAX_MINUTES * 60 * 1000;

// 오래된 틱 데이터 정리 (메모리 관리)
function cleanupOldTicks() {
  const cutoff = Date.now() - TICK_CLEANUP_MS;
  for (const code of Object.keys(tickData)) {
    tickData[code] = tickData[code].filter(t => t.ts > cutoff);
    if (tickData[code].length === 0) delete tickData[code];
  }
}

setInterval(cleanupOldTicks, 60000);

async function getApprovalKey() {
  try {
    const res = await axios.post(`${BASE_URL}/oauth2/Approval`, {
      grant_type: 'client_credentials',
      appkey: process.env.KIS_APP_KEY,
      secretkey: process.env.KIS_APP_SECRET
    }, { timeout: 10000 });
    approvalKey = res.data.approval_key;
    console.log('[KIS-WS] 접속키 발급 성공');
    return approvalKey;
  } catch (err) {
    console.error('[KIS-WS] 접속키 발급 실패:', err.message);
    return null;
  }
}

function subscribe(stockCode, trId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    header: {
      approval_key: approvalKey,
      custtype: 'P',
      tr_type: '1',
      'content-type': 'utf-8'
    },
    body: {
      input: { tr_id: trId, tr_key: stockCode }
    }
  }));
}

function parseTickData(raw) {
  const parts = raw.split('|');
  if (parts.length < 4) return null;
  const fields = parts[3].split('^');
  const price = parseFloat(fields[2]);
  const strength = parseFloat(fields[19]) || 100;
  if (!price || isNaN(price)) return null;
  return { ts: Date.now(), price, strength };
}

function parseHokaData(raw, stockCode) {
  const parts = raw.split('|');
  if (parts.length < 4) return;
  const fields = parts[3].split('^');

  // 매도호가 1~5 잔량 합산 (인덱스 4~8)
  let sellWall = 0;
  for (let i = 4; i <= 8; i++) sellWall += parseInt(fields[i] || '0');

  // 매수호가 1~5 잔량 합산 (인덱스 14~18)
  let buyWall = 0;
  for (let i = 14; i <= 18; i++) buyWall += parseInt(fields[i] || '0');

  hokaData[stockCode] = { buyWall, sellWall, updatedAt: Date.now() };
}

function handleMessage(data) {
  try {
    const str = data.toString();

    // PINGPONG 응답
    if (str.includes('PINGPONG')) {
      ws.send(str); // pong
      return;
    }

    // JSON 응답 (구독 확인 등)
    if (str.startsWith('{')) return;

    const parts = str.split('|');
    if (parts.length < 4) return;

    const trId = parts[1];
    const stockCode = parts[3].split('^')[0];

    if (trId === 'H0STCNT0') {
      const tick = parseTickData(str);
      if (tick && stockCode) {
        if (!tickData[stockCode]) tickData[stockCode] = [];
        tickData[stockCode].push(tick);
        if (tickData[stockCode].length > 300) tickData[stockCode].shift();

        // SSE broadcast
        try {
          const { broadcast } = require('../routes/stream');
          const parts2 = str.split('|');
          const fields2 = parts2[3].split('^');
          const changeRate = parseFloat(fields2[9]) || 0; // 전일대비율
          broadcast(stockCode, tick.price, changeRate);
        } catch (e) { /* silent */ }
      }
    } else if (trId === 'H0STASP0') {
      if (stockCode) parseHokaData(str, stockCode);
    }
  } catch (e) {
    // 파싱 오류 무시
  }
}

async function connect(stockCodes = []) {
  if (!isMarketOpen()) {
    console.log('[KIS-WS] 장 외 시간 - WebSocket 연결 스킵');
    return;
  }
  if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) return;

  isConnecting = true;
  subscribedCodes = stockCodes.slice(0, 10); // 최대 10종목

  const key = await getApprovalKey();
  if (!key) { isConnecting = false; return; }

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('[KIS-WS] 연결 성공. 구독 종목:', subscribedCodes.join(', '));
    isConnecting = false;
    for (const code of subscribedCodes) {
      subscribe(code, 'H0STCNT0'); // 체결가
      subscribe(code, 'H0STASP0'); // 호가
    }
  });

  ws.on('message', handleMessage);

  ws.on('error', (err) => {
    console.error('[KIS-WS] 연결 오류:', err.message);
    isConnecting = false;
  });

  ws.on('close', () => {
    console.log('[KIS-WS] 연결 종료');
    isConnecting = false;
    ws = null;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // 장 중이면 30초 후 재연결
    if (isMarketOpen()) {
      reconnectTimer = setTimeout(() => connect(subscribedCodes), 30000);
      console.log('[KIS-WS] 30초 후 재연결 예정');
    }
  });
}

function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { ws.close(); ws = null; }
  console.log('[KIS-WS] 연결 해제');
}

// 최근 N분 평균 체결강도
function getStrength(stockCode, minutes = 3) {
  const ticks = tickData[stockCode];
  if (!ticks || ticks.length === 0) return null;
  const cutoff = Date.now() - minutes * 60 * 1000;
  const recent = ticks.filter(t => t.ts > cutoff);
  if (recent.length === 0) return null;
  return Math.round(recent.reduce((sum, t) => sum + t.strength, 0) / recent.length);
}

// 매수호가 1~5 잔량 합계
function getBuyWall(stockCode) {
  return hokaData[stockCode]?.buyWall ?? null;
}

// 매도호가 1~5 잔량 합계
function getSellWall(stockCode) {
  return hokaData[stockCode]?.sellWall ?? null;
}

// 5분 전 대비 가격 변화율
function get5MinChange(stockCode) {
  const ticks = tickData[stockCode];
  if (!ticks || ticks.length < 2) return null;
  const cutoff = Date.now() - TICK_CLEANUP_MS;
  const oldest = ticks.find(t => t.ts > cutoff);
  const latest = ticks[ticks.length - 1];
  if (!oldest || !latest || oldest.price === 0) return null;
  return Math.round(((latest.price - oldest.price) / oldest.price) * 10000) / 100;
}

// 알림 트리거 체크 (코드에서 직접 판단 — Claude 호출 없음)
async function checkAlerts(holdings) {
  for (const h of holdings) {
    if (!h.stock_code) continue;
    const code = h.stock_code;
    const change5min = get5MinChange(code);
    const strength = getStrength(code);
    const ticks = tickData[code];
    const latestPrice = ticks && ticks.length > 0 ? ticks[ticks.length - 1].price : null;
    if (!latestPrice) continue;

    const shortTarget = h.avg_price ? Math.round(h.avg_price * 1.05) : null;
    const trailingStop = h.trailingStop || null;

    try {
      const { sendKakao } = require('./kakao');

      // 5분간 -3% 이상 급락
      if (change5min !== null && change5min <= -3) {
        await sendKakao(`⚠️ [${h.stock_name}] 5분 급락 ${change5min}%!\n현재가: ${latestPrice.toLocaleString()}원\n즉시 확인 필요`);
      }
      // 목표가 도달
      if (shortTarget && latestPrice >= shortTarget) {
        await sendKakao(`🎯 [${h.stock_name}] 목표가 도달!\n현재가: ${latestPrice.toLocaleString()}원 (목표가 ${shortTarget.toLocaleString()}원)\n익절 타이밍`);
      }
      // 트레일링 스탑 도달
      if (trailingStop && latestPrice <= trailingStop) {
        await sendKakao(`⚡ [${h.stock_name}] 트레일링 스탑 도달!\n현재가: ${latestPrice.toLocaleString()}원 (스탑 ${trailingStop.toLocaleString()}원)\n확인 필요`);
      }
    } catch (e) { /* 알림 실패 무시 */ }
  }
}

module.exports = {
  connect,
  disconnect,
  getStrength,
  getBuyWall,
  getSellWall,
  get5MinChange,
  checkAlerts
};
