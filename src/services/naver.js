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

// getNaverNews: getStockNews의 alias (analyzer에서 사용)
const getNaverNews = getStockNews;

module.exports = { searchNews, crawlArticle, getStockNews, getNaverNews, getNaverFinancePrice };
