const { getDb } = require('../db/database');
const { getCurrentPrice, getDailyChart, getInvestorData, calculateRSI, calculateMACD, calculateVolumeRatio } = require('../services/kis');
const { isWeekday } = require('../services/holiday');
const { sendErrorAlert } = require('../services/alert');

let isRunning = false;

// 단기 모멘텀 상위 종목 추출을 위한 샘플 종목 목록
// 실제 운영 시 전체 KOSPI/KOSDAQ 2500종목으로 확장
const SCAN_UNIVERSE = [
  { name: '두산에너빌리티', code: '034020' },
  { name: 'SK하이닉스', code: '000660' },
  { name: '삼성전자', code: '005930' },
  { name: '한화에어로스페이스', code: '012450' },
  { name: 'LIG넥스원', code: '079550' },
  { name: '현대로템', code: '064350' },
  { name: 'HD현대중공업', code: '329180' },
  { name: '삼성SDI', code: '006400' },
  { name: 'POSCO홀딩스', code: '005490' },
  { name: 'NAVER', code: '035420' },
  { name: '카카오', code: '035720' },
  { name: '셀트리온', code: '068270' },
  { name: 'KB금융', code: '105560' },
  { name: '신한지주', code: '055550' },
  { name: 'LG에너지솔루션', code: '373220' },
  { name: '현대자동차', code: '005380' },
  { name: '기아', code: '000270' },
  { name: '삼성바이오로직스', code: '207940' },
  { name: '두산퓨얼셀', code: '336260' },
  { name: '한국전력', code: '015760' }
];

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
  const timeout = setTimeout(() => { isRunning = false; }, 10 * 60 * 1000);

  try {
    console.log('[Scan] 전체 종목 퀀트 스캔 시작');
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    db.prepare('DELETE FROM watchlist WHERE date = ?').run(today);

    const results = [];

    for (const stock of SCAN_UNIVERSE) {
      try {
        await delay(100);
        const [priceData, chartData, investorData] = await Promise.all([
          getCurrentPrice(stock.code),
          getDailyChart(stock.code, 30),
          getInvestorData(stock.code)
        ]);

        if (!priceData || !chartData || chartData.length < 15) continue;

        const closes = chartData.map(d => d.close);
        const volumes = chartData.map(d => d.volume);

        const rsi = calculateRSI(closes);
        const macd = calculateMACD(closes);
        const volumeRatio = calculateVolumeRatio(volumes);

        if (!rsi || !macd) continue;

        // 단기 모멘텀 스코어 계산
        let score = 0;
        if (rsi >= 40 && rsi <= 65) score += 2;
        if (macd?.crossover === '골든크로스') score += 3;
        if (macd?.crossover === '상승중') score += 1;
        if (volumeRatio && volumeRatio >= 1.5) score += 2;
        if (investorData?.foreignNet > 0) score += 1;
        if (investorData?.institutionNet > 0) score += 1;

        results.push({
          stock_name: stock.name,
          stock_code: stock.code,
          rsi,
          macd: macd.crossover,
          volume_ratio: volumeRatio,
          foreign_net: investorData?.foreignNet || 0,
          institution_net: investorData?.institutionNet || 0,
          score
        });
      } catch (err) {
        console.warn(`[Scan] ${stock.name} 스캔 실패:`, err.message);
      }
    }

    // 상위 20개 저장
    results.sort((a, b) => b.score - a.score);
    const top20 = results.slice(0, 20);

    const stmt = db.prepare(
      'INSERT INTO watchlist (date, stock_name, stock_code, rsi, macd, volume_ratio, foreign_net, institution_net, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const r of top20) {
      stmt.run(today, r.stock_name, r.stock_code, r.rsi, r.macd, r.volume_ratio, r.foreign_net, r.institution_net, `스코어: ${r.score}`);
    }

    console.log(`[Scan] 완료. 상위 ${top20.length}종목 저장.`);
  } catch (err) {
    console.error('[Scan] 스캔 오류:', err.message);
    await sendErrorAlert('[Scan] 전체 종목 스캔 실패: ' + err.message);
  } finally {
    clearTimeout(timeout);
    isRunning = false;
  }
}

module.exports = { runScan };
