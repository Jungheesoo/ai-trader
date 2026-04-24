const { sendMorningLink } = require('../services/alert');
const { isWeekday } = require('../services/holiday');

async function runMorningLink() {
  if (!isWeekday(new Date())) return;
  console.log('[Morning] 웹 UI 링크 발송');
  try {
    await sendMorningLink();
  } catch (err) {
    console.error('[Morning] 링크 발송 실패:', err.message);
  }
}

module.exports = { runMorningLink };
