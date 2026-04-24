const { getDb } = require('../db/database');
const { sendKakao } = require('../services/kakao');
const { sendErrorAlert } = require('../services/alert');

// Sonnet 호출 없음 - DB 이력만으로 계산
async function runWeeklyReport() {
  if (new Date().getDay() !== 0) return; // 일요일만

  console.log('[Weekly] 주간 성과 리포트 시작 (Sonnet 호출 없음)');

  try {
    const db = getDb();
    const today = new Date();
    const monday = new Date(today);
    monday.setDate(today.getDate() - 6);

    const startDate = monday.toISOString().slice(0, 10);
    const endDate = today.toISOString().slice(0, 10);

    // 주간 시드 성장 데이터
    const seedData = db.prepare(
      'SELECT * FROM seed_growth WHERE date >= ? AND date <= ? ORDER BY date'
    ).all(startDate, endDate);

    if (seedData.length === 0) {
      console.log('[Weekly] 이번 주 데이터 없음');
      return;
    }

    const firstDay = seedData[0];
    const lastDay = seedData[seedData.length - 1];

    const startSeed = firstDay.total_assets || 0;
    const endSeed = lastDay.total_assets || 0;
    const seedGrowth = endSeed - startSeed;
    const seedGrowthRate = startSeed > 0 ? ((seedGrowth / startSeed) * 100) : 0;

    // 익절 횟수 합산
    const totalSellCount = seedData.reduce((sum, d) => sum + (d.sell_count || 0), 0);
    const totalRealizedProfit = seedData.reduce((sum, d) => sum + (d.realized_profit || 0), 0);
    const totalCashHold = seedData.reduce((sum, d) => sum + (d.cash_hold_count || 0), 0);

    // AI 적중률 계산
    const analyses = db.prepare(
      "SELECT * FROM analysis WHERE date >= ? AND date <= ? AND actual_result IS NOT NULL"
    ).all(startDate, endDate);

    let accuracy = null;
    if (analyses.length > 0) {
      const correct = analyses.filter(a => a.actual_result === 'correct').length;
      accuracy = Math.round((correct / analyses.length) * 100);
    }

    // 주간 성과 리포트 (Sonnet 없음)
    const weekStr = `${monday.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })}~${today.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })}`;
    const serverUrl = `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}`;

    const seedSign = seedGrowthRate >= 0 ? '+' : '';
    let msg = `📈 주간 성과 ${weekStr}\n\n`;
    msg += `수익률: ${seedSign}${seedGrowthRate.toFixed(1)}%\n`;
    msg += `익절 횟수: ${totalSellCount}회\n`;
    msg += `실현 수익: +${Math.round(totalRealizedProfit).toLocaleString()}원\n`;
    msg += `시드 성장: ${Math.round(startSeed / 10000)}만원 → ${Math.round(endSeed / 10000)}만원\n`;
    msg += `현금 보유 판단: ${totalCashHold}회 (손실 방어)\n`;

    if (accuracy !== null) {
      msg += `AI 적중률: ${accuracy}%\n`;
    }

    msg += `\n다음 주 전략: 이번 주 데이터 기반 분석 (내일 모닝 리포트 확인)\n`;
    msg += `⚠️ 월요일: 주말 효과 대비 전략 - 급락 시 악재 여부 먼저 확인\n`;

    msg += `\n👉 ${serverUrl}`;

    // DB performance 저장
    const perf = db.prepare(
      `INSERT INTO performance (week, total_recommendations, correct_recommendations, accuracy_rate, total_profit_loss, sell_count, cash_hold_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    perf.run(
      weekStr,
      analyses.length,
      analyses.filter(a => a.actual_result === 'correct').length,
      accuracy || 0,
      totalRealizedProfit,
      totalSellCount,
      totalCashHold
    );

    await sendKakao(msg);
    console.log('[Weekly] 주간 성과 리포트 발송 완료');
  } catch (err) {
    console.error('[Weekly] 주간 성과 리포트 오류:', err.message);
    await sendErrorAlert('[Weekly] 주간 성과 리포트 실패: ' + err.message);
  }
}

module.exports = { runWeeklyReport };
