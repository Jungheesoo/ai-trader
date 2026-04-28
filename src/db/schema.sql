CREATE TABLE IF NOT EXISTS holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  stock_name TEXT NOT NULL,
  stock_code TEXT,
  quantity INTEGER NOT NULL,
  avg_price REAL NOT NULL,
  current_price REAL,
  profit_loss REAL,
  profit_loss_rate REAL,
  target_price REAL,
  stop_loss REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS analysis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  stock_name TEXT,
  action TEXT,
  confidence TEXT,
  reason TEXT,
  data_used TEXT,
  news_impact TEXT,
  why_sell_now TEXT,
  why_hold TEXT,
  why_switch TEXT,
  why_cash TEXT,
  alternative_stock TEXT,
  target_price REAL,
  stop_loss REAL,
  urgency TEXT,
  cash_recommendation TEXT,
  actual_result TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  stock_name TEXT,
  alert_type TEXT,
  message TEXT,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week TEXT NOT NULL,
  total_recommendations INTEGER DEFAULT 0,
  correct_recommendations INTEGER DEFAULT 0,
  accuracy_rate REAL DEFAULT 0,
  total_profit_loss REAL DEFAULT 0,
  sell_count INTEGER DEFAULT 0,
  cash_hold_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  stock_name TEXT NOT NULL,
  stock_code TEXT,
  rsi REAL,
  macd TEXT,
  volume_ratio REAL,
  foreign_net INTEGER,
  institution_net INTEGER,
  current_price REAL,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS api_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  model TEXT NOT NULL,
  call_count_today INTEGER DEFAULT 0,
  call_count_hour INTEGER DEFAULT 0,
  last_called_at DATETIME,
  estimated_cost REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS seed_growth (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  total_assets REAL,
  stock_value REAL,
  cash REAL,
  daily_profit_loss REAL,
  daily_profit_loss_rate REAL,
  realized_profit REAL DEFAULT 0,
  sell_count INTEGER DEFAULT 0,
  cash_hold_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS portfolio_input (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  cash REAL DEFAULT 0,
  new_investment REAL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS news_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  source TEXT,
  title TEXT,
  url TEXT UNIQUE,
  content TEXT,
  haiku_result TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  stock_name TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  trade_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price REAL NOT NULL,
  avg_price REAL,
  profit_loss REAL,
  profit_loss_rate REAL,
  memo TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(date);
CREATE INDEX IF NOT EXISTS idx_news_cache_date ON news_cache(date);
CREATE INDEX IF NOT EXISTS idx_news_cache_url ON news_cache(url);
CREATE INDEX IF NOT EXISTS idx_analysis_date ON analysis(date);
CREATE INDEX IF NOT EXISTS idx_holdings_date ON holdings(date);
