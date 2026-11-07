-- Estructura de la base de datos madelanenails-db (ya aplicada en Cloudflare).
CREATE TABLE IF NOT EXISTS appointments(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, email TEXT, service TEXT NOT NULL, notes TEXT, date TEXT NOT NULL, time TEXT NOT NULL, dur INTEGER NOT NULL DEFAULT 60, status TEXT NOT NULL DEFAULT 'pendiente', source TEXT NOT NULL DEFAULT 'web', ip TEXT, terms TEXT, reminded INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS appt_date ON appointments(date);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_slot ON appointments(date,time) WHERE status IN ('pendiente','confirmada');
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(ip TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS trampas(ip TEXT, ts INTEGER, motivo TEXT);
