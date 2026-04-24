const { sendMessage } = require('./kakao');

const SERVER_URL = `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}`;

function fmt(n) {
  if (n == null) return '-';
  return Math.round(n).toLocaleString();
}

function fmtRate(r) {
  if (r == null) return '-';
  return (r >= 0 ? '+' : '') + r.toFixed(2) + '%';
}

async function sendMorningLink() {
  const msg = `📋 오늘 자산현황을 입력해주세요
👉 ${SERVER_URL}/portfolio
⏰ 8시 10분까지 입력해주세요
입력하지 않으면 전일 데이터로 자동 분석합니다.`;
  return sendMessage(msg, '', 'morning_link');
}

async function sendMorningReport(holdings, assets, analysis, watchlist = []) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,'0')}.${String(now.getDate()).padStart(2,'0')}`;
  const isFriday = now.getDay() === 5;

  const holdingsText = holdings.map(h => `[${h.stock_name}] ${h.quantity}주
현재가: ${fmt(h.current_price)}원 (${fmtRate(h.changeRate)})
수익: ${h.profit_loss > 0 ? '+' : ''}${fmt(h.profit_loss)}원 (${fmtRate(h.profit_loss_rate)})
RSI: ${h.rsi ?? '-'} / MACD: ${h.macd ?? '-'}
손절가: ${fmt(h.trailingStop)}원 (트레일링)
→ AI 액션: ${analysis?.action ?? '분석중'}
근거: ${analysis?.reason?.slice(0, 50) ?? '-'}`
  ).join('\n\n');

  const top3 = watchlist.slice(0, 3);
  const watchText = top3.map((w, i) =>
    `${i+1}. ${w.stock_name} / RSI ${w.rsi} / 거래량배수 ${w.volume_ratio}`
  ).join('\n') || '데이터 없음';

  const msg = `📊 AI 트레이더 모닝 리포트 ${dateStr}

━━━━━━━━━━━━━━
💼 총 자산 현황
━━━━━━━━━━━━━━
보유주식: ${fmt(assets.stockValue)}원
현금: ${fmt(assets.cash)}원
총 운용: ${fmt(assets.total)}원

━━━━━━━━━━━━━━
📈 종목별 AI 액션
━━━━━━━━━━━━━━
${holdingsText}

━━━━━━━━━━━━━━
🔍 오늘 주목 종목 TOP3
━━━━━━━━━━━━━━
${watchText}

━━━━━━━━━━━━━━
💡 오늘 액션 플랜
━━━━━━━━━━━━━━
${analysis?.reason ?? '분석 데이터 부족'}
${isFriday ? '\n⚠️ 오늘 금요일: 오후 2시 이후 신규 진입 자제' : ''}

👉 ${SERVER_URL}`;

  return sendMessage(msg, '', 'morning_report');
}

async function sendUrgentAlert(holding, analysis, relevantNews = []) {
  const isSell = analysis?.action?.includes('매도');
  const emoji = isSell ? '⚠️' : '💡';
  const label = isSell ? '[긴급] 전량매도 권고' : '[분석] ' + analysis.action;

  const newsLine = relevantNews[0]?.news?.title || '뉴스 데이터 기반';

  let actionLine = `→ ${analysis.action}`;
  if (analysis.cash_recommendation === '재투자' && analysis.alternative_stock) {
    actionLine += ` 후 ${analysis.alternative_stock} 매수`;
    if (analysis.target_price) actionLine += `\n목표가: ${fmt(analysis.target_price)}원`;
    if (analysis.stop_loss) actionLine += ` / 손절가: ${fmt(analysis.stop_loss)}원`;
  } else if (analysis.cash_recommendation === '현금보유') {
    actionLine += ` 후 현금 보유\n이유: ${analysis.warning || '시장 불확실'}`;
  }

  const msg = `${emoji} ${label}

현재가: ${fmt(holding.current_price)}원 (${fmtRate(holding.changeRate)})
이슈: ${newsLine.slice(0, 60)}
퀀트: ${holding.rsi >= 70 || holding.rsi <= 30 ? '🔴' : '🟡'} / 뉴스: ${relevantNews.length > 0 ? '🔴' : '🟢'} / 수급: ${(holding.foreignNet < -100000 || holding.institutionNet < -100000) ? '🔴' : '🟡'}

${actionLine}

근거: ${analysis.reason?.slice(0, 80) ?? '-'}

👉 ${SERVER_URL}`;

  return sendMessage(msg, holding.stock_name, `urgent_${analysis.action}`);
}

async function sendTargetReached(holding, analysis) {
  const msg = `🎯 [목표가 도달] ${holding.stock_name}

현재가: ${fmt(holding.current_price)}원 / 수익: +${fmt(holding.profit_loss)}원 (${fmtRate(holding.profit_loss_rate)})
→ 전량 익절 후 ${analysis.cash_recommendation === '재투자' ? analysis.alternative_stock + ' 매수' : '현금 보유'}
시장 상황: ${analysis.reason?.slice(0, 40) ?? '-'}

👉 ${SERVER_URL}`;

  return sendMessage(msg, holding.stock_name, 'target_reached');
}

async function sendAddBuyAlert(holding, analysis, cashAvailable) {
  const newAvgPrice = Math.round(
    (holding.avg_price * holding.quantity + holding.current_price * Math.floor(cashAvailable / holding.current_price))
    / (holding.quantity + Math.floor(cashAvailable / holding.current_price))
  );

  const msg = `💰 [추가매수] ${holding.stock_name}

현재가: ${fmt(holding.current_price)}원 (단순 조정, 펀더멘털 이상 없음)
추가매수 시 새 평단: ${fmt(newAvgPrice)}원
→ 현금 ${fmt(cashAvailable)}원으로 추가매수 추천

👉 ${SERVER_URL}`;

  return sendMessage(msg, holding.stock_name, 'add_buy');
}

async function sendFridayCheck(analysis) {
  const now = new Date();
  const msg = `📋 [금요일 주말 점검]

시장 상황: ${analysis?.reason?.slice(0, 60) ?? '판단불가'}
→ ${analysis?.action ?? '판단불가'}
→ 월요일 진입 전략: ${analysis?.warning ?? '내일 재분석'}

👉 ${SERVER_URL}`;

  return sendMessage(msg, '', 'friday_check');
}

async function sendNightIssue(newsItem, haikuResult) {
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  const msg = `🌙 [야간 이슈] ${timeStr}

감지: ${haikuResult.reason?.slice(0, 60) ?? newsItem.title?.slice(0, 60)}
내일 모닝 리포트에서 AI 분석 예정`;

  return sendMessage(msg, '', 'night_issue');
}

async function sendClosingReport(holdings, assets, analysis, todaySonnetCount) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,'0')}.${String(now.getDate()).padStart(2,'0')}`;
  const isSunday = now.getDay() === 0;
  const isNextMonday = !isSunday;

  const totalPL = holdings.reduce((sum, h) => sum + (h.profit_loss || 0), 0);
  const totalRate = assets.total > 0 ? (totalPL / (assets.total - totalPL)) * 100 : 0;

  const holdingText = holdings.map(h =>
    `${h.stock_name}: ${fmtRate(h.profit_loss_rate)} (${h.profit_loss > 0 ? '+' : ''}${fmt(h.profit_loss)}원)`
  ).join('\n');

  const msg = `📋 오늘 결산 ${dateStr}

━━━━━━━━━━━━━━
💰 오늘 손익
━━━━━━━━━━━━━━
${holdingText}
총 평가손익: ${totalPL > 0 ? '+' : ''}${fmt(totalPL)}원

━━━━━━━━━━━━━━
📊 AI 운영 현황
━━━━━━━━━━━━━━
Sonnet: ${todaySonnetCount}회 / 15회

━━━━━━━━━━━━━━
🌍 내일 전망
━━━━━━━━━━━━━━
${analysis?.reason?.slice(0, 60) ?? '데이터 부족'}
${isNextMonday ? '\n⚠️ 내일 월요일: 주말 효과 하락 가능' : ''}

👉 ${SERVER_URL}`;

  return sendMessage(msg, '', 'closing_report');
}

async function sendWeeklyReport(performanceData) {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 6);
  const dateRange = `${weekStart.getMonth()+1}.${weekStart.getDate()}~${now.getMonth()+1}.${now.getDate()}`;

  const msg = `📈 주간 성과 ${dateRange}

수익률: ${fmtRate(performanceData.weeklyRate)}
익절 횟수: ${performanceData.sellCount ?? 0}회
실현 수익: +${fmt(performanceData.realizedProfit)}원
시드 성장: ${fmt(performanceData.startAssets)}원 → ${fmt(performanceData.endAssets)}원
현금 보유 판단: ${performanceData.cashHoldCount ?? 0}회 (손실 방어)
AI 적중률: ${performanceData.accuracyRate ?? '-'}%

다음 주 전략: ${performanceData.nextStrategy ?? '월요일 모닝 리포트 참고'}
⚠️ 월요일: 주말 효과 대비 전략 수립 필요

👉 ${SERVER_URL}`;

  return sendMessage(msg, '', 'weekly_report');
}

async function sendApiLimitAlert() {
  const msg = `⚠️ 오늘 AI 분석 한도 15회 도달. 내일 오전 자동 재개됩니다.`;
  return sendMessage(msg, '', 'api_limit');
}

async function sendErrorAlert(errorMsg) {
  const msg = `🚨 시스템 오류\n${errorMsg.slice(0, 100)}`;
  return sendMessage(msg, '', 'error');
}

module.exports = {
  sendMorningLink,
  sendMorningReport,
  sendUrgentAlert,
  sendTargetReached,
  sendAddBuyAlert,
  sendFridayCheck,
  sendNightIssue,
  sendClosingReport,
  sendWeeklyReport,
  sendApiLimitAlert,
  sendErrorAlert
};
