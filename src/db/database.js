const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../../data/ai-trader.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db;

function runMigrations(db) {
  // analysis 테이블 새 컬럼 추가 (기존 DB 호환)
  const analysisColumns = db.pragma('table_info(analysis)').map(c => c.name);
  const newAnalysisCols = [
    { name: 'news_impact', type: 'TEXT' },
    { name: 'why_sell_now', type: 'TEXT' },
    { name: 'why_hold', type: 'TEXT' },
    { name: 'why_switch', type: 'TEXT' },
    { name: 'why_cash', type: 'TEXT' }
  ];
  for (const col of newAnalysisCols) {
    if (!analysisColumns.includes(col.name)) {
      db.exec(`ALTER TABLE analysis ADD COLUMN ${col.name} ${col.type}`);
      console.log(`[DB] analysis.${col.name} 컬럼 추가됨`);
    }
  }

  // news_cache url 컬럼 UNIQUE 인덱스 (IF NOT EXISTS로 안전하게)
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_news_cache_url_unique ON news_cache(url) WHERE url IS NOT NULL');
  } catch (e) { /* 이미 존재하면 무시 */ }
}

function getDb() {
  if (!db) {
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(schema);
    runMigrations(db);
  }
  return db;
}

function initDb() {
  return getDb(); // DB 연결 + 스키마 실행
}

module.exports = { getDb, initDb };
