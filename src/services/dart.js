require('dotenv').config();
const axios = require('axios');
const { getDb } = require('../db/database');

const API_KEY = process.env.DART_API_KEY;

async function getDisclosures(corpCode, days = 1) {
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
  const row = db.prepare(
    'SELECT id FROM news_cache WHERE date = ? AND url = ?'
  ).get(today, rcpNo);
  return !row;
}

function markDisclosureSeen(rcpNo, title) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    'INSERT OR IGNORE INTO news_cache (date, source, title, url) VALUES (?, ?, ?, ?)'
  ).run(today, 'DART', title, rcpNo);
}

const URGENT_KEYWORDS = [
  '파업', '총파업', '횡령', '배임', '구속', '압수수색', '리콜', '생산중단',
  '상장폐지', '관리종목', '어닝쇼크', '적자전환', '경영권분쟁', '소송'
];

function classifyDisclosure(disclosure) {
  const title = disclosure.report_nm || '';
  const isUrgent = URGENT_KEYWORDS.some(kw => title.includes(kw));
  return {
    title,
    rcpNo: disclosure.rcp_no,
    date: disclosure.rcept_dt,
    isUrgent,
    url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${disclosure.rcp_no}`
  };
}

async function checkNewDisclosures(holdings) {
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
        newItems.push({ holding: holding.stock_name, ...classified });
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return newItems;
}

// checkDart: checkNewDisclosures의 단일 종목 wrapper (analyzer에서 사용)
async function checkDart(stockCode, stockName) {
  return checkNewDisclosures([{ stock_code: stockCode, stock_name: stockName }]);
}

module.exports = { checkNewDisclosures, checkDart, getDisclosures, getCorpCode };
