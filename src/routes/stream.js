'use strict';
const express = require('express');
const router = express.Router();

// SSE 클라이언트 목록 (res 객체 보관)
const clients = new Set();

// kis-websocket.js 에서 호출: 체결 tick 수신 시 모든 클라이언트에 broadcast
function broadcast(stockCode, price, changeRate) {
  if (clients.size === 0) return;
  const data = JSON.stringify({ code: stockCode, price, changeRate, ts: Date.now() });
  for (const res of clients) {
    try { res.write(`data: ${data}\n\n`); } catch (e) { clients.delete(res); }
  }
}

// GET /api/stream  — 브라우저가 연결 유지
router.get('/', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  clients.add(res);

  // 연결 유지용 heartbeat (30초마다)
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { clearInterval(hb); clients.delete(res); }
  }, 30000);

  req.on('close', () => {
    clearInterval(hb);
    clients.delete(res);
  });
});

module.exports = { router, broadcast };
