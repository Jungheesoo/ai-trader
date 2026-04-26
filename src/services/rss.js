const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');

const parser = new Parser({ timeout: 15000 });
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

const RSS_SOURCES = {
  domestic: [
    { name: '한국경제', url: 'https://www.hankyung.com/feed/finance' },
    { name: '매일경제', url: 'https://www.mk.co.kr/rss/30000001/' },
    { name: '연합뉴스경제', url: 'https://www.yna.co.kr/rss/economy.xml' },
    { name: '연합뉴스증권', url: 'https://www.yna.co.kr/rss/stock.xml' }
  ],
  global: [
    { name: '트럼프관세', url: 'https://news.google.com/rss/search?q=Trump+tariff&hl=en&gl=US&ceid=US:en' },
    { name: '트럼프한국', url: 'https://news.google.com/rss/search?q=Trump+Korea&hl=en&gl=US&ceid=US:en' },
    { name: 'Fed금리', url: 'https://news.google.com/rss/search?q=Fed+interest+rate&hl=en&gl=US&ceid=US:en' },
    { name: '나스닥', url: 'https://news.google.com/rss/search?q=NASDAQ&hl=en&gl=US&ceid=US:en' },
    { name: '반도체', url: 'https://news.google.com/rss/search?q=semiconductor+Korea&hl=en&gl=US&ceid=US:en' },
    { name: '원전두산', url: 'https://news.google.com/rss/search?q=Doosan+nuclear&hl=en&gl=US&ceid=US:en' },
    { name: '방산', url: 'https://news.google.com/rss/search?q=Korea+defense+industry&hl=en&gl=US&ceid=US:en' }
  ],
  investing: [
    { name: 'investing전체', url: 'https://www.investing.com/rss/news.rss' },
    { name: 'investing주식', url: 'https://www.investing.com/rss/stock_stock_picks.rss' }
  ]
};

async function fetchRSS(source) {
  try {
    const feed = await parser.parseURL(source.url);
    return (feed.items || []).slice(0, 5).map(item => ({
      title: item.title || '',
      url: item.link || '',
      summary: item.contentSnippet || item.summary || '',
      publishedAt: item.pubDate || item.isoDate || '',
      source: source.name
    }));
  } catch (err) {
    console.warn(`[RSS] ${source.name} 수집 실패:`, err.message);
    return [];
  }
}

async function crawlContent(url) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    // 연합뉴스
    let content = $('.article-txt').text().trim();
    if (!content) content = $('article').text().trim();
    if (!content) content = $('.news_contents').text().trim();
    if (!content) content = $('p').slice(0, 10).map((_, el) => $(el).text()).get().join(' ');
    return content.slice(0, 2000) || null;
  } catch {
    return null;
  }
}

async function collectAllNews() {
  const allSources = [...RSS_SOURCES.domestic, ...RSS_SOURCES.global];
  const results = [];

  for (const source of allSources) {
    const items = await fetchRSS(source);
    for (const item of items) {
      await new Promise(r => setTimeout(r, 500));
      const content = item.url ? await crawlContent(item.url) : null;
      results.push({ ...item, content });
    }
  }

  // investing.com 실패 시 무시 (차단 가능)
  for (const source of RSS_SOURCES.investing) {
    const items = await fetchRSS(source);
    results.push(...items.map(item => ({ ...item, content: null })));
  }

  return results;
}

async function collectNightNews() {
  const sources = [...RSS_SOURCES.global, ...RSS_SOURCES.investing];
  const results = [];
  for (const source of sources) {
    const items = await fetchRSS(source);
    results.push(...items.map(item => ({ ...item, content: null })));
  }
  return results;
}

// fetchAllRSS: collectAllNews의 alias (scheduler/analyzer에서 사용)
const fetchAllRSS = collectAllNews;

module.exports = { collectAllNews, collectNightNews, fetchRSS, fetchAllRSS };
