require('dotenv').config();
const axios = require('axios');
const { getDb } = require('../db/database');

const MAX_PER_DAY = parseInt(process.env.MAX_KAKAO_ALERTS_PER_DAY) || 15;
let accessToken = process.env.KAKAO_ACCESS_TOKEN;
let refreshToken = process.env.KAKAO_REFRESH_TOKEN;
let tokenExpiry = Date.now() + 6 * 60 * 60 * 1000;

function getToday() {
  return new Date().toISOString().slice(0, 10);
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

async function refreshAccessToken() {
  try {
    const res = await axios.post('https://kauth.kakao.com/oauth/token', null, {
      params: {
        grant_type: 'refresh_token',
        client_id: process.env.KAKAO_CLIENT_ID,
        client_secret: process.env.KAKAO_CLIENT_SECRET,
        refresh_token: refreshToken
      },
      timeout: 10000
    });
    accessToken = res.data.access_token;
    tokenExpiry = Date.now() + 6 * 60 * 60 * 1000;
    if (res.data.refresh_token) {
      refreshToken = res.data.refresh_token;
    }
    console.log('[Kakao] 토큰 갱신 성공');
  } catch (err) {
    console.error('[Kakao] 토큰 갱신 실패:', err.message);
  }
}

async function ensureToken() {
  if (Date.now() >= tokenExpiry - 5 * 60 * 1000) {
    await refreshAccessToken();
  }
}

function checkRefreshTokenExpiry() {
  // Refresh Token 만료 체크 (60일 기준, 7일 전 알림)
  // 실제 구현 시 저장된 만료 시간과 비교
}

async function sendMessage(message, stockName = '', alertType = 'info') {
  if (getTodayCount() >= MAX_PER_DAY) {
    console.warn('[Kakao] 일일 발송 한도 초과');
    return false;
  }

  if (isDuplicate(stockName, alertType)) {
    console.warn('[Kakao] 중복 알림 차단:', alertType);
    return false;
  }

  await ensureToken();

  try {
    await axios.post(
      'https://kapi.kakao.com/v2/api/talk/memo/default/send',
      {
        template_object: JSON.stringify({
          object_type: 'text',
          text: message,
          link: { web_url: `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}` }
        })
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      }
    );
    saveAlert(stockName, alertType, message);
    console.log(`[Kakao] 발송 성공 (오늘 ${getTodayCount()}건)`);
    return true;
  } catch (err) {
    console.error('[Kakao] 발송 실패:', err.message);
    return false;
  }
}

// 6시간마다 토큰 자동 갱신
setInterval(async () => {
  await refreshAccessToken();
}, 6 * 60 * 60 * 1000);

module.exports = { sendMessage, getTodayCount, MAX_PER_DAY };
