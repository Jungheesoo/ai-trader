'use strict';
const express = require('express');
const router = express.Router();

const MAX_CLIENTS = 50;
const clients = new Set();

function broadcast(stockCode, price, changeRate) {
  if (clients.size === 0) return;
  const data = JSON.stringify({ code: stockCode, price, changeRate, ts: Date.now() });
  for (const res of clients) {
    try { res.write(`data: ${data}\n\n`); } catch (e) { clients.delete(res); }
  }
}

router.get('/', (req, res) => {
  if (clients.size >= MAX_CLIENTS) {
    res.status(503).end();
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  clients.add(res);

  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { clearInterval(hb); clients.delete(res); }
  }, 30000);

  req.on('close', () => {
    clearInterval(hb);
    clients.delete(res);
  });
});

module.exports = { router, broadcast };
