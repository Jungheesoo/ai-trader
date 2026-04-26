const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { getTodayKST } = require('../services/dateutil');

// GET /api/history - 분석 이력 (날짜별)
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { date, limit = 30 } = req.query;

    let history;
    if (date) {
      history = db.prepare(
        "SELECT * FROM analysis WHERE date = ? ORDER BY created_at DESC"
      ).all(date);
    } else {
      history = db.prepare(
        "SELECT * FROM analysis ORDER BY created_at DESC LIMIT ?"
      ).all(parseInt(limit));
    }

    res.json({ ok: true, data: history });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/history/:id/result - 실제 결과 입력 (적중률 계산용)
router.patch('/:id/result', (req, res) => {
  try {
    const db = getDb();
    const { result } = req.body; // 'correct' | 'incorrect'

    if (!['correct', 'incorrect'].includes(result)) {
      return res.status(400).json({ ok: false, error: 'result는 correct 또는 incorrect' });
    }

    db.prepare('UPDATE analysis SET actual_result = ? WHERE id = ?').run(result, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/history/performance - 성과 통계
router.get('/performance', (req, res) => {
  try {
    const db = getDb();
    const { period = 30 } = req.query;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(period));
    const startStr = startDate.toISOString().slice(0, 10);

    // 시드 성장 이력
    const seedGrowth = db.prepare(
      'SELECT * FROM seed_growth WHERE date >= ? ORDER BY date'
    ).all(startStr);

    // 분석 적중률
    const analyses = db.prepare(
      'SELECT * FROM analysis WHERE date >= ? AND actual_result IS NOT NULL'
    ).all(startStr);

    const totalRecs = analyses.length;
    const correctRecs = analyses.filter(a => a.actual_result === 'correct').length;
    const accuracy = totalRecs > 0 ? Math.round((correctRecs / totalRecs) * 100) : null;

    // 매도 횟수 및 실현 수익
    const sellStats = db.prepare(
      "SELECT COUNT(*) as sell_count, SUM(realized_profit) as total_realized FROM seed_growth WHERE date >= ?"
    ).get(startStr);

    // 주간 성과 이력
    const weeklyPerf = db.prepare(
      'SELECT * FROM performance ORDER BY created_at DESC LIMIT 12'
    ).all();

    res.json({
      ok: true,
      data: {
        seed_growth: seedGrowth,
        accuracy_rate: accuracy,
        total_recommendations: totalRecs,
        correct_recommendations: correctRecs,
        sell_count: sellStats?.sell_count || 0,
        total_realized_profit: sellStats?.total_realized || 0,
        weekly_performance: weeklyPerf
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/history/alerts - 알림 이력
router.get('/alerts', (req, res) => {
  try {
    const db = getDb();
    const { date } = req.query;
    const today = date || getTodayKST();

    const alerts = db.prepare(
      'SELECT * FROM alerts WHERE date = ? ORDER BY sent_at DESC'
    ).all(today);

    res.json({ ok: true, data: alerts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
