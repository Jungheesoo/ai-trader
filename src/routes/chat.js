const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { callSonnet } = require('../services/claude-sonnet');
const { getPortfolioSummary } = require('../services/portfolio');
const { canCallSonnet } = require('../services/guard');
const { getTodayKST } = require('../services/dateutil');

// POST /api/chat - AI 질문
router.post('/', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question || question.trim().length === 0) {
      return res.status(400).json({ ok: false, error: '질문을 입력해주세요.' });
    }

    const guardCheck = canCallSonnet();
    if (!guardCheck.allowed) {
      return res.status(429).json({ ok: false, error: guardCheck.reason });
    }

    const portfolio = await getPortfolioSummary();
    const today = getTodayKST();

    const prompt = {
      user_question: question.trim(),
      portfolio_summary: {
        total_assets: portfolio.totalAssets,
        stock_value: portfolio.stockValue,
        cash: portfolio.cash,
        overall_profit_rate: portfolio.overallProfitRate
      },
      holdings: portfolio.holdings.map(h => ({
        stock_name: h.stock_name,
        stock_code: h.stock_code,
        quantity: h.quantity,
        avg_price: h.avg_price,
        current_price: h.current_price,
        profit_rate: h.profitRate,
        rsi: h.rsi,
        macd: h.macd
      })),
      market_context: {
        day_of_week: ['일', '월', '화', '수', '목', '금', '토'][new Date().getDay()],
        report_type: 'user_question'
      }
    };

    const result = await callSonnet(prompt, 'user_chat');

    if (!result) {
      return res.status(503).json({ ok: false, error: 'AI 분석 실패. 잠시 후 다시 시도해주세요.' });
    }

    // 채팅 이력 저장
    const db = getDb();
    db.prepare(
      `INSERT INTO analysis (date, stock_name, action, confidence, reason, data_used, news_impact, why_sell_now, why_hold, why_switch, why_cash, alternative_stock, target_price, stop_loss, urgency, cash_recommendation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      today,
      portfolio.holdings.map(h => h.stock_name).join(',') || '없음',
      result.action, result.confidence,
      `[사용자 질문] ${question} | ${result.reason}`,
      JSON.stringify(result.data_used || []),
      result.news_impact || null,
      result.why_sell_now || null, result.why_hold || null,
      result.why_switch || null, result.why_cash || null,
      result.alternative_stock, result.target_price, result.stop_loss,
      result.urgency, result.cash_recommendation
    );

    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/chat/history - 오늘 채팅 이력
router.get('/history', (req, res) => {
  try {
    const db = getDb();
    const today = getTodayKST();

    const history = db.prepare(
      "SELECT * FROM analysis WHERE date = ? AND reason LIKE '[사용자 질문]%' ORDER BY created_at DESC LIMIT 20"
    ).all(today);

    res.json({ ok: true, data: history });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/chat/sonnet-status - Sonnet 호출 현황
router.get('/sonnet-status', (req, res) => {
  try {
    const { getSonnetRemainingToday, getSonnetTodayCount, SONNET_MAX_PER_DAY } = require('../services/guard');
    const used = getSonnetTodayCount();
    const remaining = getSonnetRemainingToday();
    const status = canCallSonnet();
    res.json({ ok: true, data: { used, max: SONNET_MAX_PER_DAY, remaining, allowed: status.allowed, reason: status.reason } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
