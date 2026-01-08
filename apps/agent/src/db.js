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
        cost REAL,
        token_count INTEGER,
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
        expires_at DATETIME,
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

      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL, -- latency_router, latency_model, etc
        value REAL NOT NULL,
        metadata TEXT, -- JSON
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS agent_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL, -- JSON string
        category TEXT DEFAULT 'general',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model TEXT NOT NULL,
        prompt_tokens INTEGER,
        candidate_tokens INTEGER,
        total_tokens INTEGER,
        chat_id TEXT,
        estimated_cost REAL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        content TEXT NOT NULL,
        range_start TEXT, -- Message ID or Index
        range_end TEXT,
        original_tokens INTEGER,
        summary_tokens INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS job_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_name TEXT NOT NULL,
        status TEXT NOT NULL, -- success, failure
        output TEXT,
        duration_ms INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        is_archived INTEGER DEFAULT 0,
        is_pinned INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS verified_contacts (
        service TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (service, contact_id)
      );

      CREATE TABLE IF NOT EXISTS people (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT,
        relationship TEXT,
        source TEXT DEFAULT 'manual',
        notes TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Migration: Backfill sessions for existing messages
    this.migrateSessions();

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

    // Migration: Add estimated_cost to token_usage
    try {
      this.db.exec("ALTER TABLE token_usage ADD COLUMN estimated_cost REAL");
    } catch (err) { }

    // Migration: Add token counts to summaries
    try {
      this.db.exec("ALTER TABLE summaries ADD COLUMN summary_tokens INTEGER");
    } catch (err) { }

    // Migration: Add cost/token_count to messages
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN cost REAL");
      this.db.exec("ALTER TABLE messages ADD COLUMN token_count INTEGER");
    } catch (err) { }

    // Migration: Add expires_at to scheduled_jobs
    try {
      this.db.exec("ALTER TABLE scheduled_jobs ADD COLUMN expires_at DATETIME");
    } catch (err) { }

    // Migration: Add is_pinned to chat_sessions
    try {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN is_pinned INTEGER DEFAULT 0");
    } catch (err) { }

    // Migration: Add identifiers to people
    try {
      this.db.exec("ALTER TABLE people ADD COLUMN identifiers TEXT");
    } catch (err) { }
  }

  // --- Scheduled Jobs ---
  saveScheduledJob(job) {
    const payloadStr = JSON.stringify(job.payload || {});
    const stmt = this.db.prepare(`
      INSERT INTO scheduled_jobs (name, cron_expression, task_type, payload, expires_at) 
      VALUES (?, ?, ?, ?, ?) 
      ON CONFLICT(name) DO UPDATE SET 
        cron_expression=excluded.cron_expression, 
        task_type=excluded.task_type, 
        payload=excluded.payload,
        expires_at=excluded.expires_at
    `);
    stmt.run(job.name, job.cronExpression, job.taskType || 'function_call', payloadStr, job.expiresAt || null);
  }

  getScheduledJobs() {
    const stmt = this.db.prepare('SELECT * FROM scheduled_jobs');
    return stmt.all().map(row => ({
      name: row.name,
      cronExpression: row.cron_expression,
      taskType: row.task_type,
      payload: row.payload ? JSON.parse(row.payload) : {},
      expiresAt: row.expires_at,
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

  // --- People / Contacts ---

  createPerson(person) {
    const id = person.id || crypto.randomUUID();
    const metaStr = person.metadata ? JSON.stringify(person.metadata) : '{}';
    const identifiersStr = person.identifiers ? JSON.stringify(person.identifiers) : '{}';
    const stmt = this.db.prepare(`
      INSERT INTO people (id, name, phone, relationship, source, notes, metadata, identifiers)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, person.name, person.phone, person.relationship, person.source || 'manual', person.notes, metaStr, identifiersStr);
    return id;
  }

  getPerson(id) {
    // Try by ID first, then phone
    let stmt = this.db.prepare('SELECT * FROM people WHERE id = ?');
    let row = stmt.get(id);

    if (!row) {
      stmt = this.db.prepare('SELECT * FROM people WHERE phone = ?');
      row = stmt.get(id);
    }

    if (row) {
      if (row.metadata) row.metadata = JSON.parse(row.metadata);
      if (row.identifiers) row.identifiers = JSON.parse(row.identifiers);
      // Backwards compat: If identifiers empty/null but phone exists, populate identifiers.whatsapp
      if (!row.identifiers || Object.keys(row.identifiers).length === 0) {
        row.identifiers = {};
        if (row.phone) row.identifiers.whatsapp = row.phone;
      }
    }
    return row;
  }

  updatePerson(id, updates) {
    const fields = [];
    const args = [];

    if (updates.name !== undefined) { fields.push('name = ?'); args.push(updates.name); }
    if (updates.phone !== undefined) { fields.push('phone = ?'); args.push(updates.phone); }
    if (updates.relationship !== undefined) { fields.push('relationship = ?'); args.push(updates.relationship); }
    if (updates.notes !== undefined) { fields.push('notes = ?'); args.push(updates.notes); }
    if (updates.metadata !== undefined) { fields.push('metadata = ?'); args.push(JSON.stringify(updates.metadata)); }
    if (updates.identifiers !== undefined) { fields.push('identifiers = ?'); args.push(JSON.stringify(updates.identifiers)); }

    if (fields.length === 0) return;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    args.push(id);

    const sql = `UPDATE people SET ${fields.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...args);
  }

  deletePerson(id) {
    this.db.prepare('DELETE FROM people WHERE id = ?').run(id);
  }

  listPeople() {
    return this.db.prepare('SELECT * FROM people ORDER BY name ASC').all().map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      identifiers: row.identifiers ? JSON.parse(row.identifiers) : {}
    }));
  }

  searchPeople(query) {
    if (!query) return [];
    const wildcard = `%${query}%`;
    const stmt = this.db.prepare(`
      SELECT * FROM people 
      WHERE name LIKE ? 
      OR relationship LIKE ? 
      OR notes LIKE ? 
      OR phone LIKE ?
    `);
    return stmt.all(wildcard, wildcard, wildcard, wildcard).map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      identifiers: row.identifiers ? JSON.parse(row.identifiers) : {}
    }));
  }



  // --- Chat Sessions ---
  migrateSessions() {
    // Find chat_ids in messages that don't have a session
    const rows = this.db.prepare(`
      SELECT DISTINCT chat_id FROM messages 
      WHERE chat_id NOT IN (SELECT id FROM chat_sessions) 
      AND chat_id IS NOT NULL
    `).all();

    if (rows.length > 0) {
      console.log(`[DB] Migrating ${rows.length} legacy chats to sessions...`);
      const stmt = this.db.prepare(`
        INSERT INTO chat_sessions (id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `);

      const now = new Date().toISOString();
      for (const row of rows) {
        let title = 'Legacy Chat';
        // Try to verify if it is an external source
        if (row.chat_id.match(/^\d+$/) || row.chat_id.includes('@')) {
          title = 'External Chat'; // Heuristic: numbers are usually Telegram/WhatsApp
        }
        stmt.run(row.chat_id, title, now, now);
      }
    }
  }

  createSession({ id, title }) {
    this.deleteEmptySessions(); // Cleanup abandoned sessions
    const sessionId = id || crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO chat_sessions (id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, title || 'New Chat', now, now);
    return { id: sessionId, title, createdAt: now };
  }

  ensureSession(chatId, source = 'web') {
    if (!chatId) return null;
    let session = this.getSession(chatId);
    if (!session) {
      let title = 'New Chat';
      if (source === 'telegram' || source === 'whatsapp') {
        title = `${source.charAt(0).toUpperCase() + source.slice(1)} Chat`;
      }
      session = this.createSession({ id: chatId, title });
      console.log(`[DB] Auto-created session ${chatId} (${title})`);
    }
    return session;
  }

  getSession(id) {
    return this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id);
  }

  getSessions({ limit = 50, offset = 0 } = {}) {
    return this.db.prepare(`
      SELECT * FROM chat_sessions 
      WHERE is_archived = 0
      AND id NOT LIKE 'scheduled_%'
      AND id NOT LIKE 'api_city_image_%'
      AND id LIKE '%-%' -- Keep only UUIDs (Web sessions), filters out numeric Telegram IDs
      AND id NOT LIKE '%@%' -- Filter out WhatsApp IDs just in case
      AND id NOT LIKE '%@%' -- Filter out WhatsApp IDs just in case
      ORDER BY is_pinned DESC, updated_at DESC 
      LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  getLatestEmptySession() {
    // Find latest session with title 'New Chat'
    const stmt = this.db.prepare(`
       SELECT * FROM chat_sessions 
       WHERE title = 'New Chat' 
       AND is_archived = 0
       ORDER BY created_at DESC 
       LIMIT 1
    `);
    const session = stmt.get();

    if (session) {
      // Check message count
      const count = this.countMessages(session.id);
      if (count === 0) {
        return session;
      }
    }
    return null;
  }

  updateSession(id, { title, isArchived, isPinned }) {
    const updates = ['updated_at = CURRENT_TIMESTAMP'];
    const args = [];

    if (title !== undefined) {
      updates.push('title = ?');
      args.push(title);
    }
    if (isArchived !== undefined) {
      updates.push('is_archived = ?');
      args.push(isArchived ? 1 : 0);
    }
    if (isPinned !== undefined) {
      updates.push('is_pinned = ?');
      args.push(isPinned ? 1 : 0);
    }

    args.push(id);
    this.db.prepare(`UPDATE chat_sessions SET ${updates.join(', ')} WHERE id = ?`).run(...args);
  }

  deleteSession(id) {
    // Transactional delete?
    const deleteSession = this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(id);
      this.db.prepare('DELETE FROM summaries WHERE chat_id = ?').run(id);
      this.db.prepare('DELETE FROM token_usage WHERE chat_id = ?').run(id);
      this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
    });
    deleteSession();
    console.log(`[DB] Deleted session ${id} and all related data.`);
    deleteSession();
    console.log(`[DB] Deleted session ${id} and all related data.`);
  }

  deleteEmptySessions() {
    // Delete sessions with no messages older than 10 minutes
    // This cleans up abandoned "New Chats" fast enough to avoid clutter, but gives users time to think/type.
    const stmt = this.db.prepare(`
      DELETE FROM chat_sessions 
      WHERE id IN (
        SELECT cs.id FROM chat_sessions cs
        LEFT JOIN messages m ON cs.id = m.chat_id
        WHERE m.id IS NULL
        AND cs.created_at < datetime('now', '-10 minutes')
      )
    `);
    const info = stmt.run();
    if (info.changes > 0) {
      console.log(`[DB] Cleaned up ${info.changes} empty sessions older than 10m.`);
    }
  }

  // --- Messages ---

  saveMessage(msg) {
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, role, content, parts, source, chat_id, cost, token_count, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Fallback if msg.id is missing or generated elsewhere
    const id = msg.id || crypto.randomUUID();
    const partsStr = msg.parts ? JSON.stringify(msg.parts) : null;
    stmt.run(id, msg.role, msg.content, partsStr, msg.source, msg.metadata?.chatId, msg.cost || 0, msg.tokenCount || 0, msg.timestamp);
  }

  getHistory(options = {}) {
    const { limit = 50, since, until, chatId, order = 'DESC' } = options;

    let query = 'SELECT * FROM messages';
    const params = [];
    const conditions = [];

    if (chatId) {
      conditions.push('chat_id = ?');
      params.push(chatId);
    }
    if (since) {
      conditions.push('timestamp >= ?');
      params.push(since);
    }
    if (until) {
      conditions.push('timestamp <= ?');
      params.push(until);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ` ORDER BY timestamp ${order === 'ASC' ? 'ASC' : 'DESC'} LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params);

    return rows;
  }

  countMessages(chatId) {
    if (!chatId) return 0;
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE chat_id = ?');
    return stmt.get(chatId).count;
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

  getAllFacts() {
    const stmt = this.db.prepare('SELECT key, value FROM kv_store ORDER BY updated_at DESC');
    return stmt.all().map(row => {
      try {
        return { key: row.key, value: JSON.parse(row.value) };
      } catch (e) {
        return { key: row.key, value: row.value };
      }
    });
  }

  getJobState(jobName) {
    const prefix = `job:${jobName}:%`;
    const stmt = this.db.prepare('SELECT key, value, updated_at FROM kv_store WHERE key LIKE ? ORDER BY updated_at DESC');
    return stmt.all(prefix).map(row => {
      // Strip prefix for cleaner API response? Or keep full key?
      // Let's strip prefix for easier reading: "status" instead of "job:weather:status"
      const cleanKey = row.key.replace(`job:${jobName}:`, '');
      try {
        return { key: cleanKey, value: JSON.parse(row.value), updatedAt: row.updated_at };
      } catch (e) {
        return { key: cleanKey, value: row.value, updatedAt: row.updated_at };
      }
    });
  }

  deleteJobState(jobName) {
    const prefix = `job:${jobName}:%`;
    const info = this.db.prepare('DELETE FROM kv_store WHERE key LIKE ?').run(prefix);
    console.log(`[DB] Deleted ${info.changes} facts for job '${jobName}'.`);
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



  saveSummary(chatId, content, rangeStart, rangeEnd, originalTokens = 0, summaryTokens = 0) {
    this.db.prepare(`
      INSERT INTO summaries (chat_id, content, range_start, range_end, original_tokens, summary_tokens)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(chatId, content, rangeStart, rangeEnd, originalTokens, summaryTokens);
  }

  getLatestSummary(chatId) {
    return this.db.prepare(`
      SELECT * FROM summaries 
      WHERE chat_id = ? 
      ORDER BY created_at DESC 
      LIMIT 1
    `).get(chatId);
  }

  getSummaries(limit = 20) {
    return this.db.prepare(`
        SELECT * FROM summaries
        ORDER BY created_at DESC
        LIMIT ?
    `).all(limit);
  }

  getSummaryStats() {
    const stats = this.db.prepare(`
      SELECT 
        COUNT(*) as count, 
        SUM(original_tokens) as original, 
        SUM(summary_tokens) as summary
      FROM summaries
    `).get();

    return {
      totalCount: stats.count || 0,
      totalOriginal: stats.original || 0,
      totalSummary: stats.summary || 0
    };
  }

  clearSummaries() {
    this.db.exec('DELETE FROM summaries');
  }

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
    this.db.exec('DELETE FROM messages');
    this.db.exec('DELETE FROM chat_sessions');
    console.log(`[DB] Cleared ALL history and sessions.`);
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

  // --- Trusted/Verified Contacts ---
  isVerifiedContact(service, contactId) {
    const stmt = this.db.prepare('SELECT 1 FROM verified_contacts WHERE service = ? AND contact_id = ?');
    return !!stmt.get(service, contactId);
  }

  verifyContact(service, contactId) {
    try {
      const stmt = this.db.prepare('INSERT OR IGNORE INTO verified_contacts (service, contact_id) VALUES (?, ?)');
      stmt.run(service, contactId);
      console.log(`[DB] Verified contact ${contactId} for ${service}`);
    } catch (e) {
      console.error('[DB] Failed to verify contact:', e);
    }
  }

  // --- Metrics & Analytics ---
  logMetric(type, value, metadata = {}) {
    const metaStr = JSON.stringify(metadata);
    this.db.prepare('INSERT INTO metrics (type, value, metadata) VALUES (?, ?, ?)').run(type, value, metaStr);
  }

  logTokenUsage({ model, promptTokens, candidateTokens, totalTokens, chatId, estimatedCost }) {
    this.db.prepare(`
      INSERT INTO token_usage (model, prompt_tokens, candidate_tokens, total_tokens, chat_id, estimated_cost)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(model, promptTokens, candidateTokens, totalTokens, chatId, estimatedCost || 0);
  }

  getLatencyTrend(limit = 100) {
    // Get avg latency per hour? Or just raw points for graph?
    // Let's get raw points for now: timestamp, value, type
    // SQLite stores UTC strings by default, but returning them as-is makes JS treat them as local.
    // Force 'Z' suffix to ensure ISO 8601 UTC interpretation.
    const stmt = this.db.prepare(`
      SELECT strftime('%Y-%m-%dT%H:%M:%SZ', timestamp) as timestamp, value, type, metadata FROM metrics 
      WHERE type IN ('latency_router', 'latency_model', 'latency_e2e') 
      ORDER BY timestamp DESC LIMIT ?
    `);
    return stmt.all(limit).reverse();
  }

  getTokenUsageTrend(limit = 100) {
    const stmt = this.db.prepare(`
      SELECT strftime('%Y-%m-%dT%H:%M:%SZ', timestamp) as timestamp, estimated_cost, total_tokens, model 
      FROM token_usage 
      ORDER BY timestamp DESC LIMIT ?
    `);
    return stmt.all(limit).reverse();
  }

  getDailyCostTrend(limit = 7) {
    const stmt = this.db.prepare(`
      SELECT 
        date(timestamp, 'localtime') as date, 
        SUM(estimated_cost) as cost, 
        SUM(total_tokens) as tokens 
      FROM token_usage 
      GROUP BY date(timestamp, 'localtime') 
      ORDER BY date(timestamp, 'localtime') DESC 
      LIMIT ?
    `);
    return stmt.all(limit).reverse();
  }

  getTokenUsageStats() {
    // Total tokens today
    const todayQuery = this.db.prepare(`
      SELECT 
        SUM(prompt_tokens) as prompt, 
        SUM(candidate_tokens) as candidate, 
        SUM(total_tokens) as total,
        SUM(estimated_cost) as cost
      FROM token_usage 
      WHERE date(timestamp, 'localtime') = date('now', 'localtime')
    `).get();

    return {
      today: {
        prompt: todayQuery?.prompt || 0,
        candidate: todayQuery?.candidate || 0,
        total: todayQuery?.total || 0,
        cost: todayQuery?.cost || 0
      }
    };
  }

  getLatencyStats() {
    // Average E2E latency in last 24h
    const avgQuery = this.db.prepare(`
        SELECT AVG(value) as avg_latency 
        FROM metrics 
        WHERE type = 'latency_e2e' 
        AND timestamp > datetime('now', '-24 hours')
      `).get();

    return {
      avg24h: Math.round(avgQuery?.avg_latency || 0)
    };
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

    // Jobs Breakdown
    const jobs = this.db.prepare('SELECT task_type, payload FROM scheduled_jobs').all();

    let activeSystem = 0;
    let activeRecurring = 0;
    let activeOneOff = 0;

    for (const job of jobs) {
      const payload = job.payload ? JSON.parse(job.payload) : {};

      if (payload.isSystem) {
        activeSystem++;
      } else if (job.task_type === 'one_off' || payload.isOneOff) {
        activeOneOff++;
      } else {
        activeRecurring++;
      }
    }

    // Efficiency (Tokens per Message - Rough Estimate)
    // Avg total tokens per message (model role only)
    const tokenEfficiency = this.db.prepare(`
        SELECT AVG(total_tokens) as avg_tokens 
        FROM token_usage 
        WHERE timestamp > datetime('now', '-7 days')
    `).get().avg_tokens || 0;

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
        total: jobs.length,
        system: activeSystem,
        recurring: activeRecurring,
        oneOff: activeOneOff
      },
      efficiency: {
        tokensPerMsg: Math.round(tokenEfficiency)
      }
    };
  }

  // --- Job Logs ---
  logJobExecution(jobName, status, output, durationMs) {
    this.db.prepare(`
      INSERT INTO job_logs (job_name, status, output, duration_ms)
      VALUES (?, ?, ?, ?)
    `).run(jobName, status, output ? String(output) : null, durationMs);
  }

  getJobLogs(limit = 50, offset = 0, jobName = null) {
    let query = 'SELECT * FROM job_logs';
    const params = [];
    const countParams = [];

    if (jobName) {
      query += ' WHERE job_name = ?';
      params.push(jobName);
      countParams.push(jobName);
    }

    // Get Total Count
    const countQuery = `SELECT COUNT(*) as count FROM job_logs${jobName ? ' WHERE job_name = ?' : ''}`;
    const total = this.db.prepare(countQuery).get(...countParams).count;

    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const logs = this.db.prepare(query).all(...params);
    return { logs, total };
  }

  deleteJobLogs(ids) {
    if (!ids || ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`DELETE FROM job_logs WHERE id IN (${placeholders})`);
    const info = stmt.run(...ids);
    console.log(`[DB] Deleted ${info.changes} job logs.`);
    return info.changes;
  }

  clearMetrics() {
    this.db.prepare('DELETE FROM token_usage').run();
    this.db.prepare('DELETE FROM job_logs').run();
    this.db.prepare('DELETE FROM metrics').run();
    return true;
  }

  cleanupJobLogs(retentionDays = 30) {
    const info = this.db.prepare(`
      DELETE FROM job_logs 
      WHERE timestamp < datetime('now', '-' || ? || ' days')
    `).run(retentionDays);
    console.log(`[DB] Cleaned up ${info.changes} old job logs.`);
    return info.changes;
  }

  cleanupMetrics(retentionDays = 30) {
    const info = this.db.prepare(`
      DELETE FROM metrics 
      WHERE timestamp < datetime('now', '-' || ? || ' days')
    `).run(retentionDays);
    console.log(`[DB] Cleaned up ${info.changes} old metrics.`);
    return info.changes;
  }

  cleanupTokenUsage(retentionDays = 30) {
    const info = this.db.prepare(`
      DELETE FROM token_usage 
      WHERE timestamp < datetime('now', '-' || ? || ' days')
    `).run(retentionDays);
    console.log(`[DB] Cleaned up ${info.changes} old token usage logs.`);
    return info.changes;
  }

  forceCleanupAll() {
    this.db.prepare('DELETE FROM metrics').run();
    this.db.prepare('DELETE FROM token_usage').run();
    this.db.prepare('DELETE FROM usage_logs').run(); // Also usage_logs (rate limiting)
    console.log('[DB] FORCE CLEANUP: Deleted all metrics, token_usage, and usage_logs.');
  }
  getAgentSetting(key) {
    const stmt = this.db.prepare('SELECT value FROM agent_settings WHERE key = ?');
    const row = stmt.get(key);
    if (!row) return null;
    try {
      return { key, value: JSON.parse(row.value) };
    } catch (e) {
      return { key, value: row.value };
    }
  }
}

module.exports = { AgentDB };
