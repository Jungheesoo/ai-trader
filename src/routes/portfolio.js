const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { saveHoldings, savePortfolioInput, getPortfolioSummary } = require('../services/portfolio');
const { runAnalysisPipeline } = require('../services/analyzer');

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

function resolveAlias(name) {
  if (STOCK_ALIASES[name]) return STOCK_ALIASES[name];
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
    const today = new Date().toISOString().slice(0, 10);

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
    const today = new Date().toISOString().slice(0, 10);
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

module.exports = router;
