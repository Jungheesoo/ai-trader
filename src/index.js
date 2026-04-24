require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');

const { initDb } = require('./db/database');
const { isWeekday } = require('./services/holiday');

const portfolioRoute = require('./routes/portfolio');
const chatRoute = require('./routes/chat');
const historyRoute = require('./routes/history');

const { runMorningLink } = require('./scheduler/morning');
const { runScan } = require('./scheduler/scan');
const { runMorningReport } = require('./scheduler/report');
const { runMonitor } = require('./scheduler/monitor');
const { runFridayCheck } = require('./scheduler/friday');
const { runMondayCheck } = require('./scheduler/monday');
const { runClosingReport } = require('./scheduler/closing');
const { runNightMonitor } = require('./scheduler/night');
const { runWeeklyReport } = require('./scheduler/weekly');

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API 라우트
app.use('/api/portfolio', portfolioRoute);
app.use('/api/chat', chatRoute);
app.use('/api/history', historyRoute);

// SPA fallback: html 파일 직접 서빙
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/portfolio', (req, res) => res.sendFile(path.join(__dirname, 'public', 'portfolio.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/history', (req, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));

// 헬스체크
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ─── 스케줄러 ───────────────────────────────────────────

// 평일 오전 8:00 - 웹 UI 링크 발송 + 전체 종목 스캔
cron.schedule('0 8 * * 1-5', async () => {
  await runMorningLink();
  await runScan();
}, { timezone: 'Asia/Seoul' });

// 평일 오전 8:30 - 모닝 리포트
cron.schedule('30 8 * * 1-5', async () => {
  await runMorningReport();
}, { timezone: 'Asia/Seoul' });

// 평일 장 중 30분마다 (9:00~15:30)
cron.schedule('0,30 9-15 * * 1-5', async () => {
  await runMonitor();
}, { timezone: 'Asia/Seoul' });

// 월요일 오전 9:30 - 주말 효과 판단
cron.schedule('30 9 * * 1', async () => {
  await runMondayCheck();
}, { timezone: 'Asia/Seoul' });

// 금요일 오후 1:30 - 주말 특별 점검
cron.schedule('30 13 * * 5', async () => {
  await runFridayCheck();
}, { timezone: 'Asia/Seoul' });

// 평일 오후 4:00 - 마감 리포트
cron.schedule('0 16 * * 1-5', async () => {
  await runClosingReport();
}, { timezone: 'Asia/Seoul' });

// 야간 23:00 - 미국 시장 모니터링
cron.schedule('0 23 * * *', async () => {
  await runNightMonitor();
}, { timezone: 'Asia/Seoul' });

// 새벽 2:00 - 미국 시장 모니터링
cron.schedule('0 2 * * *', async () => {
  await runNightMonitor();
}, { timezone: 'Asia/Seoul' });

// 일요일 오전 10:00 - 주간 성과 리포트
cron.schedule('0 10 * * 0', async () => {
  await runWeeklyReport();
}, { timezone: 'Asia/Seoul' });

// ─── 서버 시작 ───────────────────────────────────────────
async function start() {
  try {
    initDb();
    console.log('[DB] 초기화 완료');

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Server] AI 트레이더 시작 - http://0.0.0.0:${PORT}`);
      console.log('[Server] 스케줄러 활성화');
    });
  } catch (err) {
    console.error('[Server] 시작 실패:', err.message);
    process.exit(1);
  }
}

start();
