const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class AgentDB {
  constructor(dataDir = '/app/data') {
    // Ensure data dir exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.dbPath = path.join(dataDir, 'agent.db');
    console.log(`[DB] Opening database at ${this.dbPath}`);
    this.db = new Database(this.dbPath);

    this.init();
  }

  init() {
    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT,
        source TEXT,
        chat_id TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        description TEXT NOT NULL,
        status TEXT DEFAULT 'pending', -- pending, completed, failed
        metadata TEXT, -- JSON string for context (chatId, etc)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Migration: Add metadata column if it doesn't exist (for existing DBs)
    try {
      this.db.exec("ALTER TABLE goals ADD COLUMN metadata TEXT");
    } catch (err) {
      // Ignore error if column already exists
    }
    // Migration: Add parts column if it doesn't exist
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN parts TEXT");
    } catch (err) { }
  }

  // --- Messages ---
  saveMessage(msg) {
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, role, content, parts, source, chat_id, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // Fallback if msg.id is missing or generated elsewhere
    const id = msg.id || crypto.randomUUID();
    const partsStr = msg.parts ? JSON.stringify(msg.parts) : null;
    stmt.run(id, msg.role, msg.content, partsStr, msg.source, msg.metadata?.chatId, msg.timestamp);
  }

  getHistory(limit = 10) {
    const stmt = this.db.prepare(`
      SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?
    `);
    return stmt.all(limit).reverse();
  }

  // --- KV Store (Memory) ---
  setKey(key, value) {
    const valStr = JSON.stringify(value);
    const stmt = this.db.prepare(`
      INSERT INTO kv_store (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(key, valStr);
  }

  getKey(key) {
    const stmt = this.db.prepare('SELECT value FROM kv_store WHERE key = ?');
    const row = stmt.get(key);
    return row ? JSON.parse(row.value) : null;
  }

  // --- Goals ---
  addGoal(description, metadata = {}) {
    const metaStr = JSON.stringify(metadata);
    const stmt = this.db.prepare('INSERT INTO goals (description, metadata) VALUES (?, ?)');
    return stmt.run(description, metaStr);
  }

  getPendingGoals() {
    const stmt = this.db.prepare("SELECT * FROM goals WHERE status = 'pending'");
    const rows = stmt.all();
    return rows.map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : {}
    }));
  }

  completeGoal(id) {
    const stmt = this.db.prepare("UPDATE goals SET status = 'completed' WHERE id = ?");
    stmt.run(id);
  }

  // --- Rate Limiting ---
  logUsage() {
    this.db.prepare('INSERT INTO usage_logs DEFAULT VALUES').run();
  }

  checkLimit(windowHours) {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM usage_logs 
      WHERE timestamp > datetime('now', '-' || ? || ' hours')
    `);
    const result = stmt.get(windowHours);
    return result ? result.count : 0;
  }
  // --- Chat History Hydration ---
  // --- Chat History Hydration ---
  getHistoryForChat(chatId, limit = 20) {
    if (!chatId) return [];

    // Get last N messages for this chat
    const stmt = this.db.prepare(`
      SELECT role, content FROM messages 
      WHERE chat_id = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `);

    const rows = stmt.all(chatId, limit).reverse(); // Reverse to get chronological order

    // Map to Gemini SDK format
    return rows.map(row => {
      // Map 'assistant' role to 'model' for Gemini
      const role = row.role === 'assistant' ? 'model' : row.role;

      if (row.parts) {
        try {
          return { role, parts: JSON.parse(row.parts) };
        } catch (e) {
          console.error('[DB] Failed to parse message parts:', e);
        }
      }

      // Fallback to content
      return {
        role: role,
        parts: [{ text: row.content || '' }]
      };
    });
  }

  // --- Reset Commands ---
  clearHistory(chatId) {
    if (!chatId) return;
    const stmt = this.db.prepare('DELETE FROM messages WHERE chat_id = ?');
    stmt.run(chatId);
    console.log(`[DB] Cleared history for chat ${chatId}`);
  }

  clearGoals(chatId) {
    // Fail all pending goals associated with this chat or globally if no metadata check?
    // We filter by metadata like '%"chatId": "xyz"%' 
    // SQLite's JSON support is basic, usually via string match if JSON1 ext not loaded.
    // AgentDB init loaded nothing special, so string match is safest for now.

    if (chatId) {
      // Safe-ish string match for chatId in metadata
      const stmt = this.db.prepare(`
         UPDATE goals SET status = 'failed' 
         WHERE status = 'pending' AND metadata LIKE ?
       `);
      stmt.run(`%${chatId}%`);
      console.log(`[DB] Failed pending goals for chat ${chatId}`);
    } else {
      // If no chatId, fail ALL pending? Safer to require chatId.
      console.warn(`[DB] clearGoals called without chatId.`);
    }
  }
}

module.exports = { AgentDB };
