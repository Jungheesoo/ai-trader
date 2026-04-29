// 하위 호환 래퍼 — 실제 구현은 telegram.js
const { sendTelegram, getTodayCount } = require('./telegram');

async function checkRefreshTokenExpiry() {}
function setRefreshTokenIssuedAt() {}

async function sendMessage(message, stockName = '', alertType = 'info', urgent = false) {
  return sendTelegram(message, stockName, alertType, urgent);
}

async function sendKakao(message, stockName = '', alertType = 'info', urgent = false) {
  return sendTelegram(message, stockName, alertType, urgent);
}

module.exports = {
  sendMessage,
  sendKakao,
  sendTelegram,
  getTodayCount,
  checkRefreshTokenExpiry,
  setRefreshTokenIssuedAt
};
