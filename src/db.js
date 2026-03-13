const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use Railway volume if available, otherwise fall back to local data dir
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'nicbot.db'));

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    type TEXT NOT NULL CHECK(type IN ('used', 'skipped', 'ping_used', 'ping_skipped')),
    mg INTEGER,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS pings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    responded INTEGER NOT NULL DEFAULT 0,
    response_type TEXT
  );

  CREATE TABLE IF NOT EXISTS milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    achieved_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const stmts = {
  logUse: db.prepare('INSERT INTO logs (type, mg, note) VALUES (?, ?, ?)'),
  logUseAt: db.prepare('INSERT INTO logs (timestamp, type, mg, note) VALUES (?, ?, ?, ?)'),
  undoLast: db.prepare('DELETE FROM logs WHERE id = (SELECT MAX(id) FROM logs)'),
  getLastLog: db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 1'),

  todayCount: db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(mg), 0) as totalMg
    FROM logs
    WHERE type IN ('used', 'ping_used')
    AND date(timestamp) = date('now')
  `),

  todayLogs: db.prepare(`
    SELECT * FROM logs
    WHERE date(timestamp) = date('now')
    ORDER BY timestamp ASC
  `),

  dayCount: db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(mg), 0) as totalMg
    FROM logs
    WHERE type IN ('used', 'ping_used')
    AND date(timestamp) = date(?)
  `),

  weekLogs: db.prepare(`
    SELECT date(timestamp) as day,
           COUNT(*) as count,
           COALESCE(SUM(mg), 0) as totalMg,
           SUM(CASE WHEN type IN ('skipped', 'ping_skipped') THEN 1 ELSE 0 END) as skipped
    FROM logs
    WHERE timestamp >= datetime('now', '-7 days')
    GROUP BY date(timestamp)
    ORDER BY day ASC
  `),

  rangeLogs: db.prepare(`
    SELECT date(timestamp) as day,
           COUNT(CASE WHEN type IN ('used', 'ping_used') THEN 1 END) as count,
           COALESCE(SUM(CASE WHEN type IN ('used', 'ping_used') THEN mg ELSE 0 END), 0) as totalMg,
           COUNT(CASE WHEN type IN ('skipped', 'ping_skipped') THEN 1 END) as skipped
    FROM logs
    WHERE timestamp >= datetime('now', ? || ' days')
    GROUP BY date(timestamp)
    ORDER BY day ASC
  `),

  logPing: db.prepare('INSERT INTO pings (sent_at) VALUES (datetime(\'now\'))'),
  lastPing: db.prepare('SELECT * FROM pings ORDER BY id DESC LIMIT 1'),
  respondPing: db.prepare('UPDATE pings SET responded = 1, response_type = ? WHERE id = ?'),

  lastUsedTimestamp: db.prepare(`
    SELECT timestamp FROM logs
    WHERE type IN ('used', 'ping_used')
    ORDER BY timestamp DESC LIMIT 1
  `),

  last24hUses: db.prepare(`
    SELECT timestamp, mg FROM logs
    WHERE type IN ('used', 'ping_used')
    AND timestamp >= datetime('now', '-24 hours')
    ORDER BY timestamp ASC
  `),

  // Streak: consecutive days at or under a given daily target (param: target count)
  // Returns all days with usage counts, ordered descending, so we can count streak in JS
  dailyUseCounts: db.prepare(`
    SELECT date(timestamp) as day,
           COUNT(*) as count
    FROM logs
    WHERE type IN ('used', 'ping_used')
    GROUP BY date(timestamp)
    ORDER BY day DESC
  `),

  // Time gaps between consecutive uses today
  todayUseTimestamps: db.prepare(`
    SELECT timestamp FROM logs
    WHERE type IN ('used', 'ping_used')
    AND date(timestamp) = date('now')
    ORDER BY timestamp ASC
  `),

  // Average gap between uses per day over last 7 days
  weekUseTimestamps: db.prepare(`
    SELECT timestamp FROM logs
    WHERE type IN ('used', 'ping_used')
    AND timestamp >= datetime('now', '-7 days')
    ORDER BY timestamp ASC
  `),

  // Time-of-day breakdown (uses per period: morning/afternoon/evening/night)
  timeOfDayBreakdown: db.prepare(`
    SELECT
      SUM(CASE WHEN CAST(strftime('%H', timestamp) AS INTEGER) BETWEEN 6 AND 11 THEN 1 ELSE 0 END) as morning,
      SUM(CASE WHEN CAST(strftime('%H', timestamp) AS INTEGER) BETWEEN 12 AND 17 THEN 1 ELSE 0 END) as afternoon,
      SUM(CASE WHEN CAST(strftime('%H', timestamp) AS INTEGER) BETWEEN 18 AND 23 THEN 1 ELSE 0 END) as evening,
      SUM(CASE WHEN CAST(strftime('%H', timestamp) AS INTEGER) BETWEEN 0 AND 5 THEN 1 ELSE 0 END) as night
    FROM logs
    WHERE type IN ('used', 'ping_used')
    AND timestamp >= datetime('now', '-7 days')
  `),

  // This week vs last week comparison
  thisWeekTotal: db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(mg), 0) as totalMg,
           COUNT(CASE WHEN type IN ('skipped', 'ping_skipped') THEN 1 END) as skipped
    FROM logs
    WHERE timestamp >= datetime('now', '-7 days')
    AND type IN ('used', 'ping_used')
  `),

  lastWeekTotal: db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(mg), 0) as totalMg,
           COUNT(CASE WHEN type IN ('skipped', 'ping_skipped') THEN 1 END) as skipped
    FROM logs
    WHERE timestamp >= datetime('now', '-14 days')
    AND timestamp < datetime('now', '-7 days')
    AND type IN ('used', 'ping_used')
  `),

  // Skips in last 7 days
  weekSkipCount: db.prepare(`
    SELECT COUNT(*) as count FROM logs
    WHERE type IN ('skipped', 'ping_skipped')
    AND timestamp >= datetime('now', '-7 days')
  `),

  // Milestones
  getMilestone: db.prepare('SELECT * FROM milestones WHERE key = ?'),
  setMilestone: db.prepare('INSERT OR IGNORE INTO milestones (key) VALUES (?)'),
};

module.exports = { db, stmts };
