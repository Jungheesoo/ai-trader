const { getDb } = require('../db/database');
const { getTodayKST } = require('./dateutil');

const SONNET_MIN_INTERVAL_MS = (parseInt(process.env.CLAUDE_SONNET_MIN_INTERVAL_SECONDS) || 60) * 1000;
const SONNET_MAX_PER_HOUR = parseInt(process.env.CLAUDE_SONNET_MAX_CALLS_PER_HOUR) || 3;
const SONNET_MAX_PER_DAY = parseInt(process.env.CLAUDE_SONNET_MAX_CALLS_PER_DAY) || 15;

let lastSonnetCallTime = 0;
let hourCallCount = 0;
let currentHour = -1;

// PM2 재시작 후 lastSonnetCallTime·hourCallCount 복원
try {
  const _db = require('../db/database').getDb();
  const _today = require('./dateutil').getTodayKST();
  const _row = _db.prepare(
    'SELECT last_called_at, call_count_today FROM api_calls WHERE model = ? AND date = ? ORDER BY id DESC LIMIT 1'
  ).get('sonnet', _today);
  if (_row && _row.last_called_at) {
    lastSonnetCallTime = new Date(_row.last_called_at).getTime();
  }
  if (_row && _row.call_count_today > 0) {
    const _kstHour = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
    currentHour = _kstHour;
    // clock hour 기준 오늘 같은 시간대 호출수 조회
    const _hourRow = _db.prepare(
      "SELECT COUNT(*) as cnt FROM api_calls WHERE model = 'sonnet' AND date = ? AND strftime('%H', datetime(last_called_at, '+9 hours')) = ?"
    ).get(_today, String(_kstHour).padStart(2, '0'));
    hourCallCount = _hourRow ? _hourRow.cnt : 0;
  }
} catch (_e) {
  // DB 미초기화 시 무시
}

function getToday() {
  return getTodayKST();
}

function getCurrentHour() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
}

function getTodayCallCount(model) {
  const db = getDb();
  const today = getToday();
  const row = db.prepare(
    'SELECT call_count_today FROM api_calls WHERE date = ? AND model = ?'
  ).get(today, model);
  return row ? row.call_count_today : 0;
}

function incrementCallCount(model) {
  const db = getDb();
  const today = getToday();
  const now = new Date().toISOString();
  const existing = db.prepare(
    'SELECT id, call_count_today FROM api_calls WHERE date = ? AND model = ?'
  ).get(today, model);

  if (existing) {
    db.prepare(
      'UPDATE api_calls SET call_count_today = call_count_today + 1, last_called_at = ? WHERE id = ?'
    ).run(now, existing.id);
  } else {
    db.prepare(
      'INSERT INTO api_calls (date, model, call_count_today, call_count_hour, last_called_at) VALUES (?, ?, 1, 1, ?)'
    ).run(today, model, now);
  }
}

function canCallSonnet() {
  const hour = getCurrentHour();
  // 시간당 제한은 clock hour 기준 (rolling window 미구현 — 14:59~15:00 경계 최대 6회 가능)
  if (hour !== currentHour) {
    currentHour = hour;
    hourCallCount = 0;
  }

  const now = Date.now();
  if (now - lastSonnetCallTime < SONNET_MIN_INTERVAL_MS) {
    const waitSec = Math.ceil((SONNET_MIN_INTERVAL_MS - (now - lastSonnetCallTime)) / 1000);
    return { allowed: false, reason: `마지막 호출 후 ${waitSec}초 대기 필요` };
  }

  if (hourCallCount >= SONNET_MAX_PER_HOUR) {
    return { allowed: false, reason: `시간당 최대 ${SONNET_MAX_PER_HOUR}회 초과` };
  }

  const todayCount = getTodayCallCount('sonnet');
  if (todayCount >= SONNET_MAX_PER_DAY) {
    return { allowed: false, reason: `오늘 최대 ${SONNET_MAX_PER_DAY}회 도달` };
  }

  return { allowed: true };
}

function recordSonnetCall() {
  lastSonnetCallTime = Date.now();
  hourCallCount++;
  incrementCallCount('sonnet');
}

function recordHaikuCall() {
  incrementCallCount('haiku');
}

function getSonnetTodayCount() {
  return getTodayCallCount('sonnet');
}

function getSonnetRemainingToday() {
  return Math.max(0, SONNET_MAX_PER_DAY - getTodayCallCount('sonnet'));
}

module.exports = {
  canCallSonnet,
  recordSonnetCall,
  recordHaikuCall,
  getSonnetTodayCount,
  getSonnetRemainingToday,
  SONNET_MAX_PER_DAY
};
