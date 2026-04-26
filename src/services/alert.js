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

// 08:00 자산입력 링크 발송
async function sendMorningLink() {
  const msg = `📋 오늘 자산현황을 입력해주세요
👉 ${SERVER_URL}/portfolio.html
⏰ 8시 10분까지 입력해주세요
입력하지 않으면 전일 데이터로 자동 분석합니다.`;
  return sendMessage(msg, '', 'morning_link');
}

// 장 중 긴급 알림 (매도/매수 신호 시)
async function sendUrgentAlert(holding, analysis, relevantNews = []) {
  const isSell = (analysis?.action || '').includes('매도');
  const emoji = isSell ? '⚠️' : '💡';
  const label = isSell ? '[긴급] 전량매도 권고' : `[분석] ${analysis.action}`;

  const newsLine = relevantNews[0]?.title || '뉴스 데이터 기반';

  let actionLine = `→ ${analysis.action}`;
  if (analysis.cash_recommendation === '재투자' && analysis.alternative_stock) {
    actionLine += ` 후 ${analysis.alternative_stock} 매수`;
    if (analysis.target_price) actionLine += `\n🎯 목표가: ${fmt(analysis.target_price)}원`;
    if (analysis.stop_loss) actionLine += ` / 🛡 손절가: ${fmt(analysis.stop_loss)}원`;
  } else if (analysis.cash_recommendation === '현금보유') {
    actionLine += ` 후 현금 보유`;
    if (analysis.why_cash) actionLine += `\n이유: ${analysis.why_cash}`;
    else if (analysis.warning) actionLine += `\n이유: ${analysis.warning}`;
  }

  const rsiFlag = (holding.rsi >= 70 || holding.rsi <= 30) ? '🔴' : '🟡';
  const newsFlag = relevantNews.length > 0 ? '🔴' : '🟢';
  const supplyFlag = (holding.foreignNet < -100000 || holding.institutionNet < -100000) ? '🔴' : '🟡';

  let msg = `${emoji} ${label} — ${holding.stock_name}\n\n`;
  msg += `현재가: ${fmt(holding.current_price)}원 (${fmtRate(holding.changeRate)})\n`;
  if (holding.foreignNet != null) msg += `외국인: ${holding.foreignNet > 0 ? '+' : ''}${holding.foreignNet.toLocaleString()}주\n`;
  if (holding.institutionNet != null) msg += `기관: ${holding.institutionNet > 0 ? '+' : ''}${holding.institutionNet.toLocaleString()}주\n`;
  msg += `퀀트: ${rsiFlag} RSI ${holding.rsi ?? '-'} / 뉴스: ${newsFlag} / 수급: ${supplyFlag}\n`;
  if (newsLine) msg += `이슈: ${newsLine.slice(0, 60)}\n`;
  msg += `\n${actionLine}\n\n`;

  // 상세 판단 근거
  if (analysis.why_sell_now) msg += `💰 익절 이유: ${analysis.why_sell_now}\n\n`;
  if (analysis.why_hold) msg += `🤚 보유 이유: ${analysis.why_hold}\n\n`;
  if (analysis.news_impact) msg += `📰 뉴스: ${analysis.news_impact}\n\n`;

  msg += `근거: ${(analysis.reason || '-').slice(0, 100)}\n\n`;
  msg += `👉 ${SERVER_URL}`;

  return sendMessage(msg, holding.stock_name, `urgent_${analysis.action}`);
}

// API 한도 도달 알림
async function sendApiLimitAlert() {
  const msg = `⚠️ 오늘 AI 분석 한도 15회 도달. 내일 오전 자동 재개됩니다.`;
  return sendMessage(msg, '', 'api_limit');
}

// 시스템 오류 알림
async function sendErrorAlert(errorMsg) {
  const msg = `🚨 시스템 오류\n${errorMsg.slice(0, 100)}`;
  return sendMessage(msg, '', 'error');
}

module.exports = {
  sendMorningLink,
  sendUrgentAlert,
  sendApiLimitAlert,
  sendErrorAlert
};
