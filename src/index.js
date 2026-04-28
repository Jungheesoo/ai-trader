require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');

const { initDb } = require('./db/database');
const { isWeekday } = require('./services/holiday');

const portfolioRoute = require('./routes/portfolio');
const chatRoute = require('./routes/chat');
const historyRoute = require('./routes/history');
const { router: streamRoute } = require('./routes/stream');

const { runMorningLink } = require('./scheduler/morning');
const { runScan } = require('./scheduler/scan');
const { runMorningReport } = require('./scheduler/report');
const { runMonitor } = require('./scheduler/monitor');
const { runFridayCheck } = require('./scheduler/friday');
const { runMondayCheck } = require('./scheduler/monday');
const { runClosingReport } = require('./scheduler/closing');
const { runNightMonitor } = require('./scheduler/night');
const { runWeeklyReport } = require('./scheduler/weekly');
const { runMonthlyReport } = require('./scheduler/monthly');
const kisWs = require('./services/kis-websocket');
const { getTodayHoldings } = require('./services/portfolio');

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API 라우트
app.use('/api/portfolio', portfolioRoute);
app.use('/api/chat', chatRoute);
app.use('/api/history', historyRoute);
app.use('/api/stream', streamRoute);

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

// 평일 오전 8:10 - 자산입력 마감 (미입력 시 전일 데이터 자동 사용 - portfolio.js getTodayHoldings가 처리)
cron.schedule('10 8 * * 1-5', async () => {
  if (!isWeekday(new Date())) return;
  const { getTodayHoldings } = require('./services/portfolio');
  const holdings = getTodayHoldings();
  console.log(`[AutoLoad] 8:10 자산입력 마감 체크. 보유종목 ${holdings.length}건 (전일 자동포함)`);
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

// 금요일 오후 4:30 - 월간 리포트 (마지막 금요일만 실행)
cron.schedule('30 16 * * 5', async () => {
  await runMonthlyReport();
}, { timezone: 'Asia/Seoul' });

// 매일 새벽 3:00 - DB/로그 자동 정리 (디스크 보호)
cron.schedule('0 3 * * *', async () => {
  try {
    const { getDb } = require('./db/database');
    const db = getDb();
    const cutoff90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const cutoff30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const newsDeleted = db.prepare('DELETE FROM news_cache WHERE date < ?').run(cutoff30).changes;
    const alertsDeleted = db.prepare('DELETE FROM alerts WHERE date < ?').run(cutoff30).changes;
    const analysisDeleted = db.prepare('DELETE FROM analysis WHERE date < ?').run(cutoff90).changes;
    const holdingsDeleted = db.prepare('DELETE FROM holdings WHERE date < ?').run(cutoff90).changes;
    const watchlistDeleted = db.prepare('DELETE FROM watchlist WHERE date < ?').run(cutoff30).changes;
    db.prepare('VACUUM').run();

    const { execSync } = require('child_process');
    try { execSync('pm2 flush', { timeout: 10000 }); } catch (e) { /* silent */ }

    const { sendKakao } = require('./services/kakao');
    const { statSync } = require('fs');
    const dbPath = require('path').resolve(__dirname, '../data/trading.db');
    let dbSize = '-';
    try { dbSize = Math.round(statSync(dbPath).size / 1024 / 1024) + 'MB'; } catch (e) { /* silent */ }

    await sendKakao(
      `[자동정리] DB 정리 완료\n뉴스 ${newsDeleted}건 / 알림 ${alertsDeleted}건 / 분석 ${analysisDeleted}건 / 보유 ${holdingsDeleted}건 / 워치리스트 ${watchlistDeleted}건 삭제\nDB 크기: ${dbSize}`,
      '', 'cleanup'
    );
    console.log(`[Cleanup] DB 정리 완료. DB: ${dbSize}`);
  } catch (err) {
    console.error('[Cleanup] 정리 실패:', err.message);
  }
}, { timezone: 'Asia/Seoul' });

// WebSocket: 장 시작(9:00)에 연결
cron.schedule('0 9 * * 1-5', async () => {
  try {
    const holdings = getTodayHoldings();
    const codes = holdings.map(h => h.stock_code).filter(Boolean);
    await kisWs.connect(codes);
  } catch (e) { console.error('[WS] 연결 실패:', e.message); }
}, { timezone: 'Asia/Seoul' });

// WebSocket: 장 마감(15:35)에 연결 해제
cron.schedule('35 15 * * 1-5', () => {
  kisWs.disconnect();
}, { timezone: 'Asia/Seoul' });


// ─── 서버 시작 ───────────────────────────────────────────
async function start() {
  try {
    initDb();
    console.log('[DB] 초기화 완료');

    // 필수 환경변수 경고
    const requiredEnv = ['CLAUDE_API_KEY', 'KIS_APP_KEY', 'KIS_APP_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
    for (const key of requiredEnv) {
      if (!process.env[key]) console.warn(`[Config] ⚠️  ${key} 미설정`);
    }
    if (!process.env.DART_API_KEY) {
      console.warn('[Config] ⚠️  DART_API_KEY 미설정 — 공시(횡령/어닝쇼크/수주 등) 모니터링 비활성화');
    }
    if (!process.env.SERVER_IP || process.env.SERVER_IP.includes('여기에')) {
      console.warn('[Config] ⚠️  SERVER_IP 미설정 - 링크가 localhost로 표시됩니다.');
    }

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
