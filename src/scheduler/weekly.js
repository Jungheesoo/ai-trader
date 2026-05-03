const { getDb } = require('../db/database');
const { sendTelegram } = require('../services/telegram');
const { sendErrorAlert } = require('../services/alert');
const { nowKST } = require('../services/dateutil');

// Sonnet 호출 없음 - DB 이력만으로 계산
async function runWeeklyReport() {
  if (new Date().getDay() !== 0) return; // 일요일만

  console.log('[Weekly] 주간 성과 리포트 시작 (Sonnet 호출 없음)');

  try {
    const db = getDb();
    const today = nowKST();
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

    // trades 테이블 집계 (정확한 실현 손익)
    const tradeRows = db.prepare(
      "SELECT trade_type, SUM(profit_loss) as total, COUNT(*) as cnt FROM trades WHERE date >= ? AND date <= ? AND trade_type IN ('sell_profit', 'sell_loss', 'switch') GROUP BY trade_type"
    ).all(startDate, endDate);

    let profitCount = 0, profitTotal = 0, lossCount = 0, lossTotal = 0;
    for (const t of tradeRows) {
      if (t.trade_type === 'sell_profit' || t.trade_type === 'switch') {
        profitCount += t.cnt; profitTotal += (t.total || 0);
      } else if (t.trade_type === 'sell_loss') {
        lossCount += t.cnt; lossTotal += (t.total || 0);
      }
    }
    const totalTradeCount = profitCount + lossCount;
    const netRealizedPL = profitTotal + lossTotal;
    const winRate = totalTradeCount > 0 ? Math.round((profitCount / totalTradeCount) * 100) : null;

    // seed_growth 기반 보조 합산
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

    const weekStr = `${monday.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })}~${today.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })}`;
    const serverUrl = `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}`;

    const seedSign = seedGrowthRate >= 0 ? '+' : '';
    let msg = `📊 AI 트레이더 주간 성과 ${weekStr}\n\n`;

    msg += `━━━━━━━━━━━━━━\n📈 이번 주 매매 성과\n━━━━━━━━━━━━━━\n`;
    msg += `총 매매: ${totalTradeCount}회\n`;
    if (profitCount > 0) msg += `익절: ${profitCount}회 / +${Math.round(profitTotal).toLocaleString()}원\n`;
    if (lossCount > 0) msg += `손절: ${lossCount}회 / ${Math.round(lossTotal).toLocaleString()}원\n`;
    if (winRate !== null) msg += `승률: ${winRate}%\n`;
    const netSign = netRealizedPL >= 0 ? '+' : '';
    msg += `순 실현 손익: ${netSign}${Math.round(netRealizedPL).toLocaleString()}원\n\n`;

    msg += `━━━━━━━━━━━━━━\n💰 시드 변화\n━━━━━━━━━━━━━━\n`;
    msg += `주초: ${Math.round(startSeed / 10000)}만원 → 주말: ${Math.round(endSeed / 10000)}만원\n`;
    msg += `성장률: ${seedSign}${seedGrowthRate.toFixed(1)}%\n`;
    msg += `현금 보유 판단: ${totalCashHold}회\n\n`;

    if (accuracy !== null) {
      msg += `━━━━━━━━━━━━━━\n🤖 AI 적중률\n━━━━━━━━━━━━━━\n`;
      const total = analyses.length;
      const correct = analyses.filter(a => a.actual_result === 'correct').length;
      msg += `${total}회 추천 / ${correct}회 적중 (${accuracy}%)\n\n`;
    }

    msg += `━━━━━━━━━━━━━━\n📅 다음 주 전략\n━━━━━━━━━━━━━━\n`;
    msg += `데이터 기반 분석: 내일 모닝 리포트 확인\n`;
    msg += `⚠️ 월요일: 주말 효과 대비 — 급락 시 악재 여부 먼저 확인\n`;

    msg += `\n👉 ${serverUrl}`;

    const perf = db.prepare(
      `INSERT INTO performance (week, total_recommendations, correct_recommendations, accuracy_rate, total_profit_loss, sell_count, cash_hold_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    perf.run(
      weekStr,
      analyses.length,
      analyses.filter(a => a.actual_result === 'correct').length,
      accuracy || 0,
      netRealizedPL,
      totalTradeCount,
      totalCashHold
    );

    await sendTelegram(msg);
    console.log('[Weekly] 주간 성과 리포트 발송 완료');
  } catch (err) {
    console.error('[Weekly] 주간 성과 리포트 오류:', err.message);
    await sendErrorAlert('[Weekly] 주간 성과 리포트 실패: ' + err.message);
  }
}

module.exports = { runWeeklyReport };
