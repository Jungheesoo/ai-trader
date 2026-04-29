'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const WebSocket = require('ws');
const axios = require('axios');
const { isMarketOpen } = require('../utils/market');

const WS_URL = 'wss://openapi.koreainvestment.com:21000';
const BASE_URL = process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';

const tickData = {};
const hokaData = {};

let ws = null;
let approvalKey = null;
let reconnectTimer = null;
let subscribedCodes = [];
let isConnecting = false;
let reconnectCount = 0;

const TICK_MAX_MINUTES = 5;
const TICK_CLEANUP_MS = TICK_MAX_MINUTES * 60 * 1000;

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

  let sellWall = 0;
  for (let i = 4; i <= 8; i++) sellWall += parseInt(fields[i] || '0');

  let buyWall = 0;
  for (let i = 14; i <= 18; i++) buyWall += parseInt(fields[i] || '0');

  hokaData[stockCode] = { buyWall, sellWall, updatedAt: Date.now() };
}

function handleMessage(data) {
  try {
    const str = data.toString();

    if (str.includes('PINGPONG')) {
      ws.send(str);
      return;
    }

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

        try {
          const { broadcast } = require('../routes/stream');
          const parts2 = str.split('|');
          const fields2 = parts2[3].split('^');
          const changeRate = parseFloat(fields2[9]) || 0;
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
  subscribedCodes = stockCodes.slice(0, 10);

  const key = await getApprovalKey();
  if (!key) { isConnecting = false; return; }

  ws = new WebSocket(WS_URL);

  ws.on('open', async () => {
    const wasFailedBefore = reconnectCount >= 3;
    console.log('[KIS-WS] 연결 성공. 구독 종목:', subscribedCodes.join(', '));
    isConnecting = false;

    if (wasFailedBefore) {
      try {
        const { sendTelegram } = require('./telegram');
        await sendTelegram('✅ [WS 복구] KIS 실시간 시세 연결 정상화', 'system', 'ws_recover', false);
      } catch (e) { /* silent */ }
    }

    reconnectCount = 0;

    for (const code of subscribedCodes) {
      subscribe(code, 'H0STCNT0');
      subscribe(code, 'H0STASP0');
    }
  });

  ws.on('message', handleMessage);

  ws.on('error', (err) => {
    console.error('[KIS-WS] 연결 오류:', err.message);
    isConnecting = false;
  });

  ws.on('close', async () => {
    console.log('[KIS-WS] 연결 종료');
    isConnecting = false;
    ws = null;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    if (!isMarketOpen()) return;

    const delay = Math.min(30 * Math.pow(2, reconnectCount), 300) * 1000;
    reconnectCount++;
    console.log(`[KIS-WS] ${Math.round(delay / 1000)}초 후 재연결 예정 (${reconnectCount}회차)`);

    if (reconnectCount > 0 && reconnectCount % 3 === 0) {
      try {
        const { sendTelegram } = require('./telegram');
        await sendTelegram(
          `🚨 [WS 장애] KIS 실시간 시세 연결 실패\n연속 실패: ${reconnectCount}회\n영향: 실시간 체결강도/호가 조회 불가\n조치: 진입가는 REST API 기준으로 대체됨. 수동 확인 권장.\n👉 ${process.env.SERVER_URL || ''}`,
          'system', `ws_fail_${reconnectCount}`, true
        );
      } catch (e) { /* silent */ }
    }

    reconnectTimer = setTimeout(() => connect(subscribedCodes), delay);
  });
}

function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { ws.close(); ws = null; }
  reconnectCount = 0;
  console.log('[KIS-WS] 연결 해제');
}

function isConnected() {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

function getStrength(stockCode, minutes = 3) {
  const ticks = tickData[stockCode];
  if (!ticks || ticks.length === 0) return null;
  const cutoff = Date.now() - minutes * 60 * 1000;
  const recent = ticks.filter(t => t.ts > cutoff);
  if (recent.length === 0) return null;
  return Math.round(recent.reduce((sum, t) => sum + t.strength, 0) / recent.length);
}

function getBuyWall(stockCode) {
  return hokaData[stockCode]?.buyWall ?? null;
}

function getSellWall(stockCode) {
  return hokaData[stockCode]?.sellWall ?? null;
}

function get5MinChange(stockCode) {
  const ticks = tickData[stockCode];
  if (!ticks || ticks.length < 2) return null;
  const cutoff = Date.now() - TICK_CLEANUP_MS;
  const oldest = ticks.find(t => t.ts > cutoff);
  const latest = ticks[ticks.length - 1];
  if (!oldest || !latest || oldest.price === 0) return null;
  return Math.round(((latest.price - oldest.price) / oldest.price) * 10000) / 100;
}

async function checkAlerts(holdings) {
  for (const h of holdings) {
    if (!h.stock_code) continue;
    const code = h.stock_code;
    const change5min = get5MinChange(code);
    const ticks = tickData[code];
    const latestPrice = ticks && ticks.length > 0 ? ticks[ticks.length - 1].price : null;
    if (!latestPrice) continue;

    const shortTarget = h.avg_price ? Math.round(h.avg_price * 1.05) : null;
    const trailingStop = h.trailingStop || null;

    try {
      const { sendTelegram } = require('./telegram');

      if (change5min !== null && change5min <= -3) {
        await sendTelegram(`⚠️ [${h.stock_name}] 5분 급락 ${change5min}%!\n현재가: ${latestPrice.toLocaleString()}원\n즉시 확인 필요`, h.stock_name, `ws_급락_${code}`, true);
      }
      if (shortTarget && latestPrice >= shortTarget) {
        await sendTelegram(`🎯 [${h.stock_name}] 목표가 도달!\n현재가: ${latestPrice.toLocaleString()}원 (목표가 ${shortTarget.toLocaleString()}원)\n익절 타이밍`, h.stock_name, `ws_목표가_${code}`, true);
      }
      if (trailingStop && latestPrice <= trailingStop) {
        await sendTelegram(`⚡ [${h.stock_name}] 트레일링 스탑 도달!\n현재가: ${latestPrice.toLocaleString()}원 (스탑 ${trailingStop.toLocaleString()}원)\n확인 필요`, h.stock_name, `ws_트레일링_${code}`, true);
      }
    } catch (e) { /* 알림 실패 무시 */ }
  }
}

module.exports = {
  connect,
  disconnect,
  isConnected,
  getStrength,
  getBuyWall,
  getSellWall,
  get5MinChange,
  checkAlerts
};
