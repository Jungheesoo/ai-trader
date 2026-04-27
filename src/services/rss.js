const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');

const parser = new Parser({ timeout: 15000 });
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

const RSS_SOURCES = [
  {
    name: '한국경제',
    urls: [
      'https://www.hankyung.com/feed/finance',
      'http://rss.hankyung.com/economy.xml',
      'http://rss.hankyung.com/stock.xml'
    ]
  },
  {
    name: '매일경제',
    urls: [
      'https://www.mk.co.kr/rss/30000001/',
      'http://file.mk.co.kr/news/rss/rss_30000001.xml',
      'http://file.mk.co.kr/news/rss/rss_50200011.xml'
    ]
  },
  {
    name: '파이낸셜뉴스',
    urls: [
      'http://www.fnnews.com/rss/fn_realnews_stock.xml',
      'http://www.fnnews.com/rss/fn_realnews_economy.xml',
      'https://news.google.com/rss/search?q=%ED%8C%8C%EC%9D%B4%EB%82%B4%EC%85%9C%EB%89%B4%EC%8A%A4+%EC%A6%9D%EA%B6%8C&hl=ko&gl=KR&ceid=KR:ko'
    ]
  },
  {
    name: '헤럴드경제',
    urls: [
      'http://biz.heraldm.com/rss/010106000000.xml',
      'https://news.google.com/rss/search?q=%ED%97%A4%EB%9F%B4%EB%93%9C%EA%B2%BD%EC%A0%9C+%EC%A6%9D%EA%B6%8C&hl=ko&gl=KR&ceid=KR:ko'
    ]
  },
  {
    name: '연합뉴스경제',
    urls: [
      'https://www.yna.co.kr/rss/economy.xml',
      'https://news.google.com/rss/search?q=%EC%97%B0%ED%95%A9%EB%89%B4%EC%8A%A4+%EA%B2%BD%EC%A0%9C&hl=ko&gl=KR&ceid=KR:ko'
    ]
  },
  {
    name: '연합뉴스증권',
    urls: [
      'https://www.yna.co.kr/rss/market.xml',
      'https://www.yna.co.kr/rss/stock.xml',
      'https://news.google.com/rss/search?q=%EC%97%B0%ED%95%A9%EB%89%B4%EC%8A%A4+%EC%A6%9D%EA%B6%8C&hl=ko&gl=KR&ceid=KR:ko'
    ]
  },
  {
    name: '코스피증시',
    urls: [
      'https://news.google.com/rss/search?q=%EC%BD%94%EC%8A%A4%ED%94%BC+%EC%A6%9D%EC%8B%9C&hl=ko&gl=KR&ceid=KR:ko'
    ]
  },
  {
    name: '두산에너빌리티',
    urls: [
      'https://news.google.com/rss/search?q=%EB%91%90%EC%82%B0%EC%97%90%EB%84%88%EB%B9%8C%EB%A6%AC%ED%8B%B0&hl=ko&gl=KR&ceid=KR:ko'
    ]
  },
  {
    name: '원전수주',
    urls: [
      'https://news.google.com/rss/search?q=%EC%9B%90%EC%A0%84+%ED%95%9C%EA%B5%AD&hl=ko&gl=KR&ceid=KR:ko'
    ]
  },
  {
    name: '방산수출',
    urls: [
      'https://news.google.com/rss/search?q=%EB%B0%A9%EC%82%B0+%ED%95%9C%EA%B5%AD&hl=ko&gl=KR&ceid=KR:ko'
    ]
  },
  {
    name: '반도체한국',
    urls: [
      'https://news.google.com/rss/search?q=%EB%B0%98%EB%8F%84%EC%B2%B4+%ED%95%9C%EA%B5%AD&hl=ko&gl=KR&ceid=KR:ko'
    ]
  },
  {
    name: 'Trump tariff',
    urls: [
      'https://news.google.com/rss/search?q=Trump+tariff+Korea&hl=en&gl=US&ceid=US:en'
    ]
  },
  {
    name: 'NASDAQ',
    urls: [
      'https://news.google.com/rss/search?q=NASDAQ+market&hl=en&gl=US&ceid=US:en'
    ]
  },
  {
    name: 'Fed rate',
    urls: [
      'https://news.google.com/rss/search?q=Fed+interest+rate&hl=en&gl=US&ceid=US:en'
    ]
  },
  {
    name: 'Korea semiconductor',
    urls: [
      'https://news.google.com/rss/search?q=semiconductor+Korea&hl=en&gl=US&ceid=US:en'
    ]
  }
];

async function fetchRSSUrl(url, sourceName) {
  const feed = await parser.parseURL(url);
  return (feed.items || []).slice(0, 5).map(item => ({
    title: item.title || '',
    url: item.link || '',
    summary: item.contentSnippet || item.summary || '',
    publishedAt: item.pubDate || item.isoDate || '',
    source: sourceName
  }));
}

async function fetchRSSWithFallback(source) {
  for (const url of source.urls) {
    try {
      const items = await fetchRSSUrl(url, source.name);
      if (items && items.length > 0) {
        console.log(`[RSS] ${source.name} 수집 성공: ${items.length}건`);
        return items;
      }
    } catch (err) {
      console.log(`[RSS] ${source.name} 실패 → 다음 시도: ${err.message}`);
    }
  }
  console.log(`[RSS] ${source.name} 모든 URL 실패`);
  return [];
}

async function crawlContent(url) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
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
  const results = [];

  for (const source of RSS_SOURCES) {
    const items = await fetchRSSWithFallback(source);
    for (const item of items) {
      await new Promise(r => setTimeout(r, 300));
      const content = item.url ? await crawlContent(item.url) : null;
      results.push({ ...item, content });
    }
  }

  return results;
}

async function collectNightNews() {
  const globalSources = RSS_SOURCES.filter(s =>
    ['Trump tariff', 'NASDAQ', 'Fed rate', 'Korea semiconductor'].includes(s.name)
  );
  const results = [];
  for (const source of globalSources) {
    const items = await fetchRSSWithFallback(source);
    results.push(...items.map(item => ({ ...item, content: null })));
  }
  return results;
}

// fetchAllRSS: collectAllNews의 alias
const fetchAllRSS = collectAllNews;

// fetchRSS: 단일 소스 호환 (기존 코드와의 호환성)
async function fetchRSS(source) {
  if (typeof source === 'string') {
    try {
      const items = await fetchRSSUrl(source, '');
      return items;
    } catch {
      return [];
    }
  }
  return fetchRSSWithFallback(source);
}

module.exports = { collectAllNews, collectNightNews, fetchRSS, fetchAllRSS };
