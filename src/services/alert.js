const { sendTelegram: sendMessage } = require('./telegram');

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
  const msg = `📋 오늘 자산현황을 입력해주세요\n👉 ${SERVER_URL}/portfolio.html\n⏰ 8시 10분까지 입력해주세요\n입력하지 않으면 전일 데이터로 자동 분석합니다.`;
  return sendMessage(msg, '', 'morning_link');
}

// 장 중 긴급 알림 (매도/매수 신호 시)
async function sendUrgentAlert(holding, analysis, relevantNews = []) {
  const action = analysis?.action || '';
  const isSell = action.includes('매도');
  const isProfit = isSell && (holding.profitRate || 0) > 0;
  const isLoss = isSell && (holding.profitRate || 0) <= 0;
  const isSwitch = action.includes('갈아타기') || action.includes('switch');
  const isHold = action.includes('보유');

  // 갈아타기 전용 포맷
  if (isSwitch && analysis.switch_stock?.name) {
    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const days = ['일','월','화','수','목','금','토'];
    const dateHeader = `${String(kst.getUTCMonth()+1).padStart(2,'0')}/${String(kst.getUTCDate()).padStart(2,'0')} (${days[kst.getUTCDay()]}) ${String(kst.getUTCHours()).padStart(2,'0')}:${String(kst.getUTCMinutes()).padStart(2,'0')}`;
    const sw = analysis.switch_stock;
    const availCash = (holding.current_price || holding.avg_price) * (holding.quantity || 1);
    const buyableQty = sw.entry_price ? Math.floor(availCash / sw.entry_price) : null;

    let msg = `🔄 [갈아타기] ${dateHeader}\n`;
    msg += `${holding.stock_name || '현 종목'} → ${sw.name}\n\n`;
    if (analysis.why_sell_now) msg += `현 종목 매도 근거: ${analysis.why_sell_now.slice(0,100)}\n`;
    msg += `─────────────\n`;
    msg += `신규: ${sw.name}${sw.code ? `(${sw.code})` : ''}\n`;
    if (sw.entry_price) {
      msg += `현재가: ${sw.entry_price.toLocaleString()}원 (REST실시간)\n`;
      msg += `진입가: ${sw.entry_price.toLocaleString()}원`;
      if (buyableQty) msg += ` / 수량: ${buyableQty}주`;
      msg += '\n';
    }
    if (sw.target_price) {
      const grossRate = sw.entry_price ? Math.round(((sw.target_price - sw.entry_price) / sw.entry_price) * 1000) / 10 : null;
      const netRate = grossRate ? Math.round((grossRate - 0.2) * 10) / 10 : null;
      msg += `목표가: ${sw.target_price.toLocaleString()}원${grossRate ? ` (+${grossRate}% / 실질 +${netRate}%)` : ''}\n`;
    }
    if (sw.stop_loss) {
      const stopGross = sw.entry_price ? Math.round(((sw.entry_price - sw.stop_loss) / sw.entry_price) * 1000) / 10 : null;
      const stopNet = stopGross ? Math.round((stopGross + 0.2) * 10) / 10 : null;
      msg += `손절가: ${sw.stop_loss.toLocaleString()}원${stopGross ? ` (-${stopGross}% / 실질 -${stopNet}%)` : ''}\n`;
    }
    msg += `트레일링 스탑: 고점 -7%\n`;
    if (analysis.why_switch) msg += `갈아타기 근거: ${analysis.why_switch.slice(0,150)}\n`;
    if (sw.expected_upside) msg += `예상수익률: ${sw.expected_upside}\n`;
    msg += `───────────────\n👉 ${SERVER_URL}`;
    return sendMessage(msg, sw.name, `switch_${holding.stock_code || holding.stock_name}`, true);
  }

  // 기존 알림 포맷 (갈아타기 아닌 경우)
  let headerIcon, label;
  if (isProfit)       { headerIcon = '💰'; label = '[익절] 전량매도 권고'; }
  else if (isLoss)    { headerIcon = '📉'; label = '[손절] 전량매도 권고'; }
  else if (isSell)    { headerIcon = '🔴'; label = '[긴급] 전량매도 권고'; }
  else if (isHold)    { headerIcon = '💡'; label = `[분석] ${action}`; }
  else                { headerIcon = '📊'; label = `[분석] ${action}`; }

  const newsLine = relevantNews[0]?.title || null;

  let actionLine = `→ ${action}`;
  if (analysis.cash_recommendation === '재투자' && analysis.switch_stock?.name) {
    actionLine += ` → ${analysis.switch_stock.name} 매수`;
    if (analysis.switch_stock.target_price) actionLine += `\n🎯 목표가: ${fmt(analysis.switch_stock.target_price)}원`;
    if (analysis.switch_stock.stop_loss) actionLine += ` / 🛡 손절가: ${fmt(analysis.switch_stock.stop_loss)}원`;
  } else if (analysis.cash_recommendation === '현금보유') {
    actionLine += ` → 현금 보유`;
    if (analysis.why_cash) actionLine += `\n이유: ${analysis.why_cash}`;
    else if (analysis.warning) actionLine += `\n이유: ${analysis.warning}`;
  }

  const rsiFlag = (holding.rsi >= 70 || holding.rsi <= 30) ? '🔴' : '🟡';
  const newsFlag = relevantNews.length > 0 ? '🔴' : '🟢';
  const supplyFlag = (holding.foreignNet < -100000 || holding.institutionNet < -100000) ? '🔴' : '🟡';

  let msg = `${headerIcon} ${label} — ${holding.stock_name}\n\n`;
  msg += `현재가: ${fmt(holding.current_price)}원 (${fmtRate(holding.changeRate)})\n`;
  if (holding.foreignNet != null) msg += `외인: ${holding.foreignNet >= 0 ? '+' : ''}${holding.foreignNet.toLocaleString()}주\n`;
  if (holding.institutionNet != null) msg += `기관: ${holding.institutionNet >= 0 ? '+' : ''}${holding.institutionNet.toLocaleString()}주\n`;
  msg += `퀀트: ${rsiFlag} RSI ${holding.rsi ?? '-'} / 뉴스: ${newsFlag} / 수급: ${supplyFlag}\n`;
  if (newsLine) msg += `📰 이슈: ${newsLine.slice(0, 60)}\n`;
  msg += `\n${actionLine}\n\n`;

  if (analysis.why_sell_now) msg += `💰 익절 이유: ${analysis.why_sell_now}\n\n`;
  if (analysis.why_hold) msg += `🤚 보유 이유: ${analysis.why_hold}\n\n`;
  if (analysis.news_impact) msg += `📰 뉴스: ${analysis.news_impact}\n\n`;
  if (analysis.target_price) msg += `🎯 목표가 ${fmt(analysis.target_price)}원\n`;
  if (analysis.stop_loss) msg += `🛡 손절가 ${fmt(analysis.stop_loss)}원\n`;
  if (analysis.target_price || analysis.stop_loss) msg += '\n';

  msg += `근거: ${analysis.reason || '-'}\n\n`;
  msg += `👉 ${SERVER_URL}`;

  return sendMessage(msg, holding.stock_name, `urgent_${action}`, true);
}

// API 한도 도달 알림
async function sendApiLimitAlert() {
  const msg = `⚠️ AI 분석 한도 도달\n오늘 Sonnet 호출 한도에 도달했습니다.\n내일 오전 자동 재개됩니다.`;
  return sendMessage(msg, '', 'api_limit');
}

// 시스템 오류 알림
async function sendErrorAlert(errorMsg) {
  const msg = `🚨 시스템 오류 발생\n${errorMsg.slice(0, 100)}\n\n👉 ${SERVER_URL}`;
  return sendMessage(msg, '', 'error', true);
}

module.exports = {
  sendMorningLink,
  sendUrgentAlert,
  sendApiLimitAlert,
  sendErrorAlert
};
