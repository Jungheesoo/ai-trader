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

function getKSTHeader() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const days = ['일','월','화','수','목','금','토'];
  return `${String(kst.getUTCMonth()+1).padStart(2,'0')}/${String(kst.getUTCDate()).padStart(2,'0')} (${days[kst.getUTCDay()]}) ${String(kst.getUTCHours()).padStart(2,'0')}:${String(kst.getUTCMinutes()).padStart(2,'0')}`;
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

async function sendRaw(text) {
  await axios.post(TG_URL, {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML'
  }, { timeout: 10000 });
}

async function sendTelegram(message, stockName = '', alertType = 'info', urgent = false) {
  if (!urgent && isDuplicate(stockName, alertType)) {
    console.warn('[Telegram] 중복 알림 차단:', alertType);
    return false;
  }

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('[Telegram] TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID 미설정');
    return false;
  }

  try {
    // 4000자 초과 시 자동 절단 + 더보기 링크 추가
    const SERVER_URL = `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}`;
    if (typeof message === 'string' && message.length > 3900) {
      message = message.slice(0, 3900) + `\n…더보기 👉 ${SERVER_URL}`;
    }

    const LIMIT = 4096;
    if (message.length <= LIMIT) {
      await sendRaw(message);
    } else {
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

module.exports = {
  sendTelegram,
  getTodayCount,
  getKSTHeader
};
