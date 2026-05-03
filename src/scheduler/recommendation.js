'use strict';
const { getDb } = require('../db/database');
const { callSonnet } = require('../services/claude-sonnet');
const { sendTelegram } = require('../services/telegram');
const { isHoliday } = require('../services/holiday');
const { getPortfolioSummary } = require('../services/portfolio');
const { getCurrentPrices } = require('../services/kis');
const { isConnected } = require('../services/kis-websocket');
const { getTodayKST } = require('../services/dateutil');
const { calcRealPnL } = require('../services/portfolio');

async function runStockRecommendation() {
  if (isHoliday(new Date())) return;
  console.log('[Recommend] 09:05 종목 추천 시작');

  const db = getDb();
  const today = getTodayKST();
  const SERVER_URL = `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}`;
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const days = ['일','월','화','수','목','금','토'];
  const dateHeader = `${String(kst.getUTCMonth()+1).padStart(2,'0')}/${String(kst.getUTCDate()).padStart(2,'0')} (${days[kst.getUTCDay()]}) 09:05`;

  try {
    // 1. watchlist 확인
    const watchlist = db.prepare(
      'SELECT * FROM watchlist WHERE date = ? ORDER BY score DESC LIMIT 10'
    ).all(today);

    // 2. watchlist 없으면 추천 불가
    if (watchlist.length === 0) {
      await sendTelegram(
        `⏸ [종목 추천 불가] ${dateHeader}\n스캔 데이터 없음 — 현금 보유 유지\n조치: 수동으로 시장 확인 필요\n👉 ${SERVER_URL}`,
        'system', 'recommend_no_data', true
      );
      return;
    }

    // 3. WS 연결 상태 확인
    const wsOk = isConnected();

    // 4. REST API로 현재가 실시간 조회
    const portfolio = await getPortfolioSummary();
    const allCodes = [
      ...portfolio.holdings.map(h => h.stock_code).filter(Boolean),
      ...watchlist.map(w => w.stock_code).filter(Boolean)
    ];
    const restPrices = allCodes.length > 0 ? await getCurrentPrices(allCodes) : {};

    // 5. watchlist 가격 보정
    watchlist.forEach(w => {
      if (restPrices[w.stock_code]) {
        w.current_price = restPrices[w.stock_code];
        w.priceLabel = '(REST실시간)';
      } else {
        w.priceLabel = '(스캔기준⚠️)';
      }
    });

    // 6. 모닝 전략 로드
    const morningStrategy = db.prepare(
      'SELECT * FROM morning_strategy WHERE date = ?'
    ).get(today);

    // 7. 시나리오 판단
    const availCash = (portfolio.cash || 0) + (portfolio.newInvestment || 0);
    const hasHoldings = portfolio.holdings && portfolio.holdings.length > 0;
    let scenario = '';
    if (!hasHoldings && availCash > 0) scenario = 'A';
    else if (hasHoldings && availCash > 0) scenario = 'B';
    else if (hasHoldings) scenario = 'C';
    else {
      await sendTelegram(
        `⏸ [종목 추천 불가] ${dateHeader}\n현금 없음 + 보유 종목 없음\n👉 ${SERVER_URL}`,
        'system', 'recommend_no_asset', false
      );
      return;
    }

    // 8. Sonnet 프롬프트 구성
    const wsWarning = !wsOk
      ? '⚠️ WS 미연결 — 진입가는 REST API 기준 (실시간 체결강도 없음)\n\n'
      : '';

    const holdingsText = hasHoldings
      ? portfolio.holdings.map(h => {
          const real = calcRealPnL(h.avg_price, h.current_price || h.avg_price, h.quantity);
          return `${h.stock_name}(${h.stock_code}) ${h.quantity}주 평단 ${h.avg_price?.toLocaleString()}원
현재가: ${(h.current_price || h.avg_price)?.toLocaleString()}원
실질손익: ${real.realPnL >= 0 ? '+' : ''}${real.realPnL.toLocaleString()}원 (${real.realPnLRate}%) / 예상제세금: ${real.sellTax.toLocaleString()}원
RSI: ${h.rsi ?? '없음'} / MACD: ${h.macd ?? '없음'}`;
        }).join('\n\n')
      : '없음 (현금 보유 중)';

    const watchlistText = watchlist.slice(0, 3).map(w => {
      const buyableQty = w.current_price ? Math.floor(availCash / w.current_price) : 0;
      return `${w.stock_name}(${w.stock_code}) ${w.current_price?.toLocaleString()}원 ${w.priceLabel}
score: ${w.score}점 / RSI: ${Math.round(w.rsi||0)} / MACD: ${w.macd} / 거래량: ${w.volume_ratio}배
외인: ${w.foreign_net>=0?'+':''}${w.foreign_net?.toLocaleString()}주 / 기관: ${w.institution_net>=0?'+':''}${w.institution_net?.toLocaleString()}주
최대매수: ${buyableQty}주 / 근거: ${w.reason}`;
    }).join('\n\n');

    const prompt = `${wsWarning}[09:05 종목 추천 요청]
모닝 전략: ${morningStrategy?.strategy?.slice(0, 100) || '없음'}
시나리오: ${scenario === 'A' ? 'A — 현금만 있음' : scenario === 'B' ? 'B — 보유종목 + 현금' : 'C — 갈아타기 검토'}
투자 가능 현금: ${availCash.toLocaleString()}원

=== 보유 종목 ===
${holdingsText}

=== watchlist 상위 3종목 (score 기준) ===
${watchlistText}

[시나리오별 판단 원칙]
시나리오A: watchlist 6조건 모두 충족 시만 buy_new. 미충족 시 hold_cash.
시나리오B: 추가매수(평단-3%이하+수급유지) vs 신규매수(6조건충족) 비교. 미충족 시 hold_cash.
시나리오C: 신규종목이 1.5배 이상 유리할 때만. 제세금 0.20% 왕복 차감 후 비교. 미충족 시 hold.

[보유 기간 원칙]
기본 보유: 2~5일 (단기 스윙)
매수 당일은 -5% 이상 급락 아니면 매도 금지
목표가 미도달 시 최소 2일 보유 유지
이벤트 드리븐 종목: 이벤트 소멸 시 즉시 매도

[수수료 원칙]
목표가: 실질 +5% = +5.20% 설정
손절가: 실질 -3% = -2.80% 설정
갈아타기: 왕복 0.20% 차감 후 판단`;

    const result = await callSonnet(prompt, 'recommendation');
    if (!result) {
      await sendTelegram(
        `🚨 [종목 추천 실패] ${dateHeader}\nAI 분석 실패\n조치: 수동으로 진입 여부 판단 필요\n👉 ${SERVER_URL}`,
        'system', 'recommend_fail', true
      );
      return;
    }

    // 9. 알림 발송
    const sw = result.switch_stock;
    const isBuy = ['buy_new', 'switch_stock', 'buy_more'].includes(result.action);

    let msg = `🎯 [종목 추천] ${dateHeader}\n`;
    msg += `📊 모닝전략: ${morningStrategy?.strategy?.slice(0, 60) || '없음'}\n\n`;
    msg += `─ 시나리오 ${scenario} ─\n`;

    if (isBuy && sw?.name) {
      const buyableQty = sw.entry_price ? Math.floor(availCash / sw.entry_price) : 0;
      const grossRate = sw.target_price && sw.entry_price
        ? Math.round(((sw.target_price - sw.entry_price) / sw.entry_price) * 1000) / 10
        : null;
      const netRate = grossRate ? Math.round((grossRate - 0.2) * 10) / 10 : null;
      const stopGross = sw.stop_loss && sw.entry_price
        ? Math.round(((sw.entry_price - sw.stop_loss) / sw.entry_price) * 1000) / 10
        : null;
      const stopNet = stopGross ? Math.round((stopGross + 0.2) * 10) / 10 : null;

      msg += `${sw.name} 진입 확정\n`;
      msg += `현재가: ${sw.entry_price?.toLocaleString()}원 (REST실시간)\n`;
      msg += `진입가: ${sw.entry_price?.toLocaleString()}원 / 수량: ${buyableQty}주\n`;
      if (sw.target_price) msg += `목표가: ${sw.target_price?.toLocaleString()}원 (+${grossRate}% / 실질 +${netRate}%)\n`;
      if (sw.stop_loss) msg += `손절가: ${sw.stop_loss?.toLocaleString()}원 (-${stopGross}% / 실질 -${stopNet}%)\n`;
      msg += `트레일링 스탑: 고점 -7%\n`;
      msg += `\n근거: ${(sw.reason || result.reason || '').slice(0, 150)}\n`;
      if (result.key_risk) msg += `리스크: ${result.key_risk.slice(0, 80)}\n`;
    } else {
      msg += `⏸ 현금 보유 유지\n`;
      msg += `이유: ${(result.why_cash || result.reason || '조건 미충족').slice(0, 100)}\n`;
    }

    msg += `───────────────\n👉 ${SERVER_URL}`;
    if (msg.length > 3900) msg = msg.slice(0, 3900) + `\n…더보기 👉 ${SERVER_URL}`;

    await sendTelegram(msg, sw?.name || 'recommendation', 'daily_recommend', isBuy);
    console.log('[Recommend] 종목 추천 완료');

  } catch (err) {
    console.error('[Recommend] 오류:', err.message);
    await sendTelegram(
      `🚨 [종목 추천 오류] ${dateHeader}\n${err.message}\n조치: 수동으로 진입 여부 판단 필요\n👉 ${SERVER_URL}`,
      'system', 'recommend_error', true
    ).catch(() => {});
  }
}

module.exports = { runStockRecommendation };
