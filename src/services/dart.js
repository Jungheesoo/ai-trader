require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const axios = require('axios');
const { getDb } = require('../db/database');

const API_KEY = process.env.DART_API_KEY;

// ── 공시 분류 키워드 ─────────────────────────────────────────
// 긴급(즉시 대응): 악재성 공시
const URGENT_BAD = [
  '파업', '총파업', '횡령', '배임', '구속', '압수수색',
  '리콜', '생산중단', '상장폐지', '관리종목', '어닝쇼크',
  '적자전환', '경영권분쟁', '소송', '과징금', '영업정지'
];

// 호재성 공시: 수주·계약·실적 개선
const POSITIVE = [
  '수주', '계약체결', '공급계약', '수출계약', '납품계약',
  '수주잔고', '대규모계약', '업무협약', 'MOU',
  '영업이익증가', '실적개선', '흑자전환', '매출증가',
  '자사주취득', '배당', '무상증자'
];

// 주요 공시: 실적발표 (긍/부 판단 필요 → Sonnet에 전달)
const IMPORTANT = [
  '사업보고서', '분기보고서', '반기보고서',
  '영업실적', '잠정실적', '연간실적',
  '유상증자', '전환사채', '신주인수권', '합병', '분할',
  '최대주주변경', '임원변경', '대표이사변경'
];

function classifyDisclosure(disclosure) {
  const title = disclosure.report_nm || '';

  let type = 'info';        // info | urgent_bad | positive | important
  let icon = '📋';
  let impact = '중립';      // 긍정 | 부정 | 중립

  if (URGENT_BAD.some(kw => title.includes(kw))) {
    type = 'urgent_bad';
    icon = '🚨';
    impact = '부정';
  } else if (POSITIVE.some(kw => title.includes(kw))) {
    type = 'positive';
    icon = '✅';
    impact = '긍정';
  } else if (IMPORTANT.some(kw => title.includes(kw))) {
    type = 'important';
    icon = '📊';
    impact = '중립';
  }

  return {
    title,
    type,
    icon,
    impact,
    rcpNo: disclosure.rcp_no,
    date: disclosure.rcept_dt,
    isUrgent: type === 'urgent_bad',
    isPositive: type === 'positive',
    isImportant: type === 'important' || type === 'urgent_bad' || type === 'positive',
    url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${disclosure.rcp_no}`
  };
}

async function getDisclosures(corpCode, days = 1) {
  if (!API_KEY) return [];
  try {
    const endDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const start = new Date();
    start.setDate(start.getDate() - days);
    const startDate = start.toISOString().slice(0, 10).replace(/-/g, '');

    const res = await axios.get('https://opendart.fss.or.kr/api/list.json', {
      params: {
        crtfc_key: API_KEY,
        corp_code: corpCode,
        bgn_de: startDate,
        end_de: endDate,
        sort: 'date',
        sort_mth: 'desc',
        page_no: 1,
        page_count: 10
      },
      timeout: 10000
    });

    if (res.data.status !== '000') return [];
    return res.data.list || [];
  } catch (err) {
    console.error('[DART] 공시 조회 실패:', err.message);
    return [];
  }
}

async function getCorpCode(stockName) {
  if (!API_KEY) return null;
  try {
    const res = await axios.get('https://opendart.fss.or.kr/api/company.json', {
      params: { crtfc_key: API_KEY, corp_name: stockName },
      timeout: 10000
    });
    if (res.data.status !== '000' || !res.data.list?.length) return null;
    return res.data.list[0].corp_code;
  } catch (err) {
    console.error('[DART] 기업 검색 실패:', err.message);
    return null;
  }
}

function isNewDisclosure(rcpNo) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  return !db.prepare('SELECT id FROM news_cache WHERE date = ? AND url = ?').get(today, rcpNo);
}

function markDisclosureSeen(rcpNo, title) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    'INSERT OR IGNORE INTO news_cache (date, source, title, url) VALUES (?, ?, ?, ?)'
  ).run(today, 'DART', title, rcpNo);
}

// DART 미설정 시 시작 시 1회 경고
let dartKeyMissingWarned = false;
function warnIfNoKey() {
  if (!API_KEY && !dartKeyMissingWarned) {
    dartKeyMissingWarned = true;
    console.warn('[DART] ⚠️  DART_API_KEY 미설정 — 공시 모니터링 비활성화');
  }
}

async function checkNewDisclosures(holdings) {
  warnIfNoKey();
  if (!API_KEY) return [];

  const newItems = [];
  for (const holding of holdings) {
    if (!holding.stock_name) continue;
    const corpCode = await getCorpCode(holding.stock_name);
    if (!corpCode) continue;

    const disclosures = await getDisclosures(corpCode, 1);
    for (const d of disclosures) {
      if (isNewDisclosure(d.rcp_no)) {
        const classified = classifyDisclosure(d);
        markDisclosureSeen(d.rcp_no, d.report_nm);
        newItems.push({ stockName: holding.stock_name, ...classified });
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return newItems;
}

// checkDart: 단일 종목 wrapper
async function checkDart(stockCode, stockName) {
  return checkNewDisclosures([{ stock_code: stockCode, stock_name: stockName }]);
}

module.exports = { checkNewDisclosures, checkDart, getDisclosures, getCorpCode, classifyDisclosure };
