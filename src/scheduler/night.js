const { collectNightNews } = require('../services/rss');
const { filterNewsBatch } = require('../services/claude-haiku');
const { sendKakao } = require('../services/kakao');
const { sendErrorAlert } = require('../services/alert');
const { getDb } = require('../db/database');
const axios = require('axios');
const cheerio = require('cheerio');
const { getTodayKST } = require('../services/dateutil');

let isRunning = false;

// 나스닥/S&P500/다우 현재 등락률 크롤링 (Google Finance)
async function fetchUsMarketStatus() {
  try {
    const indices = [
      { name: 'NASDAQ', url: 'https://www.google.com/finance/quote/.IXIC:INDEXNASDAQ' },
      { name: 'S&P500', url: 'https://www.google.com/finance/quote/.INX:INDEXSP' },
      { name: '다우', url: 'https://www.google.com/finance/quote/.DJI:INDEXDJX' }
    ];
    const results = [];
    for (const idx of indices) {
      try {
        const res = await axios.get(idx.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
          timeout: 8000
        });
        const $ = cheerio.load(res.data);
        // Google Finance 등락률 셀렉터 ("Up by 1.23%" / "Down by 1.23%" 형식)
        const changeText = $('[jsname="Fe7oBc"]').first().attr('aria-label') || '';
        const numMatch = changeText.match(/(\d+\.?\d*)\s*%/);
        const isDown = /down/i.test(changeText);
        const changeRate = numMatch ? parseFloat(numMatch[1]) * (isDown ? -1 : 1) : null;
        results.push({ name: idx.name, changeRate });
      } catch {
        results.push({ name: idx.name, changeRate: null });
      }
    }
    return results;
  } catch {
    return [];
  }
}

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
    const today = getTodayKST();

    // 보유 종목 로드
    const holdings = db.prepare(
      'SELECT * FROM holdings WHERE date = ? ORDER BY id DESC'
    ).all(today);
    const holdingProxy = holdings.length > 0 ? holdings : [];

    // 미국 시장 지수 크롤링
    const usMarket = await fetchUsMarketStatus();

    const allNews = await collectNightNews();

    const serverUrl = `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}`;
    const hour = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

    // 나스닥 -3% 이상 급락 → 즉시 긴급 알림
    const nasdaq = usMarket.find(m => m.name === 'NASDAQ');
    if (nasdaq?.changeRate !== null && nasdaq.changeRate <= -3) {
      let msg = `🚨 [야간 긴급] ${hour}\n\n`;
      msg += `나스닥 ${nasdaq.changeRate}% 급락 감지!\n`;
      usMarket.forEach(m => {
        if (m.changeRate !== null) {
          msg += `${m.name}: ${m.changeRate >= 0 ? '+' : ''}${m.changeRate}%\n`;
        }
      });
      msg += `\n⚠️ 내일 개장 시 즉각 대응 필요. 모닝 리포트 확인\n\n👉 ${serverUrl}`;
      await sendKakao(msg);
    }

    if (!allNews || allNews.length === 0) {
      console.log('[Night] 수집된 뉴스 없음');
      return;
    }

    // Haiku만 사용 (Sonnet 호출 절대 없음)
    const filtered = await filterNewsBatch(allNews, holdingProxy);
    const urgent = filtered.filter(n => n.relevant && n.urgency === '긴급');
    const important = filtered.filter(n => n.relevant && n.urgency !== '긴급');

    if (urgent.length > 0) {
      let msg = `🌙 [야간 이슈] ${hour}\n\n`;
      // 미국 시장 현황 포함
      const marketLine = usMarket.filter(m => m.changeRate !== null).map(m => `${m.name} ${m.changeRate >= 0 ? '+' : ''}${m.changeRate}%`).join(' / ');
      if (marketLine) msg += `미국 증시: ${marketLine}\n\n`;
      for (const n of urgent.slice(0, 3)) {
        msg += `⚠️ ${n.title}\n감지: ${n.reason}\n\n`;
      }
      msg += `내일 모닝 리포트에서 AI 분석 예정\n\n👉 ${serverUrl}`;
      await sendKakao(msg);
    } else if (important.length > 0) {
      let msg = `🌙 [야간 이슈] ${hour}\n\n`;
      const marketLine = usMarket.filter(m => m.changeRate !== null).map(m => `${m.name} ${m.changeRate >= 0 ? '+' : ''}${m.changeRate}%`).join(' / ');
      if (marketLine) msg += `미국 증시: ${marketLine}\n`;
      msg += `감지: ${important[0].reason}\n`;
      msg += `내일 모닝 리포트에서 AI 분석 예정\n\n👉 ${serverUrl}`;
      await sendKakao(msg);
    } else {
      // 특이사항 없어도 미국 시장 현황은 로그
      const marketLine = usMarket.filter(m => m.changeRate !== null).map(m => `${m.name} ${m.changeRate >= 0 ? '+' : ''}${m.changeRate}%`).join(' / ');
      console.log(`[Night] 야간 특이사항 없음. 미국 증시: ${marketLine || '데이터 없음'}`);
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
