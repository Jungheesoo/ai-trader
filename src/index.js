require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');

const { initDb } = require('./db/database');
const { isWeekday } = require('./services/holiday');

const portfolioRoute = require('./routes/portfolio');
const chatRoute = require('./routes/chat');
const historyRoute = require('./routes/history');

const { checkRefreshTokenExpiry } = require('./services/kakao');
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

// SPA fallback: html 파일 직접 서빙
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/portfolio', (req, res) => res.sendFile(path.join(__dirname, 'public', 'portfolio.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/history', (req, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));

// 헬스체크
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ─── 카카오 OAuth (최초 1회 토큰 발급용) ──────────────────────
// 1단계: 브라우저에서 /auth/kakao/login 접속 → 카카오 로그인 페이지로 이동
app.get('/auth/kakao/login', (req, res) => {
  const clientId = process.env.KAKAO_CLIENT_ID;
  const redirectUri = encodeURIComponent(process.env.KAKAO_REDIRECT_URI);
  const kakaoAuthUrl = `https://kauth.kakao.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code`;
  res.redirect(kakaoAuthUrl);
});

// 2단계: 카카오가 code를 들고 이 URL로 돌아옴 → Access/Refresh Token 교환 후 화면에 출력
app.get('/auth/kakao/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.send(`<h2>카카오 인증 실패</h2><p>${error || '코드 없음'}</p>`);
  }
  try {
    const axios = require('axios');
    const tokenRes = await axios.post('https://kauth.kakao.com/oauth/token', null, {
      params: {
        grant_type: 'authorization_code',
        client_id: process.env.KAKAO_CLIENT_ID,
        client_secret: process.env.KAKAO_CLIENT_SECRET,
        redirect_uri: process.env.KAKAO_REDIRECT_URI,
        code
      },
      timeout: 10000
    });
    const { access_token, refresh_token } = tokenRes.data;
    res.send(`
      <html><head><meta charset="UTF-8"><title>카카오 토큰 발급 완료</title>
      <style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 16px}
      .box{background:#f0f1f5;border-radius:8px;padding:16px;margin:12px 0;word-break:break-all;font-size:13px}
      h2{color:#16a34a}p{color:#374151;font-size:14px}</style></head><body>
      <h2>✅ 카카오 토큰 발급 완료</h2>
      <p>아래 두 값을 복사해서 <strong>.env</strong> 파일에 붙여넣으세요.</p>
      <p><strong>KAKAO_ACCESS_TOKEN=</strong></p>
      <div class="box">${access_token}</div>
      <p><strong>KAKAO_REFRESH_TOKEN=</strong></p>
      <div class="box">${refresh_token}</div>
      <p style="color:#6b7280;font-size:12px">
        ⚠️ 이 페이지를 닫으면 토큰이 사라집니다. 반드시 저장하세요.<br>
        Refresh Token은 60일마다 재발급이 필요합니다.
      </p>
      </body></html>
    `);
  } catch (err) {
    res.send(`<h2>토큰 교환 실패</h2><pre>${err.response?.data ? JSON.stringify(err.response.data, null, 2) : err.message}</pre>`);
  }
});

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

// 매일 오전 7:00 - 카카오 Refresh Token 만료 7일 전 알림
cron.schedule('0 7 * * *', async () => {
  await checkRefreshTokenExpiry();
}, { timezone: 'Asia/Seoul' });

// ─── 서버 시작 ───────────────────────────────────────────
async function start() {
  try {
    initDb();
    console.log('[DB] 초기화 완료');

    // 필수 환경변수 경고
    const requiredEnv = ['CLAUDE_API_KEY', 'KIS_APP_KEY', 'KIS_APP_SECRET', 'KAKAO_ACCESS_TOKEN', 'KAKAO_REFRESH_TOKEN'];
    for (const key of requiredEnv) {
      if (!process.env[key]) console.warn(`[Config] ⚠️  ${key} 미설정`);
    }
    if (!process.env.SERVER_IP || process.env.SERVER_IP.includes('여기에')) {
      console.warn('[Config] ⚠️  SERVER_IP 미설정 - 카카오 링크가 localhost로 표시됩니다. .env의 SERVER_IP를 서버 공인 IP로 변경하세요.');
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
