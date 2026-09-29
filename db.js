// Слой хранения — sqlite-файл на примонтированном Railway volume (переживает передеплои).
// Путь берём из DB_PATH (на railway это будет что-то вроде /data/quiz.db), с фолбэком
// на локальный файл для разработки.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'quiz.db');
require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    roles TEXT NOT NULL,
    shuffle_seed INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
    self_report TEXT NOT NULL,
    risk_answers TEXT NOT NULL,
    cases TEXT NOT NULL,
    points TEXT NOT NULL,
    case_scores TEXT,
    graded INTEGER NOT NULL DEFAULT 0,
    criteria_avg TEXT NOT NULL,
    overall_avg REAL,
    overall_level INTEGER,
    confidence_gap REAL,
    submitted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

module.exports = db;
