'use strict';
const { getDb } = require('../db/database');
const { callSonnet } = require('../services/claude-sonnet');
const { sendKakao } = require('../services/kakao');
const { sendErrorAlert } = require('../services/alert');

// 이번 달 마지막 금요일 여부 판단
function isLastFridayOfMonth() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  if (kst.getUTCDay() !== 5) return false;
  const nextFriday = new Date(kst.getTime() + 7 * 24 * 60 * 60 * 1000);
  return nextFriday.getUTCMonth() !== kst.getUTCMonth();
}

async function runMonthlyReport() {
  if (!isLastFridayOfMonth()) return;
  console.log('[Monthly] 월간 리포트 시작');

  try {
    const db = getDb();
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const monthStr = `${year}년 ${String(month).padStart(2, '0')}월`;

    const firstDay = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = now.toISOString().slice(0, 10);

    // 월간 trades 집계
    const tradeRows = db.prepare(
      "SELECT trade_type, stock_name, SUM(profit_loss) as total, MAX(profit_loss) as max_pl, MIN(profit_loss) as min_pl, COUNT(*) as cnt FROM trades WHERE date >= ? AND date <= ? AND trade_type IN ('sell_profit', 'sell_loss', 'switch') GROUP BY trade_type"
    ).all(firstDay, lastDay);

    let profitCount = 0, profitTotal = 0, lossCount = 0, lossTotal = 0;
    for (const t of tradeRows) {
      if (t.trade_type === 'sell_profit' || t.trade_type === 'switch') {
        profitCount += t.cnt; profitTotal += (t.total || 0);
      } else if (t.trade_type === 'sell_loss') {
        lossCount += t.cnt; lossTotal += (t.total || 0);
      }
    }
    const totalCount = profitCount + lossCount;
    const netPL = profitTotal + lossTotal;
    const winRate = totalCount > 0 ? Math.round(profitCount / totalCount * 100) : null;

    // 최고 수익 / 최저 손실 종목
    const bestTrade = db.prepare(
      "SELECT stock_name, profit_loss FROM trades WHERE date >= ? AND date <= ? ORDER BY profit_loss DESC LIMIT 1"
    ).get(firstDay, lastDay);
    const worstTrade = db.prepare(
      "SELECT stock_name, profit_loss FROM trades WHERE date >= ? AND date <= ? ORDER BY profit_loss ASC LIMIT 1"
    ).get(firstDay, lastDay);

    // seed_growth 월간 변화
    const seedStart = db.prepare(
      'SELECT total_assets FROM seed_growth WHERE date >= ? ORDER BY date ASC LIMIT 1'
    ).get(firstDay);
    const seedEnd = db.prepare(
      'SELECT total_assets FROM seed_growth WHERE date <= ? ORDER BY date DESC LIMIT 1'
    ).get(lastDay);

    const startAssets = seedStart?.total_assets || 0;
    const endAssets = seedEnd?.total_assets || 0;
    const growthRate = startAssets > 0 ? ((endAssets - startAssets) / startAssets * 100) : 0;

    // AI 적중률
    const analyses = db.prepare(
      "SELECT actual_result FROM analysis WHERE date >= ? AND date <= ? AND actual_result IS NOT NULL"
    ).all(firstDay, lastDay);
    const accuracy = analyses.length > 0
      ? Math.round(analyses.filter(a => a.actual_result === 'correct').length / analyses.length * 100)
      : null;

    // Sonnet 1회 호출 - 다음 달 전략
    const sonnetPrompt = {
      report_type: 'monthly_strategy',
      month: monthStr,
      monthly_stats: {
        total_trades: totalCount,
        profit_count: profitCount,
        loss_count: lossCount,
        win_rate: winRate,
        net_realized_pl: netPL,
        seed_start: startAssets,
        seed_end: endAssets,
        growth_rate: Math.round(growthRate * 100) / 100
      },
      next_month_context: `다음 달(${year}년 ${String(month + 1 > 12 ? 1 : month + 1).padStart(2, '0')}월) 단기 투자 전략을 제시하세요. 이번 달 성과를 바탕으로 개선점과 주목 섹터를 제안하세요.`
    };

    const aiResult = await callSonnet(sonnetPrompt, 'monthly_report');

    const msg = formatMonthlyReport(monthStr, totalCount, profitCount, profitTotal, lossCount, lossTotal, winRate, netPL, startAssets, endAssets, growthRate, bestTrade, worstTrade, accuracy, analyses.length, aiResult);
    await sendKakao(msg);

    console.log('[Monthly] 월간 리포트 발송 완료');
  } catch (err) {
    console.error('[Monthly] 월간 리포트 오류:', err.message);
    await sendErrorAlert('[Monthly] 월간 리포트 실패: ' + err.message);
  }
}

function formatMonthlyReport(monthStr, totalCount, profitCount, profitTotal, lossCount, lossTotal, winRate, netPL, startAssets, endAssets, growthRate, bestTrade, worstTrade, accuracy, analysisTotal, ai) {
  const serverUrl = `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}`;
  let msg = `📅 AI 트레이더 월간 리포트 ${monthStr}\n\n`;

  msg += `━━━━━━━━━━━━━━\n💰 이번 달 실현 손익\n━━━━━━━━━━━━━━\n`;
  if (profitCount > 0) msg += `익절: ${profitCount}회 / +${Math.round(profitTotal).toLocaleString()}원\n`;
  if (lossCount > 0) msg += `손절: ${lossCount}회 / ${Math.round(lossTotal).toLocaleString()}원\n`;
  if (winRate !== null) msg += `승률: ${winRate}%\n`;
  const netSign = netPL >= 0 ? '+' : '';
  msg += `순 실현 손익: ${netSign}${Math.round(netPL).toLocaleString()}원\n\n`;

  msg += `━━━━━━━━━━━━━━\n📈 시드 성장\n━━━━━━━━━━━━━━\n`;
  msg += `월초: ${Math.round(startAssets / 10000)}만원\n`;
  msg += `월말: ${Math.round(endAssets / 10000)}만원\n`;
  const growthSign = growthRate >= 0 ? '+' : '';
  msg += `성장률: ${growthSign}${growthRate.toFixed(1)}%\n\n`;

  if (bestTrade || worstTrade) {
    msg += `━━━━━━━━━━━━━━\n🏆 이달 최고/최저\n━━━━━━━━━━━━━━\n`;
    if (bestTrade?.profit_loss > 0) msg += `최고 수익: +${Math.round(bestTrade.profit_loss).toLocaleString()}원 (${bestTrade.stock_name})\n`;
    if (worstTrade?.profit_loss < 0) msg += `최저 손실: ${Math.round(worstTrade.profit_loss).toLocaleString()}원 (${worstTrade.stock_name})\n`;
    msg += '\n';
  }

  if (accuracy !== null) {
    msg += `━━━━━━━━━━━━━━\n🤖 AI 적중률\n━━━━━━━━━━━━━━\n`;
    msg += `추천: ${analysisTotal}회 / 적중: ${Math.round(analysisTotal * accuracy / 100)}회 (${accuracy}%)\n\n`;
  }

  msg += `━━━━━━━━━━━━━━\n📊 다음 달 전략\n━━━━━━━━━━━━━━\n`;
  if (ai?.reason) {
    msg += `${ai.reason.slice(0, 200)}\n`;
    if (ai.market_outlook) msg += `전망: ${ai.market_outlook}\n`;
    if (ai.key_risk) msg += `리스크: ${ai.key_risk}\n`;
  } else {
    msg += `모닝 리포트 및 watchlist 기반으로 단기 모멘텀 종목 집중\n`;
  }
  msg += '\n';

  msg += `👉 ${serverUrl}`;
  return msg;
}

module.exports = { runMonthlyReport };
