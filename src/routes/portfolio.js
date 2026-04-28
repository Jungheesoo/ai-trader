const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { saveHoldings, savePortfolioInput, getPortfolioSummary } = require('../services/portfolio');
const { runAnalysisPipeline } = require('../services/analyzer');
const { getTodayKST } = require('../services/dateutil');

// 종목 약어 사전
const STOCK_ALIASES = {
  '삼전': { name: '삼성전자', code: '005930' },
  '하이닉스': { name: 'SK하이닉스', code: '000660' },
  '카카오': { name: '카카오', code: '035720' },
  '네이버': { name: 'NAVER', code: '035420' },
  '현대차': { name: '현대자동차', code: '005380' },
  '기아': { name: '기아', code: '000270' },
  '두산에너': { name: '두산에너빌리티', code: '034020' },
  '삼바': { name: '삼성바이오로직스', code: '207940' },
  '한화에어': { name: '한화에어로스페이스', code: '012450' },
  '셀트리온': { name: '셀트리온', code: '068270' },
  'LG에너지': { name: 'LG에너지솔루션', code: '373220' },
  '포스코': { name: 'POSCO홀딩스', code: '005490' }
};

// 정식명 → code 역방향 맵
const NAME_TO_CODE = {};
for (const [, v] of Object.entries(STOCK_ALIASES)) {
  NAME_TO_CODE[v.name] = v.code;
}

function resolveAlias(name) {
  if (STOCK_ALIASES[name]) return STOCK_ALIASES[name];
  if (NAME_TO_CODE[name]) return { name, code: NAME_TO_CODE[name] };
  return { name, code: null };
}

// GET /api/portfolio - 오늘 포트폴리오 조회
router.get('/', async (req, res) => {
  try {
    const portfolio = await getPortfolioSummary();
    res.json({ ok: true, data: portfolio });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/portfolio - 자산현황 저장 및 분석 시작
router.post('/', async (req, res) => {
  try {
    const { holdings, cash, newInvestment } = req.body;
    const today = getTodayKST();

    if (!Array.isArray(holdings) || holdings.length === 0) {
      return res.status(400).json({ ok: false, error: '보유 종목을 입력해주세요.' });
    }

    // 종목 약어 변환 및 검증
    const resolved = holdings.map(h => {
      const alias = resolveAlias(h.stock_name);
      return {
        stock_name: alias.name,
        stock_code: h.stock_code || alias.code,
        quantity: parseInt(h.quantity) || 0,
        avg_price: parseFloat(h.avg_price) || 0
      };
    }).filter(h => h.quantity > 0 && h.avg_price > 0);

    if (resolved.length === 0) {
      return res.status(400).json({ ok: false, error: '유효한 종목 정보를 입력해주세요.' });
    }

    saveHoldings(today, resolved);
    savePortfolioInput(today, parseFloat(cash) || 0, parseFloat(newInvestment) || 0);

    res.json({ ok: true, message: '저장 완료. 분석 파이프라인 시작합니다.' });

    // 비동기로 분석 파이프라인 실행 (응답 후 실행)
    setImmediate(async () => {
      try {
        const portfolio = await getPortfolioSummary();
        await runAnalysisPipeline(portfolio);
      } catch (err) {
        console.error('[Portfolio Route] 분석 파이프라인 오류:', err.message);
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/portfolio/holdings - 보유 종목 목록만 반환
router.get('/holdings', (req, res) => {
  try {
    const db = getDb();
    const today = getTodayKST();
    let holdings = db.prepare('SELECT * FROM holdings WHERE date = ? ORDER BY id').all(today);
    if (!holdings.length) {
      const lastDate = db.prepare('SELECT MAX(date) as d FROM holdings').get();
      if (lastDate?.d) {
        holdings = db.prepare('SELECT * FROM holdings WHERE date = ?').all(lastDate.d);
      }
    }
    res.json({ ok: true, data: holdings });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/portfolio/aliases - 종목 약어 사전 반환
router.get('/aliases', (req, res) => {
  res.json({ ok: true, data: STOCK_ALIASES });
});

// GET /api/portfolio/trades - 매매 이력 조회
router.get('/trades', (req, res) => {
  try {
    const db = getDb();
    const { date, days = 30 } = req.query;
    let rows;
    if (date) {
      rows = db.prepare('SELECT * FROM trades WHERE date = ? ORDER BY created_at DESC').all(date);
    } else {
      const since = new Date();
      since.setDate(since.getDate() - parseInt(days));
      const sinceStr = since.toISOString().slice(0, 10);
      rows = db.prepare('SELECT * FROM trades WHERE date >= ? ORDER BY created_at DESC').all(sinceStr);
    }
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/portfolio/trades - 매도 완료 / 신규 매수 입력
router.post('/trades', (req, res) => {
  try {
    const db = getDb();
    const today = getTodayKST();
    const { trade_type, stock_name, stock_code, quantity, price, avg_price, memo } = req.body;

    if (!trade_type || !stock_name || !quantity || !price) {
      return res.status(400).json({ ok: false, error: 'trade_type, stock_name, quantity, price 필수' });
    }

    const qty = parseInt(quantity);
    const priceN = parseFloat(price);
    const avgPriceN = parseFloat(avg_price) || null;

    // 실현 손익 계산 (매도 계열만)
    let profitLoss = null;
    let profitLossRate = null;
    if (['sell_profit', 'sell_loss', 'switch'].includes(trade_type) && avgPriceN) {
      profitLoss = Math.round((priceN - avgPriceN) * qty);
      profitLossRate = Math.round(((priceN - avgPriceN) / avgPriceN) * 10000) / 100;
    }

    const alias = resolveAlias(stock_name);
    const resolvedCode = stock_code || alias.code || '';
    const resolvedName = alias.name || stock_name;

    // trades 저장
    db.prepare(
      'INSERT INTO trades (date, stock_name, stock_code, trade_type, quantity, price, avg_price, profit_loss, profit_loss_rate, memo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(today, resolvedName, resolvedCode, trade_type, qty, priceN, avgPriceN, profitLoss, profitLossRate, memo || null);

    // holdings 처리
    if (['sell_profit', 'sell_loss', 'switch'].includes(trade_type)) {
      // 매도: 오늘 + 전일 holdings 제거 (코드 또는 이름 기준)
      if (resolvedCode) {
        db.prepare('DELETE FROM holdings WHERE stock_code = ? AND date = ?').run(resolvedCode, today);
        const lastDate = db.prepare('SELECT MAX(date) as d FROM holdings WHERE stock_code = ?').get(resolvedCode);
        if (lastDate?.d && lastDate.d !== today) db.prepare('DELETE FROM holdings WHERE stock_code = ? AND date = ?').run(resolvedCode, lastDate.d);
      } else {
        db.prepare('DELETE FROM holdings WHERE stock_name = ? AND date = ?').run(resolvedName, today);
        const lastDate = db.prepare('SELECT MAX(date) as d FROM holdings WHERE stock_name = ?').get(resolvedName);
        if (lastDate?.d && lastDate.d !== today) db.prepare('DELETE FROM holdings WHERE stock_name = ? AND date = ?').run(resolvedName, lastDate.d);
      }

      // 매도 대금 현금에 자동 합산
      const saleAmount = Math.round(priceN * qty);
      const existing = db.prepare('SELECT * FROM portfolio_input WHERE date = ?').get(today);
      if (existing) {
        db.prepare('UPDATE portfolio_input SET cash = cash + ?, updated_at = ? WHERE date = ?')
          .run(saleAmount, new Date().toISOString(), today);
      } else {
        // 오늘 입력 없으면 전일 데이터 복사 후 현금 합산
        const prev = db.prepare('SELECT * FROM portfolio_input ORDER BY date DESC LIMIT 1').get();
        const baseCash = prev?.cash || 0;
        const baseNew = prev?.new_investment || 0;
        db.prepare('INSERT INTO portfolio_input (date, cash, new_investment, updated_at) VALUES (?, ?, ?, ?)')
          .run(today, baseCash + saleAmount, baseNew, new Date().toISOString());
      }
    } else if (trade_type === 'buy') {
      // 신규 매수: holdings 추가
      const existing = db.prepare('SELECT * FROM holdings WHERE stock_code = ? AND date = ?').get(resolvedCode, today);
      if (existing) {
        const newQty = existing.quantity + qty;
        const newAvg = Math.round((existing.avg_price * existing.quantity + priceN * qty) / newQty);
        db.prepare('UPDATE holdings SET quantity = ?, avg_price = ? WHERE stock_code = ? AND date = ?')
          .run(newQty, newAvg, resolvedCode, today);
      } else {
        db.prepare('INSERT INTO holdings (date, stock_name, stock_code, quantity, avg_price) VALUES (?, ?, ?, ?, ?)')
          .run(today, resolvedName, resolvedCode, qty, priceN);
      }

      // 매수 대금 현금에서 차감
      const buyAmount = Math.round(priceN * qty);
      const existingInput = db.prepare('SELECT * FROM portfolio_input WHERE date = ?').get(today);
      if (existingInput) {
        db.prepare('UPDATE portfolio_input SET cash = MAX(0, cash - ?), updated_at = ? WHERE date = ?')
          .run(buyAmount, new Date().toISOString(), today);
      }
    }

    res.json({
      ok: true,
      message: '매매 기록 저장 완료',
      data: { profitLoss, profitLossRate }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
