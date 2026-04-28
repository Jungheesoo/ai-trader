require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const axios = require('axios');
const { getDb } = require('../db/database');
const { getTodayKST } = require('./dateutil');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TG_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

function getToday() {
  return getTodayKST();
}

function getTodayCount() {
  const db = getDb();
  const today = getToday();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM alerts WHERE date = ?').get(today);
  return row ? row.cnt : 0;
}

function isDuplicate(stockName, alertType) {
  const db = getDb();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = db.prepare(
    'SELECT id FROM alerts WHERE stock_name = ? AND alert_type = ? AND sent_at > ?'
  ).get(stockName || '', alertType, oneHourAgo);
  return !!row;
}

function saveAlert(stockName, alertType, message) {
  const db = getDb();
  db.prepare(
    'INSERT INTO alerts (date, stock_name, alert_type, message) VALUES (?, ?, ?, ?)'
  ).run(getToday(), stockName || '', alertType, message);
}

// 카카오 호환용 — 텔레그램은 토큰 만료 없음
async function checkRefreshTokenExpiry() {
  // no-op: 텔레그램은 토큰 갱신 불필요
}

function setRefreshTokenIssuedAt() {
  // no-op
}

async function sendRaw(text) {
  await axios.post(TG_URL, {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML'
  }, { timeout: 10000 });
}

async function sendMessage(message, stockName = '', alertType = 'info', urgent = false) {
  if (!urgent && isDuplicate(stockName, alertType)) {
    console.warn('[Telegram] 중복 알림 차단:', alertType);
    return false;
  }

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('[Telegram] TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID 미설정');
    return false;
  }

  try {
    const LIMIT = 4096;
    if (message.length <= LIMIT) {
      await sendRaw(message);
    } else {
      // 줄바꿈 기준으로 자연스럽게 분할
      const parts = [];
      let current = '';
      for (const line of message.split('\n')) {
        const appended = current ? current + '\n' + line : line;
        if (appended.length > LIMIT) {
          if (current) parts.push(current);
          current = line;
        } else {
          current = appended;
        }
      }
      if (current) parts.push(current);

      for (let i = 0; i < parts.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 500));
        await sendRaw(parts[i]);
      }
    }

    saveAlert(stockName, alertType, message);
    console.log(`[Telegram] 발송 성공 (오늘 ${getTodayCount()}건)`);
    return true;
  } catch (err) {
    console.error('[Telegram] 발송 실패:', err.response?.data?.description || err.message);
    return false;
  }
}

async function sendKakao(message, stockName = '', alertType = 'info', urgent = false) {
  return sendMessage(message, stockName, alertType, urgent);
}

module.exports = {
  sendMessage,
  sendKakao,
  getTodayCount,
  checkRefreshTokenExpiry,
  setRefreshTokenIssuedAt
};
