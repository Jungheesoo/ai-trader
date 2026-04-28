const { getDb } = require('../db/database');
const {
  getDailyChart, getInvestorData,
  calculateRSI, calculateMACD, calculateVolumeRatio,
  getVolumeRankStocks, getChangeRankStocks
} = require('../services/kis');
const { isWeekday } = require('../services/holiday');
const { sendErrorAlert } = require('../services/alert');
const { getTodayKST } = require('../services/dateutil');

let isRunning = false;

// 잡주 필터 — 종목코드 기준 (관리종목/투자경고/스팩/우선주 등)
// 코드 끝자리 패턴으로 우선주 제외 (5, 7로 끝나는 경우가 많음)
function isJunkStock(code, name, changeRate) {
  if (!code || !name) return true;
  // 스팩(SPAC) 종목
  if (name.includes('스팩') || name.includes('SPAC')) return true;
  // 우선주 (코드 끝 1자리가 홀수이고 5자리인 경우 제외는 어려워서 이름으로 판단)
  if (name.endsWith('우') || name.endsWith('우B') || name.endsWith('우C')) return true;
  // 5일 +30% 이상 급등 — 세력주 의심
  if (changeRate && changeRate >= 30) return true;
  return false;
}

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runScan() {
  if (!isWeekday(new Date())) return;
  if (isRunning) {
    console.warn('[Scan] 이전 스캔 진행 중 - 스킵');
    return;
  }

  isRunning = true;
  const timeout = setTimeout(() => { isRunning = false; }, 15 * 60 * 1000);

  try {
    console.log('[Scan] 동적 스캔 시작 (거래량/등락률 순위 기반)');
    const db = getDb();
    const today = getTodayKST();
    db.prepare('DELETE FROM watchlist WHERE date = ?').run(today);

    // ── 1단계: KIS 순위 API로 후보 종목 추출 (API 2회) ──
    let candidates = [];

    const [volumeRanks, changeRanks] = await Promise.allSettled([
      getVolumeRankStocks(40),
      getChangeRankStocks(40)
    ]);

    if (volumeRanks.status === 'fulfilled' && volumeRanks.value) {
      candidates.push(...volumeRanks.value);
      console.log(`[Scan] 거래량 순위 ${volumeRanks.value.length}종목 수집`);
    } else {
      console.warn('[Scan] 거래량 순위 API 실패 — 기본 목록으로 fallback');
    }

    if (changeRanks.status === 'fulfilled' && changeRanks.value) {
      candidates.push(...changeRanks.value);
      console.log(`[Scan] 등락률 순위 ${changeRanks.value.length}종목 수집`);
    }

    // 순위 API 모두 실패 시 기본 핵심 종목으로 fallback
    if (candidates.length === 0) {
      console.warn('[Scan] 순위 API 실패 → 핵심 종목 fallback');
      candidates = [
        { code: '005930', name: '삼성전자' }, { code: '000660', name: 'SK하이닉스' },
        { code: '012450', name: '한화에어로스페이스' }, { code: '034020', name: '두산에너빌리티' },
        { code: '329180', name: 'HD현대중공업' }, { code: '005380', name: '현대자동차' },
        { code: '000270', name: '기아' }, { code: '105560', name: 'KB금융' },
        { code: '055550', name: '신한지주' }, { code: '035420', name: 'NAVER' },
        { code: '207940', name: '삼성바이오로직스' }, { code: '068270', name: '셀트리온' },
        { code: '373220', name: 'LG에너지솔루션' }, { code: '079550', name: 'LIG넥스원' },
        { code: '009540', name: 'HD한국조선해양' }
      ];
    }

    // 중복 제거 (코드 기준)
    const seen = new Set();
    candidates = candidates.filter(c => {
      if (!c.code || seen.has(c.code)) return false;
      seen.add(c.code);
      return true;
    });

    // 잡주 1차 필터 (이름/등락률 기준 — API 호출 없이)
    candidates = candidates.filter(c => !isJunkStock(c.code, c.name, c.changeRate));

    console.log(`[Scan] 후보 종목 ${candidates.length}개 → 정밀 스캔 시작`);

    // ── 2단계: 후보 종목 정밀 스캔 (RSI/MACD/수급) ──
    const results = [];

    for (const stock of candidates) {
      try {
        await delay(150); // KIS API 초당 20회 제한 준수
        const [chartData, investorData] = await Promise.allSettled([
          getDailyChart(stock.code, 60),
          getInvestorData(stock.code, { noRetry: true })
        ]);

        const chart = chartData.status === 'fulfilled' ? chartData.value : null;
        const investor = investorData.status === 'fulfilled' ? investorData.value : null;

        if (!chart || chart.length < 20) continue;

        const closes = chart.map(d => d.close);
        const volumes = chart.map(d => d.volume);
        const currentPrice = stock.price || closes[closes.length - 1];

        const rsi = calculateRSI(closes);
        const macd = calculateMACD(closes);
        const volumeRatio = calculateVolumeRatio(volumes);

        if (!rsi || !macd) continue;

        // 잡주 2차 필터
        const recentCloses = closes.slice(-6);
        if (recentCloses.length >= 6) {
          const fiveDayReturn = (recentCloses[recentCloses.length - 1] - recentCloses[0]) / recentCloses[0] * 100;
          if (fiveDayReturn >= 30) continue;  // 5일 +30% 급등 제외
        }
        if (volumeRatio && volumeRatio >= 50) continue; // 거래량 50배 세력 제외
        if (currentPrice < 3000) continue;              // 3000원 미만 소액주 제외

        // 단기 모멘텀 스코어
        let score = 0;
        const scoreReasons = [];

        if (rsi >= 40 && rsi <= 65)              { score += 2; scoreReasons.push(`RSI ${Math.round(rsi)}`); }
        if (rsi > 65 && rsi < 75)                { score += 1; scoreReasons.push(`RSI ${Math.round(rsi)}상승`); }
        if (macd?.crossover === '골든크로스')     { score += 3; scoreReasons.push('골든크로스'); }
        if (macd?.crossover === '상승중')         { score += 1; scoreReasons.push('MACD상승'); }
        if (volumeRatio && volumeRatio >= 2)      { score += 2; scoreReasons.push(`거래량${volumeRatio}배`); }
        if (volumeRatio && volumeRatio >= 1.5)    { score += 1; scoreReasons.push(`거래량${volumeRatio}배`); }
        if (stock.changeRate && stock.changeRate >= 3) { score += 2; scoreReasons.push(`+${stock.changeRate}%`); }
        if (investor?.foreignNet > 0)             { score += 1; scoreReasons.push('외인매수'); }
        if (investor?.institutionNet > 0)         { score += 1; scoreReasons.push('기관매수'); }
        if (investor?.foreignConsecutiveDays >= 3){ score += 2; scoreReasons.push(`외인${investor.foreignConsecutiveDays}일연속`); }
        if (investor?.foreignNet5Days > 0)        { score += 1; scoreReasons.push('외인5일합산+'); }

        if (score < 3) continue; // 최소 스코어 미달 제외

        results.push({
          stock_name: stock.name,
          stock_code: stock.code,
          rsi,
          macd: macd.crossover,
          volume_ratio: volumeRatio,
          foreign_net: investor?.foreignNet ?? 0,
          institution_net: investor?.institutionNet ?? 0,
          current_price: currentPrice,
          score,
          reason: scoreReasons.join(', ')
        });
      } catch (err) {
        console.warn(`[Scan] ${stock.name}(${stock.code}) 스캔 실패:`, err.message);
      }
    }

    // 상위 20개 저장
    results.sort((a, b) => b.score - a.score);
    const top20 = results.slice(0, 20);

    const stmt = db.prepare(
      'INSERT INTO watchlist (date, stock_name, stock_code, rsi, macd, volume_ratio, foreign_net, institution_net, current_price, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const r of top20) {
      stmt.run(today, r.stock_name, r.stock_code, r.rsi, r.macd, r.volume_ratio, r.foreign_net, r.institution_net, r.current_price, r.reason);
    }

    console.log(`[Scan] 완료. 후보 ${candidates.length}종목 → 상위 ${top20.length}종목 저장.`);
    if (top20.length > 0) {
      console.log('[Scan] TOP5:', top20.slice(0, 5).map(r => `${r.stock_name}(${r.score}점)`).join(', '));
    }
  } catch (err) {
    console.error('[Scan] 스캔 오류:', err.message);
    await sendErrorAlert('[Scan] 동적 스캔 실패: ' + err.message);
  } finally {
    clearTimeout(timeout);
    isRunning = false;
  }
}

module.exports = { runScan };
