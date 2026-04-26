require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const axios = require('axios');
const { getDb } = require('../db/database');
const { getTodayKST } = require('./dateutil');

const MAX_PER_DAY = parseInt(process.env.MAX_KAKAO_ALERTS_PER_DAY) || 15;
let accessToken = process.env.KAKAO_ACCESS_TOKEN;
let refreshToken = process.env.KAKAO_REFRESH_TOKEN;
let tokenExpiry = 0;

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

// Refresh Token 발급일 저장 (최초 토큰 설정 시 또는 갱신 시 업데이트)
let refreshTokenIssuedAt = Date.now();

function setRefreshTokenIssuedAt(ts) {
  refreshTokenIssuedAt = ts || Date.now();
}

async function checkRefreshTokenExpiry() {
  const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60일
  const WARN_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;        // 7일 전 알림
  const elapsed = Date.now() - refreshTokenIssuedAt;
  const remaining = REFRESH_TOKEN_TTL_MS - elapsed;

  if (remaining <= WARN_BEFORE_MS && remaining > 0) {
    const daysLeft = Math.ceil(remaining / (24 * 60 * 60 * 1000));
    await sendMessage(
      `⚠️ 카카오 Refresh Token 만료 ${daysLeft}일 전입니다.\n토큰을 갱신하지 않으면 카카오톡 알림이 중단됩니다.\nREADME 5번 항목 참고하여 재발급 해주세요.`,
      '', 'refresh_token_warning'
    );
  }
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

// 매일 오전 7시 Refresh Token 만료 체크 (node-cron은 index.js에서 등록)
// sendKakao: sendMessage의 alias (스케줄러에서 사용)
const sendKakao = sendMessage;

module.exports = {
  sendMessage,
  sendKakao,
  getTodayCount,
  MAX_PER_DAY,
  checkRefreshTokenExpiry,
  setRefreshTokenIssuedAt
};
