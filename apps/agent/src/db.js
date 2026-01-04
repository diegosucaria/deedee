const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class AgentDB {
  constructor(dataDir) {
    // Determine data directory
    if (!dataDir) {
      if (process.env.DATA_DIR) {
        dataDir = process.env.DATA_DIR;
      } else if (fs.existsSync('/app') && process.platform !== 'darwin') {
        // Likely Docker or Linux environment
        dataDir = '/app/data';
      } else {
        // Local fallback (MacOS or outside container)
        dataDir = path.join(process.cwd(), 'data');
      }
    }

    // Ensure data dir exists
    if (!fs.existsSync(dataDir)) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
      } catch (e) {
        console.error(`[DB] Failed to create data dir ${dataDir}, falling back to tmp.`);
        dataDir = path.join(require('os').tmpdir(), 'deedee_data');
        fs.mkdirSync(dataDir, { recursive: true });
      }
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

      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        name TEXT PRIMARY KEY,
        cron_expression TEXT NOT NULL,
        task_type TEXT NOT NULL, -- e.g. 'function_call', 'script'
        payload TEXT, -- JSON args
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS entity_aliases (
        alias TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

  // --- Scheduled Jobs ---
  saveScheduledJob(job) {
    const payloadStr = JSON.stringify(job.payload || {});
    const stmt = this.db.prepare(`
      INSERT INTO scheduled_jobs (name, cron_expression, task_type, payload) 
      VALUES (?, ?, ?, ?) 
      ON CONFLICT(name) DO UPDATE SET 
        cron_expression=excluded.cron_expression, 
        task_type=excluded.task_type, 
        payload=excluded.payload
    `);
    stmt.run(job.name, job.cronExpression, job.taskType || 'function_call', payloadStr);
  }

  getScheduledJobs() {
    const stmt = this.db.prepare('SELECT * FROM scheduled_jobs');
    return stmt.all().map(row => ({
      name: row.name,
      cronExpression: row.cron_expression,
      taskType: row.task_type,
      payload: row.payload ? JSON.parse(row.payload) : {},
      createdAt: row.created_at
    }));
  }

  deleteScheduledJob(name) {
    this.db.prepare('DELETE FROM scheduled_jobs WHERE name = ?').run(name);
  }

  // --- Extended CRUD ---
  deleteFact(key) {
    this.db.prepare('DELETE FROM kv_store WHERE key = ?').run(key);
  }

  deleteGoal(id) {
    this.db.prepare('DELETE FROM goals WHERE id = ?').run(id);
  }

  updateGoal(id, { status, description }) {
    const updates = [];
    const args = [];
    if (status) { updates.push('status = ?'); args.push(status); }
    if (description) { updates.push('description = ?'); args.push(description); }

    if (updates.length === 0) return;

    args.push(id);
    const sql = `UPDATE goals SET ${updates.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...args);
  }

  listAliases() {
    return this.db.prepare('SELECT * FROM entity_aliases ORDER BY alias ASC').all();
  }

  deleteAlias(alias) {
    this.db.prepare('DELETE FROM entity_aliases WHERE alias = ?').run(alias);
  }

  deleteMessage(id) {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
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

  // --- Search & Consolidation ---
  searchMessages(query, limit = 10) {
    // Simple LIKE search
    const stmt = this.db.prepare(`
        SELECT timestamp, role, content FROM messages 
        WHERE content LIKE ? OR parts LIKE ?
        ORDER BY timestamp DESC
        LIMIT ?
    `);
    const likeQuery = `%${query}%`;
    return stmt.all(likeQuery, likeQuery, limit);
  }

  getMessagesByDate(dateStr) {
    // dateStr format YYYY-MM-DD
    const stmt = this.db.prepare(`
        SELECT role, content, timestamp FROM messages
        WHERE date(timestamp) = ?
        ORDER BY timestamp ASC
      `);
    return stmt.all(dateStr);
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
      // Map 'function' role to 'user' for Gemini (function results are considered user input in the chat loop)
      let role = row.role;
      if (role === 'assistant') role = 'model';
      if (role === 'function') role = 'user';

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

  clearAllHistory() {
    const stmt = this.db.prepare('DELETE FROM messages');
    const info = stmt.run();
    console.log(`[DB] Cleared ALL history (${info.changes} messages)`);
  }

  deleteMessagesSince(chatId, timestamp) {
    if (!chatId || !timestamp) return;
    const stmt = this.db.prepare('DELETE FROM messages WHERE chat_id = ? AND timestamp >= ?');
    const info = stmt.run(chatId, timestamp);
    console.log(`[DB] Rolled back ${info.changes} messages in chat ${chatId} since ${timestamp}`);
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

  // --- Smart Home Entity Memory ---
  saveDeviceAlias(alias, entityId) {
    const stmt = this.db.prepare(`
      INSERT INTO entity_aliases (alias, entity_id) VALUES (?, ?)
      ON CONFLICT(alias) DO UPDATE SET entity_id = excluded.entity_id
    `);
    stmt.run(alias.toLowerCase(), entityId);
  }

  getDeviceAlias(alias) {
    const stmt = this.db.prepare('SELECT entity_id FROM entity_aliases WHERE alias = ?');
    const row = stmt.get(alias.toLowerCase());
    return row ? row.entity_id : null;
  }
  getStats() {
    const totalMessages = this.db.prepare('SELECT COUNT(*) as count FROM messages').get().count;

    // Last 24h
    const messages24h = this.db.prepare("SELECT COUNT(*) as count FROM messages WHERE timestamp > datetime('now', '-24 hours')").get().count;

    // By Role
    const roles = this.db.prepare('SELECT role, COUNT(*) as count FROM messages GROUP BY role').all();
    const roleCounts = roles.reduce((acc, r) => ({ ...acc, [r.role]: r.count }), {});

    // Goals
    const pendingGoals = this.db.prepare("SELECT COUNT(*) as count FROM goals WHERE status = 'pending'").get().count;
    const completedGoals = this.db.prepare("SELECT COUNT(*) as count FROM goals WHERE status = 'completed'").get().count;

    // Jobs
    const activeJobs = this.db.prepare('SELECT COUNT(*) as count FROM scheduled_jobs').get().count;

    return {
      messages: {
        total: totalMessages,
        last24h: messages24h,
        byRole: roleCounts
      },
      goals: {
        pending: pendingGoals,
        completed: completedGoals
      },
      jobs: {
        active: activeJobs
      }
    };
  }
}

module.exports = { AgentDB };
