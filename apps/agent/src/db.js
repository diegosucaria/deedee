const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Map raw tags to human-friendly service categories for cost breakdown
// For tagged entries, use the tag directly. For NULL-tagged entries (main chat),
// the SQL query resolves the source from chat_id patterns.
const SERVICE_CATEGORIES = {
  // Source-based categories (resolved from chat_id when tag is NULL)
  whatsapp: 'WhatsApp',
  web_chat: 'Web Chat',
  scheduled_job: 'Jobs',
  system_job: 'Jobs',
  subagent: 'Sub-agents',
  // Dreams
  dream: 'Dreams',
  dream_tts: 'Dreams',
  // Speech
  tts: 'Speech',
  tts_preview: 'Speech',
  transcribe: 'Speech',
  eager_transcribe: 'Speech',
  // Image
  image_gen: 'Image',
  eager_describe: 'Image',
  // DJ
  dj_analyze: 'DJ',
  dj_enrich: 'DJ',
  dj_history: 'DJ',
  dj_track_enrich: 'DJ',
  // Memory
  embedding: 'Memory',
  summarization: 'Memory',
  consolidation: 'Memory',
  memory_pruning: 'Memory',
  // Impersonation (Autopilot)
  impersonation_analyze: 'Autopilot',
  impersonation_learn: 'Autopilot',
  autopilot: 'Autopilot',
  // Analysis
  analysis: 'Analysis',
  tool_scoper: 'Analysis',
  cron_helper: 'Analysis',
  // People
  people_enrich: 'People',
  // Grok
  grok: 'Grok',
};

// SQL CASE expression that resolves an effective_tag from tag + chat_id.
// When tag is NOT NULL, use it directly. When tag IS NULL (main agent chat),
// classify by chat_id pattern: WhatsApp JIDs, scheduled jobs, sub-agents, etc.
const EFFECTIVE_TAG_SQL = `
  CASE
    WHEN tag IS NOT NULL THEN tag
    WHEN chat_id LIKE '%@s.us' OR chat_id LIKE '%@g.us' THEN 'whatsapp'
    WHEN chat_id LIKE 'scheduled\\_%' ESCAPE '\\' THEN 'scheduled_job'
    WHEN chat_id LIKE 'system\\_%' ESCAPE '\\' THEN 'system_job'
    WHEN chat_id LIKE 'subagent-%' THEN 'subagent'
    ELSE 'web_chat'
  END`;

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
    // Ensure WAL data is synced to disk on commit (NORMAL is safe with WAL)
    this.db.pragma('synchronous = NORMAL');
    // Wait up to 5s if the DB is locked (RPi can be slow under load)
    this.db.pragma('busy_timeout = 5000');
    // Store temp data in memory for performance
    this.db.pragma('temp_store = MEMORY');

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
        enabled INTEGER DEFAULT 1,
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
        autopilot_status TEXT DEFAULT 'off', -- off, assisted, full
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS autopilot_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT,
        contact_id TEXT,
        content TEXT,
        context_content TEXT, -- NEW: content of the incoming message(s)
        options TEXT, -- JSON array
        status TEXT DEFAULT 'pending', -- pending, approved, rejected
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS watchers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        contact_string TEXT NOT NULL,
        person_id TEXT,
        condition TEXT NOT NULL,
        instruction TEXT NOT NULL,
        status TEXT DEFAULT 'active', -- active, triggered, paused
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_triggered_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS dj_vinyls (
        id TEXT PRIMARY KEY,
        artist TEXT,
        title TEXT,
        label TEXT,
        catalog_number TEXT,
        cover_image_url TEXT,
        bpm REAL,
        key TEXT,
        tracks TEXT, -- JSON array of track names
        meta TEXT,   -- JSON (Year, Genre, Discogs Link)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS dj_crates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'manual',
        rules TEXT,
        icon TEXT,
        color TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS dj_crate_vinyls (
        crate_id TEXT NOT NULL,
        vinyl_id TEXT NOT NULL,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (crate_id, vinyl_id)
      );

      CREATE TABLE IF NOT EXISTS wr_garments (
        id TEXT PRIMARY KEY,
        type TEXT,
        subtype TEXT,
        primary_color TEXT,
        secondary_colors TEXT,
        pattern TEXT,
        material_guess TEXT,
        warmth INTEGER,
        formality INTEGER,
        season_tags TEXT,
        brand TEXT,
        model TEXT,
        size TEXT,
        fit_notes TEXT,
        source_image_path TEXT,
        crop_image_path TEXT,
        bbox TEXT,
        source TEXT DEFAULT 'manual_upload',
        enrichment_status TEXT DEFAULT 'complete',
        enrichment_confidence REAL DEFAULT 0,
        meta TEXT,
        times_worn INTEGER DEFAULT 0,
        last_worn_at TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS wr_outfits (
        id TEXT PRIMARY KEY,
        name TEXT,
        occasion TEXT,
        weather_tags TEXT,
        garment_ids TEXT,
        rendered_image_path TEXT,
        liked INTEGER DEFAULT 0,
        last_suggested_at TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS wr_trips (
        id TEXT PRIMARY KEY,
        calendar_event_id TEXT,
        destination TEXT,
        start_date TEXT,
        end_date TEXT,
        activities TEXT,
        weather_snapshot TEXT,
        planned_capsule TEXT,
        actual_capsule TEXT,
        status TEXT DEFAULT 'planned',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS wr_shopping_list (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        type TEXT,
        primary_color TEXT,
        pattern TEXT,
        material_hint TEXT,
        suggested_context TEXT,
        priority TEXT DEFAULT 'medium',
        status TEXT DEFAULT 'wanted',
        resolved_garment_id TEXT,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        purchased_at TEXT
      );

      CREATE TABLE IF NOT EXISTS wr_user_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        reference_image_path TEXT,
        preferred_brands TEXT,
        sizing TEXT,
        style_notes TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS subagents (
        id TEXT PRIMARY KEY,
        parent_chat_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT DEFAULT 'running',
        model TEXT,
        result TEXT,
        error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'warning',
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata TEXT,
        is_read INTEGER DEFAULT 0,
        is_dismissed INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_notifications_active
        ON notifications(is_read, is_dismissed, created_at DESC);
    `);

    // Seed wr_user_profile singleton (id=1) with preferred brands if missing
    try {
      const existing = this.db.prepare('SELECT id FROM wr_user_profile WHERE id = 1').get();
      if (!existing) {
        this.db.prepare(`
          INSERT INTO wr_user_profile (id, preferred_brands, sizing, style_notes)
          VALUES (1, ?, ?, ?)
        `).run(JSON.stringify(['Lacoste', 'Lululemon']), '{}', '');
      }
    } catch (err) {
      console.warn('[DB] Failed to seed wr_user_profile:', err.message);
    }

    // Migration: Add watchers table if missing (idempotent via create table if not exists, but for updates just in case)
    // ...

    // Migration: Backfill sessions for existing messages
    try {
      this.migrateSessions();
    } catch (err) {
      console.warn('[DB] Session migration failed (non-fatal):', err.message);
    }

    try {
      this.db.exec("ALTER TABLE people ADD COLUMN autopilot_status TEXT DEFAULT 'off'");
    } catch (e) {
      // Ignore if column exists
    }

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

    // Migration: Add enabled column to scheduled_jobs
    try {
      this.db.exec("ALTER TABLE scheduled_jobs ADD COLUMN enabled INTEGER DEFAULT 1");
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

    // Migration: Add metadata to messages
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN metadata TEXT");
    } catch (err) { }

    // Migration: Add autopilot_expires_at to people
    try {
      this.db.exec("ALTER TABLE people ADD COLUMN autopilot_expires_at DATETIME");
    } catch (err) { }


    // Migration: Add is_pinned to chat_sessions
    try {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN is_pinned INTEGER DEFAULT 0");
    } catch (err) { }

    // Migration: Add identifiers to people
    try {
      this.db.exec("ALTER TABLE people ADD COLUMN identifiers TEXT");
    } catch (err) { }

    // Migration: Add tag to token_usage
    try {
      this.db.exec("ALTER TABLE token_usage ADD COLUMN tag TEXT");
    } catch (err) { }

    // Migration: Add cached_tokens and thoughts_tokens to token_usage (implicit caching + thinking)
    try {
      this.db.exec("ALTER TABLE token_usage ADD COLUMN cached_tokens INTEGER DEFAULT 0");
    } catch (err) { }
    try {
      this.db.exec("ALTER TABLE token_usage ADD COLUMN thoughts_tokens INTEGER DEFAULT 0");
    } catch (err) { }

    // Migration: Add context_content to autopilot_drafts
    try {
      this.db.exec("ALTER TABLE autopilot_drafts ADD COLUMN context_content TEXT");
    } catch (err) { }

    // Migration: Add sent_count to autopilot_drafts (track partial send progress)
    try {
      this.db.exec("ALTER TABLE autopilot_drafts ADD COLUMN sent_count INTEGER DEFAULT 0");
    } catch (err) { }

    // Migration: Add relationship to people (Fix for older DBs)
    try {
      this.db.exec("ALTER TABLE people ADD COLUMN relationship TEXT");
    } catch (err) { }

    // Migration: Add category to kv_store (memory metadata)
    try {
      this.db.exec("ALTER TABLE kv_store ADD COLUMN category TEXT DEFAULT 'general'");
    } catch (err) { }

    // Migration: Add confidence to kv_store
    try {
      this.db.exec("ALTER TABLE kv_store ADD COLUMN confidence TEXT DEFAULT 'inferred'");
    } catch (err) { }

    // Migration: Add source to kv_store
    try {
      this.db.exec("ALTER TABLE kv_store ADD COLUMN source TEXT DEFAULT 'system'");
    } catch (err) { }

    // Migration: Add created_at to kv_store
    try {
      this.db.exec("ALTER TABLE kv_store ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP");
    } catch (err) { }

    // Migration: Add pinned to kv_store (protect from auto-pruning)
    try {
      this.db.exec("ALTER TABLE kv_store ADD COLUMN pinned INTEGER DEFAULT 0");
    } catch (err) { }

    // Migration: Add enrichment_status to dj_vinyls
    try {
      this.db.exec("ALTER TABLE dj_vinyls ADD COLUMN enrichment_status TEXT DEFAULT 'complete'");
    } catch (err) { }
  }

  // --- Scheduled Jobs ---
  saveScheduledJob(job) {
    const payloadStr = JSON.stringify(job.payload || {});
    const enabledVal = job.enabled !== false ? 1 : 0;
    const stmt = this.db.prepare(`
      INSERT INTO scheduled_jobs (name, cron_expression, task_type, payload, expires_at, enabled) 
      VALUES (?, ?, ?, ?, ?, ?) 
      ON CONFLICT(name) DO UPDATE SET 
        cron_expression=excluded.cron_expression, 
        task_type=excluded.task_type, 
        payload=excluded.payload,
        expires_at=excluded.expires_at,
        enabled=excluded.enabled
    `);
    stmt.run(job.name, job.cronExpression, job.taskType || 'function_call', payloadStr, job.expiresAt || null, enabledVal);
  }

  getScheduledJobs() {
    const stmt = this.db.prepare('SELECT * FROM scheduled_jobs');
    return stmt.all().map(row => ({
      name: row.name,
      cronExpression: row.cron_expression,
      taskType: row.task_type,
      payload: row.payload ? JSON.parse(row.payload) : {},
      expiresAt: row.expires_at,
      enabled: row.enabled === 1,
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
    if (updates.autopilot_status !== undefined) { fields.push('autopilot_status = ?'); args.push(updates.autopilot_status); }
    if (updates.autopilot_expires_at !== undefined) { fields.push('autopilot_expires_at = ?'); args.push(updates.autopilot_expires_at); }

    if (fields.length === 0) return;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    args.push(id);

    const sql = `UPDATE people SET ${fields.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...args);
  }

  deletePerson(id) {
    this.db.prepare('DELETE FROM people WHERE id = ?').run(id);
  }

  deleteGroupContacts() {
    // WhatsApp group IDs are 18+ digit numbers (e.g. 120363187523636164)
    // Normal phone numbers are at most 15 digits (ITU-T E.164)
    const rows = this.db.prepare(
      "SELECT id, name, phone FROM people WHERE source = 'whatsapp_sync' AND length(phone) > 16"
    ).all();
    if (rows.length > 0) {
      this.db.prepare(
        "DELETE FROM people WHERE source = 'whatsapp_sync' AND length(phone) > 16"
      ).run();
    }
    return rows;
  }

  countPeople() {
    return this.db.prepare('SELECT COUNT(*) as count FROM people').get().count;
  }

  listPeople({ limit, offset, query } = {}) {
    let sql = 'SELECT * FROM people';
    const args = [];
    const conditions = [];

    if (query) {
      const wildcard = `%${query}%`;
      conditions.push(`(name LIKE ? OR relationship LIKE ? OR notes LIKE ? OR phone LIKE ? OR ? LIKE ('%' || name || '%'))`);
      args.push(wildcard, wildcard, wildcard, wildcard, query);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY name ASC';

    if (limit) {
      sql += ' LIMIT ?';
      args.push(limit);
    }

    if (offset) {
      sql += ' OFFSET ?';
      args.push(offset);
    }

    return this.db.prepare(sql).all(...args).map(row => ({
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
      OR ? LIKE ('%' || name || '%')
    `);
    // Pass wildcard 4 times, then raw query once for the reverse match
    return stmt.all(wildcard, wildcard, wildcard, wildcard, query).map(row => ({
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
      // console.log(`[DB] Auto-created session ${chatId} (${title})`);
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
      AND id NOT LIKE 'sys_%' -- Exclude system internal sessions
      AND id NOT LIKE 'subagent-%' -- Exclude sub-agent sessions
      AND id LIKE '%-%' -- Keep only UUIDs (Web sessions), filters out numeric Telegram IDs
      AND id NOT LIKE '%@%' -- Filter out WhatsApp IDs
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

  updateSessionTitle(id, title) {
    return this.updateSession(id, { title });
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
  }

  deleteEmptySessions(preserveId = null) {
    // Strategy:
    // 1. If preserveId is provided (user is looking at a specific chat), we can be aggressive and delete ALL other empty sessions instantly.
    // 2. If no preserveId, we fallback to the safety buffer (e.g. 10 mins or maybe 1 min?) to avoid deleting a just-created session 
    //    that the user hasn't typed in yet (race condition where frontend created it but not yet focused or sending ID).

    let sql = `
      DELETE FROM chat_sessions 
      WHERE id IN (
        SELECT cs.id FROM chat_sessions cs
        LEFT JOIN messages m ON cs.id = m.chat_id
        WHERE m.id IS NULL
    `;

    const args = [];

    if (preserveId) {
      // Aggressive Mode: Delete ANY empty session that isn't the preserved one.
      // We still give a Tiny buffer (e.g. 5 seconds) just in case of parallel requests/latency, 
      // but effectively it cleans up "yesterday's empty chat" immediately.
      sql += ` AND cs.id != ? AND cs.created_at < datetime('now', '-5 seconds')`;
      args.push(preserveId);
    } else {
      // Passive Mode: Only delete very old abandoned sessions
      sql += ` AND cs.created_at < datetime('now', '-10 minutes')`;
    }

    sql += ` )`;

    const stmt = this.db.prepare(sql);
    const info = stmt.run(...args);

    if (info.changes > 0) {
      console.log(`[DB] Cleaned up ${info.changes} empty sessions. (Preserve: ${preserveId})`);
    }
  }

  // --- Messages ---

  deleteMessagesFrom(chatId, messageId) {
    // 1. Get timestamp of the target message
    const target = this.db.prepare('SELECT timestamp FROM messages WHERE id = ? AND chat_id = ?').get(messageId, chatId);

    if (!target) {
      console.warn(`[DB] Rewind failed: Message ${messageId} not found in chat ${chatId}`);
      return 0;
    }

    // 2. Delete that message and everything after it
    const info = this.db.prepare(`
        DELETE FROM messages 
        WHERE chat_id = ? 
        AND timestamp >= ?
    `).run(chatId, target.timestamp);

    console.log(`[DB] Rewinded chat ${chatId} from message ${messageId} (${target.timestamp}). Deleted ${info.changes} messages.`);
    return info.changes;
  }

  forkSession(sourceChatId, messageId) {
    const targetMsg = this.db.prepare('SELECT timestamp FROM messages WHERE id = ? AND chat_id = ?').get(messageId, sourceChatId);
    if (!targetMsg) throw new Error('Target message not found');

    const sourceSession = this.getSession(sourceChatId);
    if (!sourceSession) throw new Error('Source session not found');

    // 1. Create New Session
    const newSessionId = crypto.randomUUID();
    const newTitle = `${sourceSession.title} (Fork)`;
    this.createSession({ id: newSessionId, title: newTitle });

    // 2. Copy Messages (Role: User/Assistant/System) up to targetMsg
    // Sort ASC to insertion order
    const messagesToCopy = this.db.prepare(`
        SELECT * FROM messages 
        WHERE chat_id = ? 
        AND timestamp <= ?
        ORDER BY timestamp ASC
    `).all(sourceChatId, targetMsg.timestamp);

    const insertStmt = this.db.prepare(`
        INSERT INTO messages (id, role, content, parts, source, chat_id, cost, token_count, timestamp, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Transaction
    const forkTx = this.db.transaction(() => {
      for (const msg of messagesToCopy) {
        // New Message ID to avoid PK conflict if we ever merge? 
        // Generate a new ID for the copy to avoid conflicts
        const newMsgId = crypto.randomUUID();
        insertStmt.run(newMsgId, msg.role, msg.content, msg.parts, msg.source, newSessionId, msg.cost, msg.token_count, msg.timestamp, msg.metadata);
      }
    });

    forkTx();
    console.log(`[DB] Forked session ${sourceChatId} to ${newSessionId} (${messagesToCopy.length} messages)`);
    return newSessionId;
  }

  saveMessage(msg) {
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, role, content, parts, source, chat_id, cost, token_count, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Fallback if msg.id is missing or generated elsewhere
    const id = msg.id || crypto.randomUUID();
    const partsStr = msg.parts ? JSON.stringify(msg.parts) : null;
    const metaStr = msg.metadata ? JSON.stringify(msg.metadata) : null;
    const targetChatId = msg.chatId || msg.chat_id || msg.metadata?.chatId;
    stmt.run(id, msg.role, msg.content, partsStr, msg.source, targetChatId, msg.cost || 0, msg.tokenCount || 0, msg.timestamp || Date.now(), metaStr);
  }

  getHistory(options = {}) {
    const { limit = 50, since, until, chatId, order = 'DESC', source } = options;

    // Classify source by chat_id pattern (messages table has no 'tag' column)
    const sourceClassification = `
      CASE
        WHEN m.chat_id LIKE '%@s.us' OR m.chat_id LIKE '%@g.us' THEN 'whatsapp'
        WHEN m.chat_id LIKE 'scheduled\\_%' ESCAPE '\\' THEN 'scheduled_job'
        WHEN m.chat_id LIKE 'system\\_%' ESCAPE '\\' THEN 'system_job'
        WHEN m.chat_id LIKE 'subagent-%' THEN 'subagent'
        ELSE 'web_chat'
      END`;

    let query = `
      SELECT m.*, cs.title as session_title,
        ${sourceClassification} as effective_source
      FROM messages m
      LEFT JOIN chat_sessions cs ON m.chat_id = cs.id
    `;
    const params = [];
    const conditions = [];

    if (chatId) {
      conditions.push('m.chat_id = ?');
      params.push(chatId);
    }
    if (since) {
      conditions.push('m.timestamp >= ?');
      params.push(since);
    }
    if (until) {
      conditions.push('m.timestamp <= ?');
      params.push(until);
    }

    // Server-side source filtering by chat_id pattern
    if (source && source !== 'all') {
      switch (source) {
        case 'subagent':
          conditions.push("m.chat_id LIKE 'subagent-%'");
          break;
        case 'scheduled_job':
          conditions.push("m.chat_id LIKE 'scheduled\\_%' ESCAPE '\\'");
          break;
        case 'system_job':
          conditions.push("m.chat_id LIKE 'system\\_%' ESCAPE '\\'");
          break;
        case 'whatsapp':
          conditions.push("(m.chat_id LIKE '%@s.us' OR m.chat_id LIKE '%@g.us')");
          break;
        case 'web_chat':
          conditions.push("m.chat_id NOT LIKE 'subagent-%' AND m.chat_id NOT LIKE 'scheduled\\_%' ESCAPE '\\' AND m.chat_id NOT LIKE 'system\\_%' ESCAPE '\\' AND m.chat_id NOT LIKE '%@s.us' AND m.chat_id NOT LIKE '%@g.us'");
          break;
      }
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ` ORDER BY m.timestamp ${order === 'ASC' ? 'ASC' : 'DESC'} LIMIT ?`;
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

  clearHistory(chatId) {
    if (!chatId) return;
    this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
    this.db.prepare('DELETE FROM summaries WHERE chat_id = ?').run(chatId);
    this.db.prepare('DELETE FROM token_usage WHERE chat_id = ?').run(chatId);
  }

  clearAllHistory() {
    this.db.prepare('DELETE FROM messages').run();
    this.db.prepare('DELETE FROM summaries').run();
    this.db.prepare('DELETE FROM token_usage').run();
    this.db.prepare('DELETE FROM chat_sessions').run();
  }

  clearSummaries() {
    this.db.prepare('DELETE FROM summaries').run();
  }

  // clearGoals is defined below in the "Reset Commands" section (scoped by chatId via metadata match)

  clearHistoryBySource(sourcePrefix) {
    const pattern = `${sourcePrefix}%`;
    const info = this.db.prepare('DELETE FROM messages WHERE source LIKE ?').run(pattern);
    console.log(`[DB] Deleted ${info.changes} messages from source ${sourcePrefix}`);
    // Cleanup empty sessions afterwards
    this.deleteEmptySessions();
    return info.changes;
  }

  // --- KV Store (Memory) ---
  setKey(key, value, options = {}) {
    const valStr = JSON.stringify(value);
    const { category, confidence, source } = options;
    const stmt = this.db.prepare(`
      INSERT INTO kv_store (key, value, category, confidence, source) VALUES (?, ?, COALESCE(?, 'general'), COALESCE(?, 'inferred'), COALESCE(?, 'system'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP,
        category = COALESCE(excluded.category, kv_store.category),
        confidence = COALESCE(excluded.confidence, kv_store.confidence),
        source = COALESCE(excluded.source, kv_store.source)
    `);
    stmt.run(key, valStr, category || null, confidence || null, source || null);
  }

  getKey(key) {
    const stmt = this.db.prepare('SELECT value FROM kv_store WHERE key = ?');
    const row = stmt.get(key);
    return row ? JSON.parse(row.value) : null;
  }

  getFact(key) {
    const row = this.db.prepare('SELECT * FROM kv_store WHERE key = ?').get(key);
    if (!row) return null;
    try { return { ...row, value: JSON.parse(row.value) }; }
    catch (e) { return row; }
  }

  toggleFactPin(key, pinned) {
    this.db.prepare('UPDATE kv_store SET pinned = ? WHERE key = ?').run(pinned ? 1 : 0, key);
  }

  getAllFacts() {
    const stmt = this.db.prepare('SELECT * FROM kv_store ORDER BY updated_at DESC');
    return stmt.all().map(row => {
      let value = row.value;
      try { value = JSON.parse(row.value); } catch (e) { /* keep raw */ }
      return {
        key: row.key,
        value,
        updated_at: row.updated_at,
        category: row.category || 'general',
        confidence: row.confidence || 'inferred',
        source: row.source || 'system',
        created_at: row.created_at || null,
        pinned: row.pinned || 0
      };
    });
  }

  getFactsFormatted(query = '') {
    const facts = this.getAllFacts();
    if (facts.length === 0) return '';

    const q = (query || '').toLowerCase();
    let hiddenCount = 0;
    let nodeRedActive = false;

    // HEURISTIC FILTERING
    const relevantFacts = facts.filter(f => {
      const key = f.key.toLowerCase();

      // Filter 1: Node-RED / Home Assistant Context
      if (key.includes('node_red') || key.includes('ha_nodes')) {
        const keywords = ['node red', 'node-red', 'home assistant', 'automation', 'flow', 'script'];
        const isMatch = keywords.some(k => q.includes(k));

        if (isMatch) {
          nodeRedActive = true;
          return true;
        } else {
          hiddenCount++;
          return false;
        }
      }

      // Filter 2: Stale dated facts (>5 days old) — exclude from prompt, still in DB for RAG/search
      const dateMatch = key.match(/_on_(\d{4}-\d{2}-\d{2})$/);
      if (dateMatch) {
        const factDate = new Date(dateMatch[1] + 'T00:00:00');
        if (!isNaN(factDate.getTime())) {
          const daysOld = Math.floor((Date.now() - factDate.getTime()) / (1000 * 60 * 60 * 24));
          if (daysOld > 5) {
            hiddenCount++;
            return false;
          }
        }
      }

      // Filter 3: Notification flags — these are state, not facts
      if (key.startsWith('notified_')) {
        hiddenCount++;
        return false;
      }

      // Default: Include everything else
      return true;
    });

    if (hiddenCount > 0) {
      console.log(`[Memory] Suppressed ${hiddenCount} stale/filtered facts. (Query: "${q.substring(0, 20)}...")`);
    } else if (nodeRedActive) {
      console.log(`[Memory] Node-RED Context ACTIVE. Input matched keywords.`);
    }

    return relevantFacts.map(f => `- ${f.key}: ${JSON.stringify(f.value)}`).join('\n');
  }

  getJobState(jobName) {
    const prefix = `job:${jobName}:%`;
    const stmt = this.db.prepare('SELECT key, value, updated_at FROM kv_store WHERE key LIKE ? ORDER BY updated_at DESC');
    return stmt.all(prefix).map(row => {
      // Strip prefix for cleaner API response? Or keep full key?
      // Strip job name prefix for cleaner output (e.g. "status" instead of "job:weather:status")
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

  // --- Watchers ---
  createWatcher(watcher) {
    const stmt = this.db.prepare(`
        INSERT INTO watchers (name, contact_string, person_id, condition, instruction, status)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
      watcher.name || 'New Watcher',
      watcher.contactString,
      watcher.personId || null,
      watcher.condition,
      watcher.instruction,
      watcher.status || 'active'
    );
  }

  getWatchers(status = 'active') {
    const watchers = this.db.prepare('SELECT * FROM watchers WHERE status = ?').all(status);
    console.log(`[DB] getWatchers('${status}') returned ${watchers.length} rows.`);
    return watchers;
  }

  getAllWatchers() {
    return this.db.prepare('SELECT * FROM watchers ORDER BY created_at DESC').all();
  }

  updateWatcher(id, updates) {
    const fields = [];
    const args = [];

    // Support all fields
    if (updates.name) { fields.push('name = ?'); args.push(updates.name); }
    if (updates.contactString) { fields.push('contact_string = ?'); args.push(updates.contactString); }
    if (updates.condition) { fields.push('condition = ?'); args.push(updates.condition); }
    if (updates.instruction) { fields.push('instruction = ?'); args.push(updates.instruction); }
    if (updates.status) { fields.push('status = ?'); args.push(updates.status); }
    if (updates.lastTriggeredAt) { fields.push('last_triggered_at = ?'); args.push(updates.lastTriggeredAt); }

    if (fields.length === 0) return;
    args.push(id);

    const sql = `UPDATE watchers SET ${fields.join(', ')} WHERE id = ? `;
    this.db.prepare(sql).run(...args);
  }

  deleteWatcher(id) {
    this.db.prepare('DELETE FROM watchers WHERE id = ?').run(id);
  }

  // --- Rate Limiting ---
  logUsage() {
    this.db.prepare('INSERT INTO usage_logs (timestamp) VALUES (CURRENT_TIMESTAMP)').run();
  }

  checkLimit(hours) {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count 
      FROM usage_logs 
      WHERE timestamp > datetime('now', '-' || ? || ' hours')
    `);
    return stmt.get(hours).count;
  }

  logTokenUsage({ model, promptTokens, candidateTokens, totalTokens, chatId, estimatedCost, tag, cachedTokens, thoughtsTokens }) {
    const stmt = this.db.prepare(`
      INSERT INTO token_usage(model, prompt_tokens, candidate_tokens, total_tokens, chat_id, estimated_cost, tag, cached_tokens, thoughts_tokens)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(model, promptTokens, candidateTokens, totalTokens, chatId, estimatedCost, tag || null, cachedTokens || 0, thoughtsTokens || 0);
  }

  // --- DJ Vinyls ---
  addVinyl(vinyl) {
    const id = vinyl.id || crypto.randomUUID();
    const tracksStr = vinyl.tracks ? JSON.stringify(vinyl.tracks) : '[]';
    const metaStr = vinyl.meta ? JSON.stringify(vinyl.meta) : '{}';

    const stmt = this.db.prepare(`
      INSERT INTO dj_vinyls(id, artist, title, label, catalog_number, cover_image_url, bpm, key, tracks, meta, enrichment_status)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, vinyl.artist, vinyl.title, vinyl.label, vinyl.catalogNumber, vinyl.coverImageUrl, vinyl.bpm, vinyl.key, tracksStr, metaStr, vinyl.enrichmentStatus || 'complete');
    return id;
  }

  findVinylByArtistTitle(artist, title) {
    if (!artist || !title) return null;
    const stmt = this.db.prepare(`
      SELECT * FROM dj_vinyls
      WHERE LOWER(artist) = LOWER(?) AND LOWER(title) = LOWER(?)
      LIMIT 1
    `);
    const row = stmt.get(artist.trim(), title.trim());
    if (row) {
      row.tracks = JSON.parse(row.tracks);
      row.meta = JSON.parse(row.meta);
    }
    return row || null;
  }

  deleteVinyl(id) {
    // Get vinyl to find cover image path
    const vinyl = this.getVinyl(id);
    if (!vinyl) return false;

    // Delete cover image file if it's not the default
    if (vinyl.cover_image_url && vinyl.cover_image_url !== '/vinyl_covers/default.png') {
      const fs = require('fs');
      const path = require('path');
      const filename = vinyl.cover_image_url.replace('/vinyl_covers/', '');
      const filePath = path.join(process.env.DATA_DIR || '/app/data', 'vinyl_covers', filename);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) {
        console.warn('[DB] Failed to delete cover image:', e.message);
      }
    }

    this.db.prepare('DELETE FROM dj_vinyls WHERE id = ?').run(id);
    return true;
  }

  getVinyl(id) {
    const stmt = this.db.prepare('SELECT * FROM dj_vinyls WHERE id = ?');
    const row = stmt.get(id);
    if (row) {
      row.tracks = JSON.parse(row.tracks);
      row.meta = JSON.parse(row.meta);
    }
    return row;
  }

  getVinyls({ limit = 50, offset = 0 } = {}) {
    const stmt = this.db.prepare('SELECT * FROM dj_vinyls ORDER BY created_at DESC LIMIT ? OFFSET ?');
    return stmt.all(limit, offset).map(row => ({
      ...row,
      tracks: JSON.parse(row.tracks),
      meta: JSON.parse(row.meta)
    }));
  }

  updateVinyl(id, fields) {
    const allowed = ['artist', 'title', 'label', 'catalog_number', 'cover_image_url', 'bpm', 'key', 'tracks', 'meta', 'enrichment_status'];
    const sets = [];
    const values = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = k === 'catalogNumber' ? 'catalog_number' : k === 'coverImageUrl' ? 'cover_image_url' : k;
      if (!allowed.includes(col)) continue;
      sets.push(`${col} = ?`);
      values.push(col === 'tracks' || col === 'meta' ? JSON.stringify(v) : v);
    }
    if (sets.length === 0) return false;
    values.push(id);
    this.db.prepare(`UPDATE dj_vinyls SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return true;
  }

  searchVinyls(query) {
    if (!query) return [];
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];
    // Build WHERE clause: every token must match at least one field
    const conditions = tokens.map(() =>
      `(artist LIKE ? OR title LIKE ? OR label LIKE ? OR catalog_number LIKE ? OR tracks LIKE ?)`
    ).join(' AND ');
    const params = tokens.flatMap((t) => {
      const w = `%${t}%`;
      return [w, w, w, w, w];
    });
    const stmt = this.db.prepare(`
      SELECT * FROM dj_vinyls
      WHERE ${conditions}
      ORDER BY created_at DESC
    `);
    return stmt.all(...params).map(row => ({
      ...row,
      tracks: JSON.parse(row.tracks),
      meta: JSON.parse(row.meta)
    }));
  }

  // --- DJ Crates ---
  addCrate({ name, type = 'manual', rules = null, icon = null, color = null }) {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO dj_crates(id, name, type, rules, icon, color) VALUES(?, ?, ?, ?, ?, ?)
    `).run(id, name, type, rules ? JSON.stringify(rules) : null, icon, color);
    return id;
  }

  getCrate(id) {
    const row = this.db.prepare('SELECT * FROM dj_crates WHERE id = ?').get(id);
    if (row?.rules) row.rules = JSON.parse(row.rules);
    return row || null;
  }

  getCrates() {
    return this.db.prepare('SELECT * FROM dj_crates ORDER BY created_at ASC').all().map(row => {
      if (row.rules) row.rules = JSON.parse(row.rules);
      return row;
    });
  }

  updateCrate(id, fields) {
    const allowed = ['name', 'type', 'rules', 'icon', 'color'];
    const sets = [], values = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k} = ?`);
      values.push(k === 'rules' && v ? JSON.stringify(v) : v);
    }
    if (sets.length === 0) return false;
    values.push(id);
    this.db.prepare(`UPDATE dj_crates SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return true;
  }

  deleteCrate(id) {
    this.db.prepare('DELETE FROM dj_crate_vinyls WHERE crate_id = ?').run(id);
    this.db.prepare('DELETE FROM dj_crates WHERE id = ?').run(id);
    return true;
  }

  addVinylToCrate(crateId, vinylId) {
    this.db.prepare(`INSERT OR IGNORE INTO dj_crate_vinyls(crate_id, vinyl_id) VALUES(?, ?)`).run(crateId, vinylId);
  }

  removeVinylFromCrate(crateId, vinylId) {
    this.db.prepare('DELETE FROM dj_crate_vinyls WHERE crate_id = ? AND vinyl_id = ?').run(crateId, vinylId);
  }

  getCrateVinyls(crateId) {
    const crate = this.getCrate(crateId);
    if (!crate) return [];

    if (crate.type === 'manual') {
      return this.db.prepare(`
        SELECT v.* FROM dj_vinyls v
        INNER JOIN dj_crate_vinyls cv ON cv.vinyl_id = v.id
        WHERE cv.crate_id = ?
        ORDER BY cv.added_at DESC
      `).all(crateId).map(row => ({
        ...row,
        tracks: JSON.parse(row.tracks || '[]'),
        meta: JSON.parse(row.meta || '{}')
      }));
    }

    // Smart crate: evaluate rules against all vinyls
    return this._evaluateSmartCrateRules(crate.rules);
  }

  _evaluateSmartCrateRules(rules) {
    if (!rules) return this.getVinyls({ limit: 500 });
    const vinyls = this.getVinyls({ limit: 500 });
    return vinyls.filter(v => {
      const meta = v.meta || {};
      const tracks = v.tracks || [];
      if (rules.genre && !meta.genre?.toLowerCase().includes(rules.genre.toLowerCase())) return false;
      if (rules.style && !meta.style?.toLowerCase().includes(rules.style.toLowerCase())) return false;
      if (rules.label && !v.label?.toLowerCase().includes(rules.label.toLowerCase())) return false;
      if (rules.rpm && meta.rpm && meta.rpm !== rules.rpm) return false;
      if (rules.yearMin && meta.year && meta.year < rules.yearMin) return false;
      if (rules.yearMax && meta.year && meta.year > rules.yearMax) return false;
      if (rules.bpmMin || rules.bpmMax) {
        const hasMatch = tracks.some(t => {
          const bpm = t.bpm || 0;
          if (!bpm) return false;
          if (rules.bpmMin && bpm < rules.bpmMin) return false;
          if (rules.bpmMax && bpm > rules.bpmMax) return false;
          return true;
        });
        if (!hasMatch) return false;
      }
      return true;
    });
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
    const likeQuery = `% ${query} % `;
    return stmt.all(likeQuery, likeQuery, limit);
  }

  getMessagesByDate(dateStr) {
    // 1. Get Agent.db Messages
    // dateStr format YYYY-MM-DD
    // Compare against Local Time date of the timestamp
    const stmt = this.db.prepare(`
        SELECT role, content, timestamp, source, metadata FROM messages
        WHERE date(timestamp, 'localtime') = ?
      `);
    const agentMessages = stmt.all(dateStr);
    console.log(`[DB] getMessagesByDate(${dateStr}): Agent DB returned ${agentMessages.length} messages`);
    if (agentMessages.length > 0) {
      console.log(`[DB]   Agent preview: "${(agentMessages[0].content || '').substring(0, 80)}..." (source: ${agentMessages[0].source})`);
    }

    // 2. Safely get WhatsApp User Messages
    // The WhatsApp DB lives in the interfaces container's volume.
    // In Docker (Balena), it's mounted at /app/interfaces-data/messages_user.db (read-only).
    // In local dev, it may be in the same directory as agent.db.
    let whatsappMessages = [];
    const interfacesDataPath = path.join('/app', 'interfaces-data', 'messages_user.db');
    const localFallbackPath = path.join(path.dirname(this.dbPath), 'messages_user.db');
    const whatsappDbPath = fs.existsSync(interfacesDataPath) ? interfacesDataPath : localFallbackPath;
    console.log(`[DB] WhatsApp DB path: ${whatsappDbPath} | exists: ${fs.existsSync(whatsappDbPath)}`);
    if (fs.existsSync(whatsappDbPath)) {
      try {
        const waDb = new Database(whatsappDbPath, { readonly: true });

        // Convert YYYY-MM-DD to unix timestamps for start and end of that day (Localtime)
        // A simple way is to use SQLite date formatting in the query itself since the timestamp column in msg.db is unix seconds
        // Exclude group messages (where remote_jid ends with '@g.us')
        const waStmt = waDb.prepare(`
          SELECT 
            CASE WHEN m.from_me = 1 THEN 'assistant' ELSE 'user' END as role,
            m.content,
            datetime(m.timestamp, 'unixepoch') as timestamp,
            'whatsapp:user' as source,
            json_object(
              'chatId', m.remote_jid,
              'session', 'user',
              'notifyName', COALESCE(c.notify, c.name)
            ) as metadata
          FROM messages m
          LEFT JOIN contacts c ON c.id = m.remote_jid
          WHERE date(datetime(m.timestamp, 'unixepoch'), 'localtime') = ?
            AND m.content IS NOT NULL
            AND m.content != ''
            AND m.remote_jid NOT LIKE '%@g.us'
        `);
        whatsappMessages = waStmt.all(dateStr);
        console.log(`[DB] getMessagesByDate(${dateStr}): WhatsApp DB returned ${whatsappMessages.length} messages`);
        if (whatsappMessages.length > 0) {
          console.log(`[DB]   WA preview: "${(whatsappMessages[0].content || '').substring(0, 80)}..."`);
        }

        // Diagnostic: also check total raw count for that date without filters
        const debugStmt = waDb.prepare(`
          SELECT COUNT(*) as cnt, 
                 MIN(datetime(timestamp, 'unixepoch')) as earliest,
                 MAX(datetime(timestamp, 'unixepoch')) as latest
          FROM messages 
          WHERE date(datetime(timestamp, 'unixepoch'), 'localtime') = ?
        `);
        const debugRow = debugStmt.get(dateStr);
        console.log(`[DB]   WA total (incl. groups, empty): ${debugRow.cnt} | range: ${debugRow.earliest} - ${debugRow.latest}`);

        waDb.close();
      } catch (e) {
        console.error(`[DB] Failed to fetch WhatsApp messages for consolidation:`, e.message);
      }
    }

    // 3. Merge and Sort
    const allMessages = [...agentMessages, ...whatsappMessages];

    // Sort by Date (ascending)
    allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return allMessages;
  }



  saveSummary(chatId, content, rangeStart, rangeEnd, originalTokens = 0, summaryTokens = 0) {
    this.db.prepare(`
      INSERT INTO summaries(chat_id, content, range_start, range_end, original_tokens, summary_tokens)
      VALUES(?, ?, ?, ?, ?, ?)
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
      SELECT role, content, metadata FROM messages 
      WHERE chat_id = ?
      ORDER BY timestamp DESC 
      LIMIT ?
    `);

    const rows = stmt.all(chatId, limit).reverse(); // Reverse to get chronological order

    // Map to Gemini SDK format
    return rows.map(row => {
      let meta = {};
      try { meta = row.metadata ? JSON.parse(row.metadata) : {}; } catch (e) { }

      // Map 'assistant' role to 'model' for Gemini

      // Map 'function' role to 'user' for Gemini (function results are considered user input in the chat loop)
      let role = row.role;
      if (role === 'assistant') role = 'model';
      if (role === 'function') role = 'user';

      if (row.parts) {
        try {
          return { role, parts: JSON.parse(row.parts), metadata: meta };
        } catch (e) {
          console.error('[DB] Failed to parse message parts:', e);
        }
      }

      // Fallback to content
      return {
        role: role,
        parts: [{ text: row.content || '' }],
        metadata: meta
      };
    });
  }

  // --- Reset Commands ---
  // clearHistory and clearAllHistory are defined above (L759/L766) with full cascade logic

  deleteMessagesSince(chatId, timestamp) {
    if (!chatId || !timestamp) return;
    const stmt = this.db.prepare('DELETE FROM messages WHERE chat_id = ? AND timestamp >= ?');
    const info = stmt.run(chatId, timestamp);
    console.log(`[DB] Rolled back ${info.changes} messages in chat ${chatId} since ${timestamp} `);
  }

  clearGoals(chatId) {
    if (chatId) {
      const stmt = this.db.prepare(`
         UPDATE goals SET status = 'failed' 
         WHERE status = 'pending' AND metadata LIKE ?
  `);
      stmt.run(`% ${chatId}% `);
      console.log(`[DB] Failed pending goals for chat ${chatId}`);
    } else {
      console.warn(`[DB] clearGoals called without chatId, no action taken.`);
    }
  }

  // --- Smart Home Entity Memory ---
  saveDeviceAlias(alias, entityId) {
    const stmt = this.db.prepare(`
      INSERT INTO entity_aliases(alias, entity_id) VALUES(?, ?)
      ON CONFLICT(alias) DO UPDATE SET entity_id = excluded.entity_id
  `);
    stmt.run(alias.toLowerCase(), entityId);
  }

  /**
   * Checkpoint WAL to main database file.
   * Call before backups or shutdown to ensure all data is persisted.
   */
  checkpoint() {
    if (!this.db) return;
    try {
      const result = this.db.pragma('wal_checkpoint(TRUNCATE)');
      console.log('[DB] WAL checkpoint completed:', result);
    } catch (err) {
      console.error('[DB] WAL checkpoint failed:', err.message);
    }
  }

  /**
   * Run a health check on the database.
   * Returns { ok, details } where details has integrity and connectivity info.
   */
  healthCheck() {
    if (!this.db || !this.db.open) {
      return { ok: false, details: { status: 'closed' } };
    }

    const details = { status: 'ok' };

    // 1. Connectivity: run a simple query
    try {
      this.db.prepare('SELECT 1').get();
      details.connectivity = 'ok';
    } catch (err) {
      details.connectivity = 'error';
      details.connectivityError = err.message;
      details.status = 'error';
      return { ok: false, details };
    }

    // 2. Quick integrity check (fast — checks page structure without scanning all data)
    try {
      const rows = this.db.pragma('quick_check');
      const isOk = rows.length === 1 && rows[0].quick_check === 'ok';
      details.integrity = isOk ? 'ok' : 'corrupt';
      if (!isOk) {
        details.integrityErrors = rows.slice(0, 10).map(r => r.quick_check);
        details.status = 'corrupt';
      }
    } catch (err) {
      details.integrity = 'error';
      details.integrityError = err.message;
      details.status = 'error';
    }

    // 3. WAL status
    try {
      const walInfo = this.db.pragma('wal_checkpoint');
      details.wal = {
        busy: walInfo[0]?.busy ?? null,
        log: walInfo[0]?.log ?? null,
        checkpointed: walInfo[0]?.checkpointed ?? null
      };
    } catch (err) {
      details.wal = { error: err.message };
    }

    return { ok: details.status === 'ok', details };
  }

  close() {
    if (this.db) {
      console.log('[DB] Closing database connection...');
      try {
        // Checkpoint WAL before closing to ensure all writes are in the main db file
        this.checkpoint();
        this.db.close();
        this.db = null;
      } catch (err) {
        console.error('[DB] Error closing database:', err);
      }
    }
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



  getLatencyTrend(limit = 100, start, end) {
    // Return raw data points: timestamp, value, type
    // Force 'Z' suffix to ensure ISO 8601 UTC interpretation.
    let sql = `
      SELECT strftime('%Y-%m-%dT%H:%M:%SZ', timestamp) as timestamp, value, type, metadata FROM metrics
      WHERE type IN ('latency_router', 'latency_model', 'latency_e2e')`;
    const params = [];
    if (start) { sql += ` AND timestamp >= ?`; params.push(start); }
    if (end) { sql += ` AND timestamp <= ?`; params.push(end); }
    sql += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params).reverse();
  }

  getTokenUsageTrend(limit = 100, start, end) {
    let sql = `SELECT strftime('%Y-%m-%dT%H:%M:%SZ', timestamp) as timestamp, estimated_cost, total_tokens, model FROM token_usage WHERE 1=1`;
    const params = [];
    if (start) { sql += ` AND timestamp >= ?`; params.push(start); }
    if (end) { sql += ` AND timestamp <= ?`; params.push(end); }
    sql += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params).reverse();
  }

  getDailyCostTrend(start, end, limit = 90) {
    let sql = `
      SELECT
        date(timestamp, 'localtime') as date,
        SUM(estimated_cost) as cost,
        SUM(total_tokens) as tokens
      FROM token_usage
      WHERE 1=1`;
    const params = [];
    if (start) { sql += ` AND timestamp >= ?`; params.push(start); }
    if (end) { sql += ` AND timestamp <= ?`; params.push(end); }
    sql += ` GROUP BY date(timestamp, 'localtime') ORDER BY date(timestamp, 'localtime') DESC LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params).reverse();
  }

  /**
   * Get cost breakdown grouped by service category.
   * @param {string} [start] - ISO start date
   * @param {string} [end] - ISO end date
   * @param {number} [days] - Fallback: number of days to look back if no start/end
   * @returns {{ categories: Object, total: { cost: number, tokens: number, calls: number } }}
   */
  getCostByTag(start, end, days = 1) {
    let sql = `
      SELECT
        ${EFFECTIVE_TAG_SQL} as effective_tag,
        SUM(estimated_cost) as cost,
        SUM(total_tokens) as tokens,
        COUNT(*) as calls
      FROM token_usage
      WHERE `;
    const params = [];
    if (start && end) {
      sql += `timestamp >= ? AND timestamp <= ?`;
      params.push(start, end);
    } else if (start) {
      sql += `timestamp >= ?`;
      params.push(start);
    } else if (end) {
      sql += `timestamp <= ?`;
      params.push(end);
    } else {
      sql += `timestamp >= datetime('now', '-' || ? || ' days', 'localtime')`;
      params.push(days);
    }
    sql += ` GROUP BY effective_tag`;
    const rows = this.db.prepare(sql).all(...params);

    // Roll up effective tags into categories
    const categories = {};
    let totalCost = 0, totalTokens = 0, totalCalls = 0;

    for (const row of rows) {
      const category = SERVICE_CATEGORIES[row.effective_tag] ?? 'Other';
      if (!categories[category]) {
        categories[category] = { cost: 0, tokens: 0, calls: 0 };
      }
      categories[category].cost += row.cost || 0;
      categories[category].tokens += row.tokens || 0;
      categories[category].calls += row.calls || 0;
      totalCost += row.cost || 0;
      totalTokens += row.tokens || 0;
      totalCalls += row.calls || 0;
    }

    return {
      categories,
      total: { cost: totalCost, tokens: totalTokens, calls: totalCalls }
    };
  }

  /**
   * Get daily cost trend broken down by service category for stacked bar chart.
   * @param {string} [start] - ISO start date
   * @param {string} [end] - ISO end date
   * @param {number} [limit] - Fallback: max days to return
   * @returns {Array<{ date: string, Chat: number, Dreams: number, ... }>}
   */
  getDailyCostByCategory(start, end, limit = 90) {
    let sql = `
      SELECT
        date(timestamp, 'localtime') as date,
        ${EFFECTIVE_TAG_SQL} as effective_tag,
        SUM(estimated_cost) as cost
      FROM token_usage
      WHERE 1=1`;
    const params = [];
    if (start) { sql += ` AND timestamp >= ?`; params.push(start); }
    if (end) { sql += ` AND timestamp <= ?`; params.push(end); }
    sql += ` GROUP BY date(timestamp, 'localtime'), effective_tag ORDER BY date(timestamp, 'localtime') DESC`;
    if (!start && !end) { sql += ` LIMIT ?`; params.push(limit * 25); }
    const rows = this.db.prepare(sql).all(...params);

    // Pivot: { date -> { category -> cost } }
    const dateMap = {};
    for (const row of rows) {
      const category = SERVICE_CATEGORIES[row.effective_tag] ?? 'Other';
      if (!dateMap[row.date]) dateMap[row.date] = { date: row.date };
      dateMap[row.date][category] = (dateMap[row.date][category] || 0) + (row.cost || 0);
    }

    // Sort by date desc, take limit, reverse to chronological
    return Object.values(dateMap)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit)
      .reverse();
  }

  /**
   * Get cost breakdown grouped by model.
   * @param {string} [start] - ISO start date
   * @param {string} [end] - ISO end date
   * @param {number} [days] - Fallback: number of days to look back
   */
  getCostByModel(start, end, days = 1) {
    let sql = `
      SELECT
        model,
        SUM(estimated_cost) as cost,
        SUM(prompt_tokens) as input_tokens,
        SUM(candidate_tokens) as output_tokens,
        SUM(total_tokens) as tokens,
        SUM(cached_tokens) as cached_tokens,
        SUM(thoughts_tokens) as thoughts_tokens,
        COUNT(*) as calls
      FROM token_usage
      WHERE `;
    const params = [];
    if (start && end) {
      sql += `timestamp >= ? AND timestamp <= ?`;
      params.push(start, end);
    } else if (start) {
      sql += `timestamp >= ?`;
      params.push(start);
    } else if (end) {
      sql += `timestamp <= ?`;
      params.push(end);
    } else {
      sql += `timestamp >= datetime('now', '-' || ? || ' days', 'localtime')`;
      params.push(days);
    }
    sql += ` GROUP BY model ORDER BY cost DESC`;
    return this.db.prepare(sql).all(...params);
  }

  // --- Revamped Analytics Methods ---

  /**
   * Hourly P50/P95 latency percentiles for e2e latency.
   * Uses ROW_NUMBER + COUNT window functions for accurate percentiles
   * even with small sample sizes.
   */
  getLatencyPercentiles(start, end) {
    let where = `m.type = 'latency_e2e'`;
    const params = [];
    if (start) { where += ` AND m.timestamp >= ?`; params.push(start); }
    if (end) { where += ` AND m.timestamp <= ?`; params.push(end); }
    if (!start && !end) { where += ` AND m.timestamp >= datetime('now', '-7 days')`; }

    const sql = `
      WITH ranked AS (
        SELECT
          strftime('%Y-%m-%dT%H:00:00Z', m.timestamp) AS bucket,
          m.value,
          ROW_NUMBER() OVER (
            PARTITION BY strftime('%Y-%m-%dT%H:00:00Z', m.timestamp)
            ORDER BY m.value
          ) AS rn,
          COUNT(*) OVER (
            PARTITION BY strftime('%Y-%m-%dT%H:00:00Z', m.timestamp)
          ) AS total
        FROM metrics m
        WHERE ${where}
      )
      SELECT
        bucket,
        MAX(CASE WHEN rn = MAX(1, CAST(ROUND(0.50 * total) AS INTEGER)) THEN value END) AS p50,
        MAX(CASE WHEN rn = MAX(1, CAST(ROUND(0.95 * total) AS INTEGER)) THEN value END) AS p95,
        total AS sample_count,
        ROUND(AVG(value), 1) AS avg_ms
      FROM ranked
      GROUP BY bucket
      ORDER BY bucket`;
    return this.db.prepare(sql).all(...params);
  }

  /**
   * Hourly token breakdown trend — stacked by token type.
   */
  getTokenBreakdownTrend(start, end) {
    let sql = `
      SELECT
        strftime('%Y-%m-%dT%H:00:00Z', timestamp) AS bucket,
        SUM(prompt_tokens) AS prompt_tokens,
        SUM(cached_tokens) AS cached_tokens,
        SUM(candidate_tokens) AS candidate_tokens,
        SUM(thoughts_tokens) AS thoughts_tokens,
        SUM(total_tokens) AS total_tokens,
        COUNT(*) AS calls
      FROM token_usage
      WHERE 1=1`;
    const params = [];
    if (start) { sql += ` AND timestamp >= ?`; params.push(start); }
    if (end) { sql += ` AND timestamp <= ?`; params.push(end); }
    if (!start && !end) { sql += ` AND timestamp >= datetime('now', '-7 days')`; }
    sql += ` GROUP BY strftime('%Y-%m-%dT%H:00:00Z', timestamp) ORDER BY bucket`;
    return this.db.prepare(sql).all(...params);
  }

  /**
   * Hourly cache hit rate trend (cached_tokens / prompt_tokens %).
   */
  getCacheHitRateTrend(start, end) {
    let sql = `
      SELECT
        strftime('%Y-%m-%dT%H:00:00Z', timestamp) AS bucket,
        CASE
          WHEN SUM(prompt_tokens) > 0
          THEN ROUND(CAST(SUM(cached_tokens) AS REAL) / SUM(prompt_tokens) * 100, 1)
          ELSE 0
        END AS cache_hit_pct,
        SUM(cached_tokens) AS cached_tokens,
        SUM(prompt_tokens) AS prompt_tokens
      FROM token_usage
      WHERE 1=1`;
    const params = [];
    if (start) { sql += ` AND timestamp >= ?`; params.push(start); }
    if (end) { sql += ` AND timestamp <= ?`; params.push(end); }
    if (!start && !end) { sql += ` AND timestamp >= datetime('now', '-7 days')`; }
    sql += ` GROUP BY strftime('%Y-%m-%dT%H:00:00Z', timestamp) ORDER BY bucket`;
    return this.db.prepare(sql).all(...params);
  }

  /**
   * Daily model usage distribution — call count per model per day.
   * Returns pivoted data: [{ date, 'model-a': N, 'model-b': M, ... }]
   */
  getModelUsageDistribution(start, end, limit = 90) {
    let sql = `
      SELECT
        date(timestamp, 'localtime') AS date,
        model,
        COUNT(*) AS calls
      FROM token_usage
      WHERE 1=1`;
    const params = [];
    if (start) { sql += ` AND timestamp >= ?`; params.push(start); }
    if (end) { sql += ` AND timestamp <= ?`; params.push(end); }
    sql += ` GROUP BY date(timestamp, 'localtime'), model ORDER BY date(timestamp, 'localtime') DESC`;
    if (!start && !end) { sql += ` LIMIT ?`; params.push(limit * 15); }
    const rows = this.db.prepare(sql).all(...params);

    // Pivot: { date -> { model -> calls } }
    const dateMap = {};
    for (const row of rows) {
      if (!dateMap[row.date]) dateMap[row.date] = { date: row.date };
      dateMap[row.date][row.model] = (dateMap[row.date][row.model] || 0) + row.calls;
    }

    return Object.values(dateMap)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit)
      .reverse();
  }

  getTokenUsageStats(start, end) {
    let sql = `
      SELECT
        SUM(prompt_tokens) as prompt,
        SUM(candidate_tokens) as candidate,
        SUM(total_tokens) as total,
        SUM(estimated_cost) as cost
      FROM token_usage
      WHERE `;
    const params = [];
    if (start && end) {
      sql += `timestamp >= ? AND timestamp <= ?`;
      params.push(start, end);
    } else if (start) {
      sql += `timestamp >= ?`;
      params.push(start);
    } else {
      sql += `date(timestamp, 'localtime') = date('now', 'localtime')`;
    }
    const row = this.db.prepare(sql).get(...params);

    return {
      today: {
        prompt: row?.prompt || 0,
        candidate: row?.candidate || 0,
        total: row?.total || 0,
        cost: row?.cost || 0
      }
    };
  }

  getLatencyStats(start, end) {
    let sql = `SELECT AVG(value) as avg_latency FROM metrics WHERE type = 'latency_e2e'`;
    const params = [];
    if (start && end) {
      sql += ` AND timestamp >= ? AND timestamp <= ?`;
      params.push(start, end);
    } else if (start) {
      sql += ` AND timestamp >= ?`;
      params.push(start);
    } else {
      sql += ` AND timestamp > datetime('now', '-24 hours')`;
    }
    const avgQuery = this.db.prepare(sql).get(...params);
    return {
      avg24h: Math.round(avgQuery?.avg_latency || 0)
    };
  }

  getStats() {
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(this.dbPath).size; } catch (e) { }

    const tables = ['messages', 'chat_sessions', 'goals', 'kv_store', 'people', 'scheduled_jobs', 'watchers', 'usage_logs', 'token_usage', 'summaries', 'metrics', 'job_logs'];
    const tableCounts = {};
    for (const t of tables) {
      try {
        tableCounts[t] = this.db.prepare(`SELECT COUNT(*) as count FROM ${t} `).get().count;
      } catch (e) { tableCounts[t] = 0; }
    }

    const totalMessages = tableCounts.messages;

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
      sizeBytes,
      counts: tableCounts,
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
      INSERT INTO job_logs(job_name, status, output, duration_ms)
      VALUES(?, ?, ?, ?)
    `).run(jobName, status, output ? String(output) : null, durationMs);
  }

  getJobLogs(limit = 50, offset = 0, { search = null, status = null } = {}) {
    const conditions = [];
    const params = [];

    if (search) {
      conditions.push('job_name LIKE ?');
      params.push(`%${search}%`);
    }
    if (status && status !== 'all') {
      conditions.push('status = ?');
      params.push(status);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

    const total = this.db.prepare(`SELECT COUNT(*) as count FROM job_logs${where}`).get(...params).count;

    const logs = this.db.prepare(`SELECT * FROM job_logs${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);

    return { logs, total };
  }

  deleteJobLogs(ids) {
    if (!ids || ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`DELETE FROM job_logs WHERE id IN(${placeholders})`);
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

  setAgentSetting(key, value, category = 'general') {
    const valStr = JSON.stringify(value);
    const stmt = this.db.prepare(`
      INSERT INTO agent_settings(key, value, category) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, category = excluded.category, updated_at = CURRENT_TIMESTAMP
  `);
    stmt.run(key, valStr, category);
  }

  getAllAgentSettings() {
    const stmt = this.db.prepare('SELECT key, value, category FROM agent_settings');
    const rows = stmt.all();
    const settings = {};
    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch (e) {
        settings[row.key] = row.value;
      }
    }
    return settings;
  }

  // --- Migration Utilities ---

  /**
   * Migrates a session from one ID to another.
   * Useful for fixing encoded IDs or merging sessions.
   * @param {string} oldId 
   * @param {string} newId 
   * @returns {object} Stats of migrated records
   */
  migrateSessionId(oldId, newId) {
    console.log(`[DB] Migrating session ${oldId} -> ${newId} `);

    // Check if new ID already exists (Collision check)
    const existing = this.getSession(newId);
    if (existing) {
      throw new Error(`Target session ID ${newId} already exists.Cannot migrate.`);
    }

    const stats = { messages: 0, summaries: 0, token_usage: 0, session: 0 };

    const transaction = this.db.transaction(() => {
      // 1. Chat Sessions
      const sessRes = this.db.prepare('UPDATE chat_sessions SET id = ? WHERE id = ?').run(newId, oldId);
      stats.session = sessRes.changes;

      if (stats.session === 0) {
        throw new Error(`Session ${oldId} not found.`);
      }

      // 2. Messages
      const msgRes = this.db.prepare('UPDATE messages SET chat_id = ? WHERE chat_id = ?').run(newId, oldId);
      stats.messages = msgRes.changes;

      // 3. Summaries
      const sumRes = this.db.prepare('UPDATE summaries SET chat_id = ? WHERE chat_id = ?').run(newId, oldId);
      stats.summaries = sumRes.changes;

      // 4. Token Usage
      const tokRes = this.db.prepare('UPDATE token_usage SET chat_id = ? WHERE chat_id = ?').run(newId, oldId);
      stats.token_usage = tokRes.changes;
    });

    transaction();
    console.log(`[DB] Migration complete: `, stats);
    return stats;
  }
  // --- Cost Attribution Queries ---

  /**
   * Get total cost for a specific chat_id (sub-agent or scheduled task).
   */
  getCostByChatId(chatId) {
    const row = this.db.prepare(`
      SELECT
        SUM(estimated_cost) as total_cost,
        SUM(total_tokens) as total_tokens,
        SUM(prompt_tokens) as prompt_tokens,
        SUM(candidate_tokens) as candidate_tokens,
        COUNT(*) as call_count
      FROM token_usage
      WHERE chat_id = ?
    `).get(chatId);
    return {
      totalCost: row?.total_cost || 0,
      totalTokens: row?.total_tokens || 0,
      promptTokens: row?.prompt_tokens || 0,
      candidateTokens: row?.candidate_tokens || 0,
      callCount: row?.call_count || 0
    };
  }

  /**
   * Get cost for a sub-agent (by its task ID).
   * Sub-agents use chat_id = 'subagent-{taskId}'
   */
  getSubAgentCost(taskId) {
    return this.getCostByChatId(`subagent-${taskId}`);
  }

  /**
   * Get cost for a job execution by matching chat_id and time window.
   * Job executions use chat_id like 'scheduled_{name}' or 'system_{name}'.
   * We match by job_name from job_logs and correlate with token_usage timestamps.
   */
  getJobRunCost(jobLogId) {
    const log = this.db.prepare('SELECT * FROM job_logs WHERE id = ?').get(jobLogId);
    if (!log) return { totalCost: 0, totalTokens: 0, callCount: 0 };

    // Match token_usage by chat_id and time window.
    // Scheduler generates chat_ids like 'scheduled_{name}_{epoch}' or 'system_{name}_{epoch}'.
    // We use GLOB with a digit-only suffix to prevent job 'foo' from matching 'foo_bar'.
    const scheduledGlob = `scheduled_${log.job_name}_[0-9]*`;
    const systemGlob = `system_${log.job_name}_[0-9]*`;
    const durationMs = log.duration_ms || 60000; // fallback 1 min
    const startTime = log.timestamp;
    // End time = start + duration + small buffer
    const endBufferSec = Math.ceil(durationMs / 1000) + 5;

    const row = this.db.prepare(`
      SELECT
        SUM(estimated_cost) as total_cost,
        SUM(total_tokens) as total_tokens,
        COUNT(*) as call_count
      FROM token_usage
      WHERE (chat_id GLOB ? OR chat_id GLOB ?)
        AND timestamp >= datetime(?, '-2 seconds')
        AND timestamp <= datetime(?, '+' || ? || ' seconds')
    `).get(scheduledGlob, systemGlob, startTime, startTime, endBufferSec);

    return {
      totalCost: row?.total_cost || 0,
      totalTokens: row?.total_tokens || 0,
      callCount: row?.call_count || 0
    };
  }

  /**
   * Batch get costs for multiple sub-agents at once.
   */
  getSubAgentCosts(taskIds) {
    if (!taskIds || taskIds.length === 0) return {};
    const chatIds = taskIds.map(id => `subagent-${id}`);
    const placeholders = chatIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT
        chat_id,
        SUM(estimated_cost) as total_cost,
        SUM(total_tokens) as total_tokens,
        COUNT(*) as call_count
      FROM token_usage
      WHERE chat_id IN (${placeholders})
      GROUP BY chat_id
    `).all(...chatIds);

    const result = {};
    for (const row of rows) {
      // Extract task ID from chat_id
      const taskId = row.chat_id.replace('subagent-', '');
      result[taskId] = {
        totalCost: row.total_cost || 0,
        totalTokens: row.total_tokens || 0,
        callCount: row.call_count || 0
      };
    }
    return result;
  }

  /**
   * Batch get costs for multiple job log entries.
   */
  getJobLogCosts(jobLogIds) {
    if (!jobLogIds || jobLogIds.length === 0) return {};

    const result = {};
    for (const id of jobLogIds) {
      result[id] = this.getJobRunCost(id);
    }
    return result;
  }

  // --- Sub-Agents ---

  createSubAgent({ id, parentChatId, task, model, createdAt }) {
    this.db.prepare(`
      INSERT INTO subagents (id, parent_chat_id, task, model, status, created_at)
      VALUES (?, ?, ?, ?, 'running', ?)
    `).run(id, parentChatId, task, model || 'FLASH', createdAt || new Date().toISOString());
  }

  updateSubAgent(id, { status, result, error, completedAt }) {
    const updates = ['completed_at = ?'];
    const args = [completedAt || new Date().toISOString()];

    if (status) { updates.push('status = ?'); args.push(status); }
    if (result !== undefined) { updates.push('result = ?'); args.push(typeof result === 'string' ? result : JSON.stringify(result)); }
    if (error !== undefined) { updates.push('error = ?'); args.push(error); }

    args.push(id);
    this.db.prepare(`UPDATE subagents SET ${updates.join(', ')} WHERE id = ?`).run(...args);
  }

  getSubAgent(id) {
    return this.db.prepare('SELECT * FROM subagents WHERE id = ?').get(id);
  }

  listSubAgents(parentChatId, { page = 1, limit = 50, search = null, status = null } = {}) {
    const offset = (page - 1) * limit;
    if (parentChatId) {
      const tasks = this.db.prepare('SELECT * FROM subagents WHERE parent_chat_id = ? ORDER BY created_at DESC').all(parentChatId);
      return { tasks, total: tasks.length, page: 1, limit: tasks.length };
    }

    const conditions = [];
    const params = [];

    if (search) {
      conditions.push('(task LIKE ? OR parent_chat_id LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (status && status !== 'all') {
      conditions.push('status = ?');
      params.push(status);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

    const total = this.db.prepare(`SELECT COUNT(*) as count FROM subagents${where}`).get(...params).count;
    const tasks = this.db.prepare(`SELECT * FROM subagents${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { tasks, total, page, limit };
  }

  markStaleSubAgents() {
    const result = this.db.prepare(`
      UPDATE subagents
      SET status = 'failed',
          error = 'Process terminated unexpectedly',
          completed_at = datetime('now')
      WHERE status = 'running'
    `).run();
    return result.changes;
  }

  cleanupSubAgents() {
    // Archive completed sub-agent sessions older than 24h
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(`
      SELECT id FROM subagents WHERE status != 'running' AND completed_at < ?
    `).all(cutoff);

    let cleaned = 0;
    for (const row of rows) {
      const chatId = `subagent-${row.id}`;
      try {
        this.deleteSession(chatId);
      } catch (e) { /* session may not exist */ }
      this.db.prepare('DELETE FROM subagents WHERE id = ?').run(row.id);
      cleaned++;
    }
    return { cleaned };
  }

  // --- Notifications ---

  getNotifications({ limit = 50, includeRead = false, includeDismissed = false } = {}) {
    const safeLimit = Math.min(Math.max(1, limit), 500);
    const conditions = [];
    if (!includeRead) conditions.push('is_read = 0');
    if (!includeDismissed) conditions.push('is_dismissed = 0');
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const rows = this.db.prepare(`
      SELECT * FROM notifications ${where}
      ORDER BY created_at DESC LIMIT ?
    `).all(safeLimit);

    return rows.map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      is_read: !!row.is_read,
      is_dismissed: !!row.is_dismissed,
    }));
  }

  getUnreadNotificationCount() {
    return this.db.prepare(
      'SELECT COUNT(*) as count FROM notifications WHERE is_read = 0 AND is_dismissed = 0'
    ).get().count;
  }

  markNotificationRead(id) {
    this.db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(id);
  }

  markAllNotificationsRead() {
    this.db.prepare('UPDATE notifications SET is_read = 1 WHERE is_read = 0').run();
  }

  dismissNotification(id) {
    this.db.prepare('UPDATE notifications SET is_dismissed = 1 WHERE id = ?').run(id);
  }

  dismissAllNotifications() {
    this.db.prepare('UPDATE notifications SET is_dismissed = 1 WHERE is_dismissed = 0').run();
  }

  deleteNotification(id) {
    this.db.prepare('DELETE FROM notifications WHERE id = ?').run(id);
  }

  createNotification({ id, type, severity, title, message, metadata, created_at }) {
    const metadataStr = metadata ? JSON.stringify(metadata) : null;
    const createdAt = created_at || new Date().toISOString();
    this.db.prepare(`
      INSERT INTO notifications (id, type, severity, title, message, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, type, severity, title, message, metadataStr, createdAt);
  }

  // --- Wardrobe: Garments ---

  addGarment(garment) {
    const id = garment.id || crypto.randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO wr_garments (
        id, type, subtype, primary_color, secondary_colors, pattern, material_guess,
        warmth, formality, season_tags, brand, model, size, fit_notes,
        source_image_path, crop_image_path, bbox, source,
        enrichment_status, enrichment_confidence, meta,
        times_worn, last_worn_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      garment.type || null,
      garment.subtype || null,
      garment.primary_color || null,
      garment.secondary_colors ? JSON.stringify(garment.secondary_colors) : null,
      garment.pattern || null,
      garment.material_guess || null,
      garment.warmth || null,
      garment.formality || null,
      garment.season_tags ? JSON.stringify(garment.season_tags) : null,
      garment.brand || null,
      garment.model || null,
      garment.size || null,
      garment.fit_notes || null,
      garment.source_image_path || null,
      garment.crop_image_path || null,
      garment.bbox ? JSON.stringify(garment.bbox) : null,
      garment.source || 'manual_upload',
      garment.enrichment_status || 'complete',
      garment.enrichment_confidence || 0,
      garment.meta ? JSON.stringify(garment.meta) : '{}',
      garment.times_worn || 0,
      garment.last_worn_at || null
    );
    return id;
  }

  getGarment(id) {
    const row = this.db.prepare('SELECT * FROM wr_garments WHERE id = ?').get(id);
    return row ? this._hydrateGarment(row) : null;
  }

  getGarments({ limit = 200, offset = 0, type = null } = {}) {
    let sql = 'SELECT * FROM wr_garments';
    const params = [];
    if (type) {
      sql += ' WHERE type = ?';
      params.push(type);
    }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return this.db.prepare(sql).all(...params).map(r => this._hydrateGarment(r));
  }

  updateGarment(id, fields) {
    const allowed = [
      'type', 'subtype', 'primary_color', 'secondary_colors', 'pattern', 'material_guess',
      'warmth', 'formality', 'season_tags', 'brand', 'model', 'size', 'fit_notes',
      'source_image_path', 'crop_image_path', 'bbox', 'source',
      'enrichment_status', 'enrichment_confidence', 'meta',
      'times_worn', 'last_worn_at'
    ];
    const jsonCols = new Set(['secondary_colors', 'season_tags', 'bbox', 'meta']);
    const sets = [];
    const values = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k} = ?`);
      values.push(jsonCols.has(k) && v !== null ? JSON.stringify(v) : v);
    }
    if (sets.length === 0) return false;
    values.push(id);
    const result = this.db.prepare(`UPDATE wr_garments SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return result.changes > 0;
  }

  deleteGarment(id) {
    const garment = this.getGarment(id);
    if (!garment) return false;
    const fs = require('fs');
    for (const p of [garment.source_image_path, garment.crop_image_path]) {
      if (p) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* ignore */ }
      }
    }
    this.db.prepare('DELETE FROM wr_garments WHERE id = ?').run(id);
    return true;
  }

  searchGarments(query) {
    if (!query) return [];
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];
    const conditions = tokens.map(() =>
      `(LOWER(type) LIKE ? OR LOWER(subtype) LIKE ? OR LOWER(primary_color) LIKE ? OR LOWER(pattern) LIKE ? OR LOWER(brand) LIKE ? OR LOWER(fit_notes) LIKE ?)`
    ).join(' AND ');
    const params = tokens.flatMap(t => {
      const w = `%${t}%`;
      return [w, w, w, w, w, w];
    });
    return this.db.prepare(`SELECT * FROM wr_garments WHERE ${conditions} ORDER BY created_at DESC`)
      .all(...params).map(r => this._hydrateGarment(r));
  }

  _hydrateGarment(row) {
    const safeParse = (s, fallback) => {
      if (!s) return fallback;
      try { return JSON.parse(s); } catch { return fallback; }
    };
    return {
      ...row,
      secondary_colors: safeParse(row.secondary_colors, []),
      season_tags: safeParse(row.season_tags, []),
      bbox: safeParse(row.bbox, null),
      meta: safeParse(row.meta, {})
    };
  }

  // --- Wardrobe: Outfits ---

  addOutfit(outfit) {
    const id = outfit.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO wr_outfits (id, name, occasion, weather_tags, garment_ids, rendered_image_path, liked, last_suggested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      outfit.name || null,
      outfit.occasion || null,
      outfit.weather_tags ? JSON.stringify(outfit.weather_tags) : null,
      outfit.garment_ids ? JSON.stringify(outfit.garment_ids) : '[]',
      outfit.rendered_image_path || null,
      outfit.liked ? 1 : 0,
      outfit.last_suggested_at || new Date().toISOString()
    );
    return id;
  }

  getOutfit(id) {
    const row = this.db.prepare('SELECT * FROM wr_outfits WHERE id = ?').get(id);
    return row ? this._hydrateOutfit(row) : null;
  }

  getOutfits({ liked = null, limit = 100, offset = 0 } = {}) {
    let sql = 'SELECT * FROM wr_outfits';
    const params = [];
    if (liked !== null) {
      sql += ' WHERE liked = ?';
      params.push(liked ? 1 : 0);
    }
    sql += ' ORDER BY last_suggested_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return this.db.prepare(sql).all(...params).map(r => this._hydrateOutfit(r));
  }

  updateOutfit(id, fields) {
    const allowed = ['name', 'occasion', 'weather_tags', 'garment_ids', 'rendered_image_path', 'liked', 'last_suggested_at'];
    const jsonCols = new Set(['weather_tags', 'garment_ids']);
    const sets = [];
    const values = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k} = ?`);
      if (k === 'liked') values.push(v ? 1 : 0);
      else if (jsonCols.has(k) && v !== null) values.push(JSON.stringify(v));
      else values.push(v);
    }
    if (sets.length === 0) return false;
    values.push(id);
    const result = this.db.prepare(`UPDATE wr_outfits SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return result.changes > 0;
  }

  deleteOutfit(id) {
    this.db.prepare('DELETE FROM wr_outfits WHERE id = ?').run(id);
    return true;
  }

  _hydrateOutfit(row) {
    const safeParse = (s, fb) => { if (!s) return fb; try { return JSON.parse(s); } catch { return fb; } };
    return {
      ...row,
      weather_tags: safeParse(row.weather_tags, []),
      garment_ids: safeParse(row.garment_ids, []),
      liked: !!row.liked
    };
  }

  // --- Wardrobe: Trips ---

  addTrip(trip) {
    const id = trip.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO wr_trips (id, calendar_event_id, destination, start_date, end_date,
        activities, weather_snapshot, planned_capsule, actual_capsule, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      trip.calendar_event_id || null,
      trip.destination || null,
      trip.start_date || null,
      trip.end_date || null,
      trip.activities ? JSON.stringify(trip.activities) : null,
      trip.weather_snapshot ? JSON.stringify(trip.weather_snapshot) : null,
      trip.planned_capsule ? JSON.stringify(trip.planned_capsule) : null,
      trip.actual_capsule ? JSON.stringify(trip.actual_capsule) : null,
      trip.status || 'planned'
    );
    return id;
  }

  getTrip(id) {
    const row = this.db.prepare('SELECT * FROM wr_trips WHERE id = ?').get(id);
    return row ? this._hydrateTrip(row) : null;
  }

  getTrips({ status = null, limit = 100 } = {}) {
    let sql = 'SELECT * FROM wr_trips';
    const params = [];
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY start_date DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(sql).all(...params).map(r => this._hydrateTrip(r));
  }

  updateTrip(id, fields) {
    const allowed = ['calendar_event_id', 'destination', 'start_date', 'end_date',
      'activities', 'weather_snapshot', 'planned_capsule', 'actual_capsule', 'status'];
    const jsonCols = new Set(['activities', 'weather_snapshot', 'planned_capsule', 'actual_capsule']);
    const sets = [];
    const values = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k} = ?`);
      values.push(jsonCols.has(k) && v !== null ? JSON.stringify(v) : v);
    }
    if (sets.length === 0) return false;
    values.push(id);
    const result = this.db.prepare(`UPDATE wr_trips SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return result.changes > 0;
  }

  setTripCapsule(id, garmentIds) {
    return this.updateTrip(id, { actual_capsule: garmentIds });
  }

  deleteTrip(id) {
    this.db.prepare('DELETE FROM wr_trips WHERE id = ?').run(id);
    return true;
  }

  _hydrateTrip(row) {
    const safeParse = (s, fb) => { if (!s) return fb; try { return JSON.parse(s); } catch { return fb; } };
    return {
      ...row,
      activities: safeParse(row.activities, []),
      weather_snapshot: safeParse(row.weather_snapshot, null),
      planned_capsule: safeParse(row.planned_capsule, []),
      actual_capsule: safeParse(row.actual_capsule, [])
    };
  }

  // --- Wardrobe: Shopping list ---

  addShoppingItem(item) {
    const id = item.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO wr_shopping_list (id, description, type, primary_color, pattern, material_hint,
        suggested_context, priority, status, resolved_garment_id, purchased_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      item.description,
      item.type || null,
      item.primary_color || null,
      item.pattern || null,
      item.material_hint || null,
      item.suggested_context ? JSON.stringify(item.suggested_context) : null,
      item.priority || 'medium',
      item.status || 'wanted',
      item.resolved_garment_id || null,
      item.purchased_at || null
    );
    return id;
  }

  getShoppingItem(id) {
    const row = this.db.prepare('SELECT * FROM wr_shopping_list WHERE id = ?').get(id);
    return row ? this._hydrateShoppingItem(row) : null;
  }

  listShoppingItems({ status = null, limit = 200 } = {}) {
    let sql = 'SELECT * FROM wr_shopping_list';
    const params = [];
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY added_at DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(sql).all(...params).map(r => this._hydrateShoppingItem(r));
  }

  updateShoppingItem(id, fields) {
    const allowed = ['description', 'type', 'primary_color', 'pattern', 'material_hint',
      'suggested_context', 'priority', 'status', 'resolved_garment_id', 'purchased_at'];
    const jsonCols = new Set(['suggested_context']);
    const sets = [];
    const values = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k} = ?`);
      values.push(jsonCols.has(k) && v !== null ? JSON.stringify(v) : v);
    }
    if (sets.length === 0) return false;
    values.push(id);
    const result = this.db.prepare(`UPDATE wr_shopping_list SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return result.changes > 0;
  }

  deleteShoppingItem(id) {
    this.db.prepare('DELETE FROM wr_shopping_list WHERE id = ?').run(id);
    return true;
  }

  _hydrateShoppingItem(row) {
    const safeParse = (s, fb) => { if (!s) return fb; try { return JSON.parse(s); } catch { return fb; } };
    return {
      ...row,
      suggested_context: safeParse(row.suggested_context, {})
    };
  }

  // --- Wardrobe: Bulk operations ---

  /**
   * Wipe every wardrobe table and reset the singleton profile to its defaults.
   * Returns per-table deletion counts so the caller can report what was removed.
   * Does NOT delete files on disk — the service layer handles that.
   */
  clearWardrobe() {
    const counts = {};
    const tables = ['wr_garments', 'wr_outfits', 'wr_trips', 'wr_shopping_list'];
    for (const t of tables) {
      try {
        const before = this.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get()?.c || 0;
        this.db.prepare(`DELETE FROM ${t}`).run();
        counts[t] = before;
      } catch (e) {
        console.warn(`[DB] clearWardrobe: ${t} delete failed:`, e.message);
        counts[t] = 0;
      }
    }
    // Reset the singleton profile but keep the row so seed logic isn't re-run.
    try {
      this.db.prepare(`
        UPDATE wr_user_profile
        SET reference_image_path = NULL,
            sizing = '{}',
            style_notes = '',
            preferred_brands = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run(JSON.stringify(['Lacoste', 'Lululemon']));
    } catch (e) {
      console.warn('[DB] clearWardrobe: profile reset failed:', e.message);
    }
    return counts;
  }

  // --- Wardrobe: User Profile ---

  getUserProfile() {
    const row = this.db.prepare('SELECT * FROM wr_user_profile WHERE id = 1').get();
    if (!row) return null;
    const safeParse = (s, fb) => { if (!s) return fb; try { return JSON.parse(s); } catch { return fb; } };
    return {
      ...row,
      preferred_brands: safeParse(row.preferred_brands, []),
      sizing: safeParse(row.sizing, {})
    };
  }

  updateUserProfile(fields) {
    const allowed = ['reference_image_path', 'preferred_brands', 'sizing', 'style_notes'];
    const jsonCols = new Set(['preferred_brands', 'sizing']);
    const sets = [];
    const values = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k} = ?`);
      values.push(jsonCols.has(k) && v !== null ? JSON.stringify(v) : v);
    }
    if (sets.length === 0) return false;
    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(1);
    const result = this.db.prepare(`UPDATE wr_user_profile SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return result.changes > 0;
  }
}

module.exports = { AgentDB, SERVICE_CATEGORIES };
