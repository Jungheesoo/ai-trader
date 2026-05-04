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

    // 4. REST API로 현재가 실시간 조회 + SOX/환율 병렬 조회
    const { fetchSoxData, fetchExchangeRate } = require('../services/analyzer');
    const portfolio = await getPortfolioSummary();
    const allCodes = [
      ...portfolio.holdings.map(h => h.stock_code).filter(Boolean),
      ...watchlist.map(w => w.stock_code).filter(Boolean)
    ];
    const [restPrices, sox, exRate] = await Promise.all([
      allCodes.length > 0 ? getCurrentPrices(allCodes) : Promise.resolve({}),
      fetchSoxData(),
      fetchExchangeRate()
    ]);
    const nasdaqLine = sox
      ? `SOX: ${sox.price?.toLocaleString()} (${sox.changePercent !== null ? (sox.changePercent >= 0 ? '+' : '') + sox.changePercent + '%' : '전일比미확인'})`
      : 'SOX: 데이터 없음';
    const exRateLine = exRate ? `달러/원: ${exRate.rate?.toLocaleString()}원` : '환율: 데이터 없음';

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

    // 7-1. holdings RSI/MACD 보완 (watchlist에서)
    portfolio.holdings.forEach(h => {
      if (!h.stock_code) {
        const match = watchlist.find(w => w.stock_name === h.stock_name);
        if (match?.stock_code) h.stock_code = match.stock_code;
      }
      if (!h.rsi || !h.macd) {
        const match = watchlist.find(w =>
          w.stock_name === h.stock_name || w.stock_code === h.stock_code
        );
        if (match) {
          h.rsi = h.rsi ?? match.rsi;
          h.macd = h.macd ?? match.macd;
          h.current_price = h.current_price ?? match.current_price;
        }
      }
    });

    // 7-2. 전체 자산 계산 (갈아타기 시 활용 가능)
    const holdingValue = portfolio.holdings.reduce((sum, h) => sum + (h.stock_value || 0), 0);
    const totalAsset = availCash + holdingValue;

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
시장 현황: ${nasdaqLine} / ${exRateLine}
모닝 전략: ${morningStrategy?.strategy || '없음'}
시나리오: ${scenario === 'A' ? 'A — 현금만 있음' : scenario === 'B' ? 'B — 보유종목 + 현금' : 'C — 갈아타기 검토'}
투자 가능 현금: ${availCash.toLocaleString()}원
보유종목 평가액: ${holdingValue.toLocaleString()}원
갈아타기 시 총 활용 가능: ${totalAsset.toLocaleString()}원 (매도대금 + 현금 합산)

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
    msg += `📊 모닝전략: ${morningStrategy?.strategy || '없음'}\n\n`;
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
      msg += `\n근거: ${sw.reason || result.reason || ''}\n`;
      if (result.key_risk) msg += `리스크: ${result.key_risk}\n`;
    } else {
      msg += `⏸ 현금 보유 유지\n`;
      msg += `이유: ${result.why_cash || result.reason || '조건 미충족'}\n`;
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

async function runMidDayRecommendation() {
  if (isHoliday(new Date())) return;
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  const days = ['일','월','화','수','목','금','토'];
  const dateHeader = `${String(kst.getUTCMonth()+1).padStart(2,'0')}/${String(kst.getUTCDate()).padStart(2,'0')} (${days[kst.getUTCDay()]}) ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;

  console.log('[MidDay] 장중 재추천 체크 시작');

  const db = getDb();
  const today = getTodayKST();
  const SERVER_URL = `http://${process.env.SERVER_IP || 'localhost'}:${process.env.PORT || 3000}`;

  try {
    // 1. Sonnet 잔여 횟수 확인
    const { getRemainingCalls } = require('../services/guard');
    const remaining = getRemainingCalls('sonnet');
    if (remaining <= 0) {
      console.log('[MidDay] Sonnet 잔여 횟수 0 → 재추천 스킵');
      return;
    }

    // 2. portfolio 로드
    const portfolio = await getPortfolioSummary();
    const availCash = (portfolio.cash || 0) + (portfolio.newInvestment || 0);
    const hasHoldings = portfolio.holdings && portfolio.holdings.length > 0;

    // 3. watchlist 로드
    const watchlist = db.prepare(
      'SELECT * FROM watchlist WHERE date = ? ORDER BY score DESC LIMIT 10'
    ).all(today);

    if (watchlist.length === 0) {
      console.log('[MidDay] watchlist 없음 → 재추천 스킵');
      return;
    }

    // 4. 조건 체크
    let shouldRecommend = false;
    let reason = '';

    // 조건1: 현금 보유 중
    if (availCash > 0) {
      shouldRecommend = true;
      reason = '현금 보유 중';
    }

    // 조건2: 보유종목 있고 watchlist 상위 종목이 현재 보유종목보다 score 3점 이상 높을 때
    if (hasHoldings && watchlist.length > 0) {
      const topWatchlistScore = watchlist[0].score || 0;
      const holdingCodes = new Set(portfolio.holdings.map(h => h.stock_code).filter(Boolean));
      const holdingScores = watchlist.filter(w => holdingCodes.has(w.stock_code)).map(w => w.score || 0);
      const maxHoldingScore = holdingScores.length > 0 ? Math.max(...holdingScores) : 0;

      if (topWatchlistScore - maxHoldingScore >= 3) {
        shouldRecommend = true;
        reason = `상위 종목 score 차이 ${topWatchlistScore - maxHoldingScore}점`;
      }
    }

    if (!shouldRecommend) {
      console.log('[MidDay] 재추천 조건 미충족 — 스킵');
      return;
    }

    console.log(`[MidDay] 재추천 조건 충족 (${reason}) → Sonnet 호출`);

    // 5. 기존 runStockRecommendation()과 동일한 로직으로 Sonnet 호출
    const { fetchSoxData, fetchExchangeRate } = require('../services/analyzer');
    const wsOk = isConnected();

    const allCodes = [
      ...portfolio.holdings.map(h => h.stock_code).filter(Boolean),
      ...watchlist.map(w => w.stock_code).filter(Boolean)
    ];
    const [restPrices, sox, exRate] = await Promise.all([
      allCodes.length > 0 ? getCurrentPrices(allCodes) : Promise.resolve({}),
      fetchSoxData(),
      fetchExchangeRate()
    ]);
    const nasdaqLine = sox
      ? `SOX: ${sox.price?.toLocaleString()} (${sox.changePercent !== null ? (sox.changePercent >= 0 ? '+' : '') + sox.changePercent + '%' : '전일比미확인'})`
      : 'SOX: 데이터 없음';
    const exRateLine = exRate ? `달러/원: ${exRate.rate?.toLocaleString()}원` : '환율: 데이터 없음';

    watchlist.forEach(w => {
      if (restPrices[w.stock_code]) {
        w.current_price = restPrices[w.stock_code];
        w.priceLabel = '(REST실시간)';
      } else {
        w.priceLabel = '(스캔기준⚠️)';
      }
    });

    const morningStrategy = db.prepare(
      'SELECT * FROM morning_strategy WHERE date = ?'
    ).get(today);

    let scenario = '';
    if (!hasHoldings && availCash > 0) scenario = 'A';
    else if (hasHoldings && availCash > 0) scenario = 'B';
    else if (hasHoldings) scenario = 'C';
    else {
      console.log('[MidDay] 현금 없음 + 보유 종목 없음 → 스킵');
      return;
    }

    // holdings RSI/MACD 보완
    portfolio.holdings.forEach(h => {
      if (!h.stock_code) {
        const match = watchlist.find(w => w.stock_name === h.stock_name);
        if (match?.stock_code) h.stock_code = match.stock_code;
      }
      if (!h.rsi || !h.macd) {
        const match = watchlist.find(w =>
          w.stock_name === h.stock_name || w.stock_code === h.stock_code
        );
        if (match) {
          h.rsi = h.rsi ?? match.rsi;
          h.macd = h.macd ?? match.macd;
          h.current_price = h.current_price ?? match.current_price;
        }
      }
    });

    const holdingValue = portfolio.holdings.reduce((sum, h) => sum + (h.stock_value || 0), 0);
    const totalAsset = availCash + holdingValue;

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

    const prompt = `${wsWarning}[장중 재추천 요청 ${dateHeader}]
시장 현황: ${nasdaqLine} / ${exRateLine}
모닝 전략: ${morningStrategy?.strategy || '없음'}
시나리오: ${scenario === 'A' ? 'A — 현금만 있음' : scenario === 'B' ? 'B — 보유종목 + 현금' : 'C — 갈아타기 검토'}
투자 가능 현금: ${availCash.toLocaleString()}원
보유종목 평가액: ${holdingValue.toLocaleString()}원
갈아타기 시 총 활용 가능: ${totalAsset.toLocaleString()}원 (매도대금 + 현금 합산)

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

    const result = await callSonnet(prompt, 'midday_recommendation');
    if (!result) {
      console.log('[MidDay] Sonnet 호출 실패 → 스킵');
      return;
    }

    // 알림 발송
    const sw = result.switch_stock;
    const isBuy = ['buy_new', 'switch_stock', 'buy_more'].includes(result.action);

    let msg = `🔄 [장중 재추천] ${dateHeader}\n`;
    msg += `📊 모닝전략: ${morningStrategy?.strategy || '없음'}\n\n`;
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
      msg += `\n근거: ${sw.reason || result.reason || ''}\n`;
      if (result.key_risk) msg += `리스크: ${result.key_risk}\n`;
    } else {
      msg += `⏸ 현금 보유 유지\n`;
      msg += `이유: ${result.why_cash || result.reason || '조건 미충족'}\n`;
    }

    msg += `───────────────\n👉 ${SERVER_URL}`;
    if (msg.length > 3900) msg = msg.slice(0, 3900) + `\n…더보기 👉 ${SERVER_URL}`;

    await sendTelegram(msg, sw?.name || 'midday_recommend', 'midday_recommend', false);
    console.log('[MidDay] 장중 재추천 완료');

  } catch (err) {
    console.error('[MidDay] 오류:', err.message);
  }
}

module.exports = { runStockRecommendation, runMidDayRecommendation };
