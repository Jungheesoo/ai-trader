require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const axios = require('axios');
const { getDb } = require('../db/database');
const { getTodayKST } = require('./dateutil');

const MAX_PER_DAY = parseInt(process.env.MAX_KAKAO_ALERTS_PER_DAY) || 15;
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

async function sendMessage(message, stockName = '', alertType = 'info') {
  if (isDuplicate(stockName, alertType)) {
    console.warn('[Telegram] 중복 알림 차단:', alertType);
    return false;
  }

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('[Telegram] TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID 미설정');
    return false;
  }

  try {
    await axios.post(TG_URL, {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    }, { timeout: 10000 });

    saveAlert(stockName, alertType, message);
    console.log(`[Telegram] 발송 성공 (오늘 ${getTodayCount()}건)`);
    return true;
  } catch (err) {
    console.error('[Telegram] 발송 실패:', err.response?.data?.description || err.message);
    return false;
  }
}

const sendKakao = sendMessage;

module.exports = {
  sendMessage,
  sendKakao,
  getTodayCount,
  MAX_PER_DAY,
  checkRefreshTokenExpiry,
  setRefreshTokenIssuedAt
};
