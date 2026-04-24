const { fetchAllRSS } = require('../services/rss');
const { filterNewsBatch } = require('../services/claude-haiku');
const { sendKakao } = require('../services/kakao');
const { sendErrorAlert } = require('../services/alert');
const { getDb } = require('../db/database');

let isRunning = false;

async function runNightMonitor() {
  if (isRunning) {
    console.warn('[Night] 이전 야간 모니터링 진행 중 - 스킵');
    return;
  }

  isRunning = true;
  const timeout = setTimeout(() => { isRunning = false; }, 10 * 60 * 1000);

  try {
    console.log('[Night] 야간 미국 시장 모니터링 시작 (Sonnet 호출 없음)');
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);

    // 보유 종목 로드
    const holdings = db.prepare(
      'SELECT * FROM holdings WHERE date = ? ORDER BY id DESC'
    ).all(today);

    const holdingProxy = holdings.length > 0 ? holdings : [];

    const allNews = await fetchAllRSS();
    if (!allNews || allNews.length === 0) {
      console.log('[Night] 수집된 뉴스 없음');
      return;
    }

    // Haiku만 사용 (Sonnet 호출 절대 없음)
    const filtered = await filterNewsBatch(allNews, holdingProxy);
    const urgent = filtered.filter(n => n.relevant && n.urgency === '긴급');
    const important = filtered.filter(n => n.relevant && n.urgency !== '긴급');

    const serverUrl = `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}`;

    if (urgent.length > 0) {
      const hour = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      let msg = `🌙 [야간 이슈] ${hour}\n\n`;
      for (const n of urgent.slice(0, 3)) {
        msg += `⚠️ ${n.title}\n감지: ${n.reason}\n\n`;
      }
      msg += `내일 모닝 리포트에서 AI 분석 예정\n\n👉 ${serverUrl}`;
      await sendKakao(msg);
    } else if (important.length > 0) {
      const hour = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      let msg = `🌙 [야간 이슈] ${hour}\n\n`;
      msg += `감지: ${important[0].reason}\n`;
      msg += `내일 모닝 리포트에서 AI 분석 예정\n\n👉 ${serverUrl}`;
      await sendKakao(msg);
    } else {
      console.log('[Night] 야간 특이사항 없음');
    }
  } catch (err) {
    console.error('[Night] 야간 모니터링 오류:', err.message);
    await sendErrorAlert('[Night] 야간 모니터링 실패: ' + err.message);
  } finally {
    clearTimeout(timeout);
    isRunning = false;
  }
}

module.exports = { runNightMonitor };
