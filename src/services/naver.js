require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const axios = require('axios');
const cheerio = require('cheerio');

const CLIENT_ID = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

async function searchNews(query, display = 10) {
  try {
    const res = await axios.get('https://openapi.naver.com/v1/search/news.json', {
      params: { query, display, sort: 'date' },
      headers: {
        'X-Naver-Client-Id': CLIENT_ID,
        'X-Naver-Client-Secret': CLIENT_SECRET
      },
      timeout: 10000
    });
    return res.data.items || [];
  } catch (err) {
    console.error('[Naver] 뉴스 검색 실패:', err.message);
    return [];
  }
}

async function crawlArticle(url) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    const content = $('#dic_area').text().trim();
    return content || null;
  } catch {
    return null;
  }
}

async function getStockNews(stockName) {
  const items = await searchNews(stockName, 10);
  const results = [];

  for (const item of items) {
    await new Promise(r => setTimeout(r, 300));
    const url = item.originallink || item.link;
    const content = url ? await crawlArticle(url) : null;
    results.push({
      title: item.title.replace(/<[^>]*>/g, ''),
      url,
      summary: item.description.replace(/<[^>]*>/g, ''),
      content,
      publishedAt: item.pubDate,
      source: '네이버 뉴스'
    });
  }
  return results;
}

async function getNaverFinancePrice(stockCode) {
  try {
    const url = `https://finance.naver.com/item/main.naver?code=${stockCode}`;
    const res = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    const priceText = ($('.no_today .blind').first().text() || $('.today .blind').first().text()).replace(/,/g, '');
    const price = parseFloat(priceText);
    if (!price || isNaN(price)) throw new Error('가격 파싱 실패');
    return { price, source: 'naver_backup', delayed: true };
  } catch (err) {
    console.error('[Naver Finance] 백업 가격 수집 실패:', err.message);
    return null;
  }
}

// 시장 전체 키워드 (보유 종목 외 시장 흐름 파악용)
const MARKET_KEYWORDS = [
  '코스피', '코스닥', '외국인 순매수', '반도체 주가', '방산 주가', '원전 수주', '환율 달러', '나스닥'
];

async function getMarketNews() {
  const results = [];
  const seen = new Set();
  for (const kw of MARKET_KEYWORDS) {
    const items = await searchNews(kw, 3);
    for (const item of items) {
      const url = item.originallink || item.link;
      if (seen.has(url)) continue;
      seen.add(url);
      results.push({
        title: item.title.replace(/<[^>]*>/g, ''),
        url,
        summary: item.description.replace(/<[^>]*>/g, ''),
        content: null,
        publishedAt: item.pubDate,
        source: '네이버 시장'
      });
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

// getNaverNews: 보유 종목 뉴스 + 시장 전체 뉴스 합산
async function getNaverNews(stockNameOrKeyword) {
  const stockNews = await getStockNews(stockNameOrKeyword);
  return stockNews;
}

// getNaverNewsWithMarket: 보유 종목 + 시장 전체 통합 수집
async function getNaverNewsWithMarket(holdings) {
  const seen = new Set();
  const results = [];

  for (const h of holdings) {
    if (!h.stock_name) continue;
    const items = await getStockNews(h.stock_name);
    for (const item of items) {
      if (item.url && !seen.has(item.url)) {
        seen.add(item.url);
        results.push(item);
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }

  const marketNews = await getMarketNews();
  for (const item of marketNews) {
    if (item.url && !seen.has(item.url)) {
      seen.add(item.url);
      results.push(item);
    }
  }

  return results;
}

module.exports = { searchNews, crawlArticle, getStockNews, getNaverNews, getNaverFinancePrice, getMarketNews, getNaverNewsWithMarket };
