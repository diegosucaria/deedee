const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const messagesFts = require('./utils/messages-fts');

const INTEGRITY_WORKER = path.join(__dirname, 'utils', 'integrity-worker.js');

// How often the whole file is walked for damage (PRAGMA quick_check), in ms.
// Read on every call. HEALTH_INTEGRITY_MINUTES=0 turns the scan off.
function integrityScanEveryMs() {
  const raw = process.env.HEALTH_INTEGRITY_MINUTES;
  if (raw !== undefined && Number(raw) === 0) return 0;
  const minutes = Number(raw);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60 * 1000;
}
// A scan that failed to run (an I/O error, not a damaged file) is tried again soon.
const INTEGRITY_RETRY_MS = 60 * 1000;

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
  // Wardrobe
  wardrobe_detect: 'Wardrobe',
  wardrobe_attrs: 'Wardrobe',
  wardrobe_brand: 'Wardrobe',
  wardrobe_match: 'Wardrobe',
  wardrobe_recommend: 'Wardrobe',
  wardrobe_critique: 'Wardrobe',
  wardrobe_pack: 'Wardrobe',
  wardrobe_generate_garment: 'Wardrobe',
  wardrobe_visualize: 'Wardrobe',
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
  // Approval guardian (real decisions and owner dry runs)
  guardian: 'Guardian',
  guardian_dry_run: 'Guardian',
};

// Tags written on the main agent chat path (see services/usage-attribution.js).
// They say which class of turn a call belongs to, not which product surface it
// came from, so the cost breakdown classifies them by chat_id like untagged rows.
const MAIN_PATH_TAGS = ['chat', 'job', 'subagent', 'watcher']
  .flatMap(t => [t, `${t}_tool_loop`]);
const MAIN_PATH_TAGS_SQL = MAIN_PATH_TAGS.map(t => `'${t}'`).join(', ');

// SQL CASE expression that resolves an effective_tag from tag + chat_id.
// When tag names a call site (tts, dream, ...), use it directly. When tag IS
// NULL or is a main-path tag, classify by chat_id pattern: WhatsApp JIDs,
// scheduled jobs, sub-agents, etc.
const EFFECTIVE_TAG_SQL = `
  CASE
    WHEN tag IS NOT NULL AND tag NOT IN (${MAIN_PATH_TAGS_SQL}) THEN tag
    WHEN chat_id LIKE '%@s.us' OR chat_id LIKE '%@g.us' THEN 'whatsapp'
    WHEN chat_id LIKE 'scheduled\\_%' ESCAPE '\\' THEN 'scheduled_job'
    WHEN chat_id LIKE 'system\\_%' ESCAPE '\\' THEN 'system_job'
    WHEN chat_id LIKE 'subagent-%' THEN 'subagent'
    ELSE 'web_chat'
  END`;

/** The goal fields a tainted run wrote. A tainted row without the list counts as fully tainted. */
// --- facts index (docs/memory.md) ---
// Every turn used to carry every fact: 642 rows, about 13k tokens. The prompt
// now carries one line each, newest and most used first, inside a character
// budget; the full value comes back through getFact or searchMemory.
const FACT_SUMMARY_CHARS = 80;
// One budget for the whole block: about 6,000 tokens of a chat turn, against
// the 14,000 every fact in full used to cost. It buys two things at once. The
// facts the owner touched last carry their value on one line, and every other
// key is still named, so the model can read any fact by name instead of
// guessing that it exists. A tighter budget saves another 3,000 tokens and
// hides three quarters of his memory, which is not a trade worth making.
const FACT_INDEX_CHARS = 24000;
// Room kept back for the headings and the closing note.
const FACT_INDEX_RESERVE = 400;
const FACT_NOTES_SHARE = 0.25;

/** The block's character budget: FACTS_INDEX_CHARS, within reason. */
function factsIndexBudget() {
  const set = String(process.env.FACTS_INDEX_CHARS || '').trim();
  if (!set) return FACT_INDEX_CHARS;
  // "12k" or "8000 chars" used to parse as a number and quietly shrink his
  // memory to the floor, so only a plain number counts.
  if (!/^\d+$/.test(set)) {
    console.warn(`[Memory] FACTS_INDEX_CHARS is not a plain number ("${set}"), using ${FACT_INDEX_CHARS}.`);
    return FACT_INDEX_CHARS;
  }
  return Math.max(2000, Math.min(60000, Number(set)));
}
// Keys that hold state: a job's bookkeeping, a notification flag, a Node-RED
// dump. They stay in the table and out of the prompt. `system_` is NOT state:
// on the device those are ordinary facts about his setup (the apartment code,
// which tyres the car takes), so they belong in the notes.
const STATE_KEY_RE = /^(?:job:|notified_|config:|sys_|sch_|system_web_navigator_|ha_nodes|node_red)/i;
// Keys that are durable facts about the owner and the people around him.
const PROFILE_KEY_RE = /^(?:user_|relationship_|preference_|work_|family_|contact_|partner_|colleague_|project_|goal_|birthday)/i;
// Keys that are the agent's own notes about doing its job.
const NOTE_KEY_RE = /^(?:device_|agent_|skill_|lesson_|ha_|alias_)/i;
const PROFILE_CATEGORIES = new Set(['relationship', 'preference', 'work', 'temporal']);
// A fact written for one day stops being news after five.
const DATED_KEY_RE = /_on_(\d{4}-\d{2}-\d{2})$/;
const DATED_FACT_DAYS = 5;
// Grammar words a question carries, in both languages the owner uses. They
// match half the table as a substring ("is" hits "this", "list"), so they
// would drown the ranking of a question asked in full.
const FACT_STOP_WORDS = new Set([
  'what', 'whats', 'which', 'where', 'when', 'who', 'whom', 'whose', 'why', 'how',
  'the', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from',
  'is', 'are', 'was', 'were', 'be', 'do', 'does', 'did', 'has', 'have', 'had', 'can', 'will',
  'my', 'me', 'mine', 'his', 'her', 'hers', 'their', 'our', 'your', 'yours', 'it', 'its',
  'that', 'this', 'these', 'those', 'there', 'here', 'about', 'again', 'please', 'tell', 'know',
  'qué', 'que', 'cuál', 'cual', 'cuándo', 'cuando', 'dónde', 'donde', 'quién', 'quien',
  'cómo', 'como', 'por', 'para', 'del', 'las', 'los', 'una', 'uno', 'unos', 'unas',
  'mi', 'mis', 'su', 'sus', 'tu', 'tus', 'el', 'la', 'lo', 'de', 'en', 'un', 'al',
  'es', 'son', 'era', 'fue', 'ser', 'está', 'esta', 'este', 'esto', 'esos', 'esas',
  'tiene', 'tengo', 'sobre', 'dime', 'decime', 'sabes', 'sabés', 'con', 'sin', 'yo', 'vos'
]);

/**
 * profile, note or state, from the stored kind when it has one, else from the
 * key and the category. Read-time classification keeps the index working
 * before (and without) the migration.
 */
function factKind(key, category, stored = null) {
    const known = String(stored || '').toLowerCase();
    if (known === 'profile' || known === 'note' || known === 'state') return known;
    const k = String(key || '');
    if (STATE_KEY_RE.test(k)) return 'state';
    if (PROFILE_KEY_RE.test(k)) return 'profile';
    if (NOTE_KEY_RE.test(k)) return 'note';
    const c = String(category || '').toLowerCase();
    if (PROFILE_CATEGORIES.has(c)) return 'profile';
    if (c === 'system') return 'note';
    return 'profile';
}

/**
 * One line for the index: the stored summary, else the value, shortened.
 * Always one line. A summary is written by the model from chat logs that
 * carry other people's text, so a newline in it would otherwise print extra
 * "- key: value" lines into the prompt and forge facts.
 */
function factSummary(row) {
    const stored = typeof row.summary === 'string' ? row.summary.replace(/\s+/g, ' ').trim() : '';
    if (stored) return stored.length > FACT_SUMMARY_CHARS ? `${stored.slice(0, FACT_SUMMARY_CHARS - 1)}…` : stored;
    let text = row.value;
    try {
        const parsed = JSON.parse(row.value);
        text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    } catch { /* keep raw */ }
    text = String(text ?? '').replace(/\s+/g, ' ').trim();
    return text.length > FACT_SUMMARY_CHARS ? `${text.slice(0, FACT_SUMMARY_CHARS - 1)}…` : text;
}

/** A dated fact older than five days is history, not context. */
function factIsStale(key, now = Date.now()) {
    const m = DATED_KEY_RE.exec(String(key || ''));
    if (!m) return false;
    const when = new Date(`${m[1]}T00:00:00`).getTime();
    if (Number.isNaN(when)) return false;
    return (now - when) / 86400000 > DATED_FACT_DAYS;
}

function goalTaintedFields(meta) {
  if (!meta || meta.tainted !== true) return [];
  return Array.isArray(meta.taintedFields) ? meta.taintedFields.map(String) : ['description', 'progress'];
}

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

      -- Every turn reads a chat's newest rows (history and the trust check).
      -- Without this the reads scan the whole table and sort it: on the
      -- device, 41k rows and about 60 ms of blocked time per read.
      CREATE INDEX IF NOT EXISTS idx_messages_chat_time
        ON messages(chat_id, timestamp DESC);

      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Goals: multi-day/multi-session work the agent itself is executing.
      -- progress is a free-form checkpoint string the agent writes (e.g.
      -- "Processed 40/200 Slack msgs, cursor=1711234567") so it can resume
      -- after a restart. NOT for user TODOs — those belong in scheduleJob
      -- (reminders) or are surfaced live by proactive_thought (no persistence).
      CREATE TABLE IF NOT EXISTS goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        description TEXT NOT NULL,
        status TEXT DEFAULT 'pending', -- pending, completed, failed
        metadata TEXT, -- JSON string for context (chatId, etc)
        progress TEXT, -- latest checkpoint / resume state
        last_activity_at DATETIME,
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
        last_triggered_at DATETIME,
        taint_sources TEXT -- JSON array: set when a run that read untrusted content created it
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
        generated_image_path TEXT,
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
        variations_image_path TEXT,
        liked INTEGER DEFAULT 0,
        last_suggested_at TEXT,
        labels TEXT,
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
        reference_image_path TEXT,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        purchased_at TEXT
      );

      CREATE TABLE IF NOT EXISTS wr_user_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        reference_image_path TEXT,
        preferred_brands TEXT,
        sizing TEXT,
        style_notes TEXT,
        style_preferences TEXT,
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

      CREATE TABLE IF NOT EXISTS pending_questions (
        id TEXT PRIMARY KEY,
        chat_id TEXT,
        reply_chat_id TEXT NOT NULL,
        reply_source TEXT,
        source TEXT,
        question TEXT NOT NULL,
        options TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        answer TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT,
        answered_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pending_questions_reply
        ON pending_questions(reply_chat_id, status);

      CREATE TABLE IF NOT EXISTS notification_outbox (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        channel TEXT NOT NULL,
        target TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        origin TEXT,
        content_hash TEXT,
        expires_at TEXT,
        delivered_via TEXT,
        fallback_channel TEXT,
        fallback_target TEXT,
        fallback_status TEXT,
        fallback_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_due
        ON notification_outbox(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_outbox_dedupe
        ON notification_outbox(kind, target, content_hash, created_at);

      CREATE TABLE IF NOT EXISTS pending_confirmations (
        id TEXT PRIMARY KEY,
        origin_chat_id TEXT,
        origin_source TEXT,
        origin_meta TEXT,
        reply_chat_id TEXT NOT NULL,
        reply_channel TEXT,
        mode TEXT NOT NULL DEFAULT 'interactive',
        tool_name TEXT NOT NULL,
        args TEXT NOT NULL,
        summary TEXT,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_at TEXT,
        decided_via TEXT,
        result TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pending_confirmations_reply
        ON pending_confirmations(reply_chat_id, status);

      -- One row per gated tool call: what the approval guardian (or the
      -- owner, the deny-list, the breaker) decided. Kept 180 days, then
      -- folded into guardian_daily.
      CREATE TABLE IF NOT EXISTS guardian_decisions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        run_id TEXT,
        chat_id TEXT,
        source TEXT,
        source_kind TEXT,
        job_name TEXT,
        tool_name TEXT NOT NULL,
        target TEXT,
        taint_sources TEXT,
        mode TEXT,
        floor TEXT,
        always_ask TEXT,
        outcome TEXT NOT NULL,
        decided_by TEXT,
        verdict TEXT,
        model_verdict TEXT,
        reason TEXT,
        risk TEXT,
        latency_ms INTEGER,
        tokens INTEGER,
        cost REAL,
        guardian_input TEXT,
        approval_id TEXT,
        breaker_tripped INTEGER DEFAULT 0,
        feedback TEXT,
        feedback_note TEXT,
        feedback_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_guardian_decisions_created ON guardian_decisions(created_at);
      CREATE INDEX IF NOT EXISTS idx_guardian_decisions_approval ON guardian_decisions(approval_id);

      CREATE TABLE IF NOT EXISTS guardian_daily (
        day TEXT NOT NULL,
        outcome TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        risk TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        latency_sum INTEGER NOT NULL DEFAULT 0,
        latency_n INTEGER NOT NULL DEFAULT 0,
        feedback_allow INTEGER NOT NULL DEFAULT 0,
        feedback_deny INTEGER NOT NULL DEFAULT 0,
        breaker_trips INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, outcome, tool_name, source_kind, risk)
      );
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

    // Migration: a watcher created by a tainted run stores that taint.
    try {
      this.db.exec("ALTER TABLE watchers ADD COLUMN taint_sources TEXT");
    } catch (e) {
      // Ignore if column exists
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
    // Migration: Add goal progress / activity columns
    try {
      this.db.exec("ALTER TABLE goals ADD COLUMN progress TEXT");
    } catch (err) { }
    try {
      this.db.exec("ALTER TABLE goals ADD COLUMN last_activity_at DATETIME");
    } catch (err) { }
    // Migration: Add parts column if it doesn't exist
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN parts TEXT");
    } catch (err) { }

    // Migration: Add estimated_cost to token_usage
    try {
      this.db.exec("ALTER TABLE token_usage ADD COLUMN estimated_cost REAL");
    } catch (err) { }

    // Migration: full sub-agent result when the returned one was compressed
    try {
      this.db.exec("ALTER TABLE subagents ADD COLUMN result_full TEXT");
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

    // Migration: prompt composition estimates on token_usage (JSON length / 4
    // of the system instruction, the declarations and the history sent, plus
    // the declaration count). NULL on rows written before this migration and
    // on calls that do not go through the main chat path.
    for (const col of ['sys_tokens_est INTEGER', 'tools_tokens_est INTEGER', 'history_tokens_est INTEGER', 'decl_count INTEGER']) {
      try {
        this.db.exec(`ALTER TABLE token_usage ADD COLUMN ${col}`);
      } catch (err) { }
    }

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

    // Migration: facts index (docs/memory.md). `kind` splits durable facts
    // about the owner from the agent's own notes and from plain state;
    // `summary` is the one line the prompt shows; the two use columns say
    // which facts still earn their place.
    for (const sql of [
      "ALTER TABLE kv_store ADD COLUMN kind TEXT",
      "ALTER TABLE kv_store ADD COLUMN summary TEXT",
      "ALTER TABLE kv_store ADD COLUMN last_used_at DATETIME",
      "ALTER TABLE kv_store ADD COLUMN use_count INTEGER DEFAULT 0"
    ]) {
      try { this.db.exec(sql); } catch (err) { }
    }

    // Migration: Add enrichment_status to dj_vinyls
    try {
      this.db.exec("ALTER TABLE dj_vinyls ADD COLUMN enrichment_status TEXT DEFAULT 'complete'");
    } catch (err) { }

    // Migration: Add generated_image_path to wr_garments
    try {
      this.db.exec("ALTER TABLE wr_garments ADD COLUMN generated_image_path TEXT");
    } catch (err) { }

    // Migration: Add labels to wr_outfits (JSON array of user-defined tags)
    try {
      this.db.exec("ALTER TABLE wr_outfits ADD COLUMN labels TEXT");
    } catch (err) { }

    // Migration: Add reference_image_path to wr_shopping_list (AI-generated
    // reference photo of the wanted item)
    try {
      this.db.exec("ALTER TABLE wr_shopping_list ADD COLUMN reference_image_path TEXT");
    } catch (err) { }

    // Migration: Add variations_image_path to wr_outfits (multi-panel mirror
    // render showing the source outfit + variations side-by-side)
    try {
      this.db.exec("ALTER TABLE wr_outfits ADD COLUMN variations_image_path TEXT");
    } catch (err) { }

    // Migration: Add style_preferences to wr_user_profile (JSON with fit,
    // colors_loved, colors_avoided, formality_bias — feeds the proposer)
    try {
      this.db.exec("ALTER TABLE wr_user_profile ADD COLUMN style_preferences TEXT");
    } catch (err) { }

    this._settleOldApprovalNotifications();
    this._migrateMessageTimestampsToIso();
    this._setupMessagesFts();
  }

  /**
   * The full-text index over messages (utils/messages-fts.js). Triggers keep
   * it current from the first boot; rows that were there before are indexed
   * in small batches after boot, and until that ends `searchMessages` keeps
   * the old LIKE scan. `MESSAGES_FTS=0` drops the index and its triggers, so
   * a broken index can never stop a message from being saved; turning it back
   * on rebuilds it.
   */
  _setupMessagesFts() {
    this._messagesFtsReady = false;
    try {
      if (String(process.env.MESSAGES_FTS || '1') === '0') {
        messagesFts.dropMessagesFts(this.db);
        return;
      }
      // SQLite keeps a trigger's text as first created. When the indexing
      // rules change, or the index was emptied by hand, build it again.
      const setting = (key) => this.db.prepare('SELECT value FROM agent_settings WHERE key = ?').get(key)?.value;
      const fingerprint = JSON.stringify(messagesFts.schemaFingerprint());
      const indexed = !!setting(messagesFts.BACKFILL_FLAG);
      const stale = setting(messagesFts.SCHEMA_FLAG) !== fingerprint;
      const emptied = indexed && !stale && !!this.db.prepare(`
        SELECT 1 FROM messages WHERE NOT EXISTS (SELECT 1 FROM messages_fts_map) LIMIT 1`).get();
      if (stale || emptied) {
        if (indexed) console.log(`[DB] Rebuilding the message search index (${stale ? 'its rules changed' : 'it was empty'}).`);
        messagesFts.dropMessagesFts(this.db);
      }
      messagesFts.createMessagesFts(this.db);
      this.db.prepare(`
        INSERT INTO agent_settings(key, value, category) VALUES(?, ?, 'system')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(messagesFts.SCHEMA_FLAG, fingerprint);
      if (indexed && !stale && !emptied) {
        this._messagesFtsReady = true;
        return;
      }
      const scope = this.db.prepare('SELECT COUNT(*) AS n, MIN(rowid) AS lo, MAX(rowid) AS hi FROM messages').get();
      if (!scope.n) return this._finishMessagesFtsBackfill(0);
      console.log(`[DB] Indexing ${scope.n} stored messages for search, ${messagesFts.BACKFILL_BATCH} at a time...`);
      this._backfillMessagesFts(scope.lo, scope.hi, 0);
    } catch (err) {
      // No FTS5 in this build, or a damaged index: search stays on LIKE.
      console.warn('[DB] Message search index unavailable, using the plain scan:', err.message);
    }
  }

  _backfillMessagesFts(from, hi, added) {
    setImmediate(() => {
      if (!this.db || !this.db.open) return; // closed meanwhile; the next boot carries on
      try {
        const upTo = from + messagesFts.BACKFILL_BATCH - 1;
        const total = added + messagesFts.backfillRange(this.db, from, upTo);
        if (upTo >= hi) return this._finishMessagesFtsBackfill(total);
        this._backfillMessagesFts(upTo + 1, hi, total);
      } catch (err) {
        console.warn('[DB] Message search indexing stopped, using the plain scan:', err.message);
      }
    });
  }

  _finishMessagesFtsBackfill(added) {
    this.db.prepare(`
      INSERT INTO agent_settings(key, value, category) VALUES(?, ?, 'system')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(messagesFts.BACKFILL_FLAG, JSON.stringify(new Date().toISOString()));
    this._messagesFtsReady = true;
    if (added > 0) console.log(`[DB] Indexed ${added} stored messages for search.`);
  }

  /**
   * Nothing ever marked an approval's notification read, so a card he
   * answered hours ago still sat unread in the bell. Every notification for
   * an approval that is no longer pending (decided, expired, or cleaned up
   * with the old rows) is marked read once at boot. The row stays: the list
   * is still the history of what was asked.
   */
  _settleOldApprovalNotifications() {
    try {
      const approvals = this.db.prepare(`
        UPDATE notifications SET is_read = 1
        WHERE type = 'approval' AND is_read = 0
          AND NOT EXISTS (
            SELECT 1 FROM pending_confirmations c
            WHERE c.id = json_extract(notifications.metadata, '$.approvalId')
              AND c.status = 'pending'
          )
      `).run().changes;
      // No wait survives a restart, so every question in the bell has been
      // settled by the time this runs.
      const questions = this.db.prepare(`
        UPDATE notifications SET is_read = 1
        WHERE type = 'ask_user' AND is_read = 0
          AND NOT EXISTS (
            SELECT 1 FROM pending_questions q
            WHERE q.id = json_extract(notifications.metadata, '$.questionId')
              AND q.status = 'pending'
          )
      `).run().changes;
      if (approvals + questions > 0) {
        console.log(`[DB] Marked ${approvals} decided approval and ${questions} answered question notification(s) read.`);
      }
    } catch (err) {
      console.warn('[DB] Could not settle old approval notifications:', err.message);
    }
  }

  // One-time data migration: older rows stored epoch ms in messages.timestamp.
  // Mixed integer/text values break ORDER BY, so rewrite them as ISO text.
  // The flag lives in agent_settings (kv_store rows are memory facts that
  // reach the model prompt).
  _migrateMessageTimestampsToIso(batchSize = 5000) {
    const FLAG = 'migration_messages_ts_iso';
    try {
      const done = this.db.prepare('SELECT value FROM agent_settings WHERE key = ?').get(FLAG);
      if (done) return;

      // Count first so the log shows the size of the job, then update in
      // rowid ranges. One UPDATE over a large table held the write lock
      // for too long on the Pi.
      const scope = this.db.prepare(`
        SELECT COUNT(*) AS n, MIN(rowid) AS lo, MAX(rowid) AS hi FROM messages
        WHERE typeof(timestamp) IN ('integer', 'real')
      `).get();
      let changed = 0;
      if (scope.n > 0) {
        console.log(`[DB] Converting ${scope.n} message timestamps to ISO text (rowid ${scope.lo}-${scope.hi}, batches of ${batchSize})...`);
        const update = this.db.prepare(`
          UPDATE messages
          SET timestamp = strftime('%Y-%m-%dT%H:%M:%fZ', timestamp / 1000.0, 'unixepoch')
          WHERE rowid BETWEEN ? AND ? AND typeof(timestamp) IN ('integer', 'real')
        `);
        for (let from = scope.lo; from <= scope.hi; from += batchSize) {
          changed += update.run(from, from + batchSize - 1).changes;
        }
      }
      this.db.prepare(`
        INSERT INTO agent_settings(key, value, category) VALUES(?, ?, 'system')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(FLAG, JSON.stringify(new Date().toISOString()));
      if (changed > 0) {
        console.log(`[DB] Converted ${changed} message timestamps to ISO text.`);
        try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* not in WAL mode */ }
      }
    } catch (err) {
      console.error('[DB] Timestamp migration failed:', err.message);
    }
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
  /**
   * Keep a copy of a fact before it goes, in the same file the nightly pruning
   * writes, so a deletion is never final without a trace.
   */
  /**
   * Keep a copy of a fact before it is changed or deleted.
   * @returns {boolean} whether the copy was really written. The tools promise
   * the owner a copy, so a failure has to be reported rather than assumed.
   */
  backupFact(row, reason = 'forgetFact') {
    if (!row) return false;
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = this.dbPath ? path.dirname(this.dbPath) : path.join(process.cwd(), 'data');
      const file = path.join(dir, 'pruned_memories.json');
      let current = [];
      let damaged = false;
      try {
        if (fs.existsSync(file)) current = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch { damaged = true; current = []; }
      if (!Array.isArray(current)) { damaged = fs.existsSync(file); current = []; }
      // The file is the only copy of every fact ever dropped. Overwriting one
      // we cannot read would throw all of them away, so it is moved aside.
      if (damaged) {
        const aside = path.join(dir, `pruned_memories.corrupt-${Date.now()}.json`);
        try {
          fs.renameSync(file, aside);
          console.warn(`[DB] pruned_memories.json could not be read; kept as ${path.basename(aside)}.`);
        } catch (e) {
          // It could not be read and could not be moved. Writing over it now
          // would destroy every fact ever pruned, so this one is written
          // beside it instead and the damaged file is left alone.
          console.warn('[DB] pruned_memories.json is damaged and could not be moved aside:', e.message);
          const spare = path.join(dir, `pruned_memories.${Date.now()}.json`);
          try {
            fs.writeFileSync(spare, JSON.stringify([{ ...row, pruned_at: new Date().toISOString(), reason }], null, 2));
            return true;
          } catch (err) {
            console.warn('[DB] Could not keep a copy of the fact:', err.message);
            return false;
          }
        }
      }
      current.push({ ...row, pruned_at: new Date().toISOString(), reason });
      fs.writeFileSync(file, JSON.stringify(current, null, 2));
      return true;
    } catch (e) {
      console.warn('[DB] Could not back up a fact before deleting it:', e.message);
      return false;
    }
  }

  /** @returns {boolean} whether a row was there to delete */
  deleteFact(key) {
    return this.db.prepare('DELETE FROM kv_store WHERE key = ?').run(key).changes > 0;
  }

  deleteGoal(id) {
    this.db.prepare('DELETE FROM goals WHERE id = ?').run(id);
  }

  /**
   * The owner's edit of a goal (dashboard, API). A new description is his own
   * text, so the taint a run left on the old one goes; `clearTaint` drops all
   * of it (he read the goal and trusts it).
   */
  updateGoal(id, { status, description, clearTaint = false } = {}) {
    const updates = [];
    const args = [];
    if (status) { updates.push('status = ?'); args.push(status); }
    if (description) { updates.push('description = ?'); args.push(description); }

    if (updates.length > 0) {
      args.push(id);
      const sql = `UPDATE goals SET ${updates.join(', ')} WHERE id = ?`;
      this.db.prepare(sql).run(...args);
    }
    if (clearTaint) this.clearGoalTaint(id);
    else if (description) this.clearGoalTaint(id, 'description');
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

  // Accepts a person id, a phone number, or a WhatsApp address:
  // "<phone>@s.whatsapp.net" or a WhatsApp ID ("<lid>@lid"). Phones match the
  // phone column or identifiers.whatsapp; WhatsApp IDs match
  // identifiers.whatsapp_lid, which PeopleService.linkWhatsAppIdentities fills in.
  getPerson(idOrAddress) {
    const key = String(idOrAddress ?? '');
    let row = this.db.prepare('SELECT * FROM people WHERE id = ? OR phone = ?').get(key, key);

    if (!row) {
      const digits = key.replace(/@.*$/, '').replace(/\D/g, '');
      if (digits.length >= 5) {
        try {
          row = /@lid$/i.test(key)
            ? this.db.prepare("SELECT * FROM people WHERE json_extract(identifiers, '$.whatsapp_lid') = ?").get(digits)
            : this.db.prepare(`SELECT * FROM people WHERE phone = ?
                OR json_extract(identifiers, '$.whatsapp') = ?
                OR json_extract(identifiers, '$.whatsapp_lid') = ?`).get(digits, digits, digits);
        } catch (e) {
          // A row with malformed identifiers JSON makes json_extract throw; fall back to phone only.
          row = this.db.prepare('SELECT * FROM people WHERE phone = ?').get(digits);
        }
      }
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
    // WhatsApp group IDs are 18+ digit numbers (e.g. 100000000000000001)
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
      conditions.push(`(name LIKE ? OR relationship LIKE ? OR notes LIKE ? OR phone LIKE ? OR identifiers LIKE ? OR ? LIKE ('%' || name || '%'))`);
      args.push(wildcard, wildcard, wildcard, wildcard, wildcard, query);
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
      OR identifiers LIKE ?
      OR ? LIKE ('%' || name || '%')
    `);
    // Pass wildcard 5 times, then raw query once for the reverse match
    return stmt.all(wildcard, wildcard, wildcard, wildcard, wildcard, query).map(row => ({
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
    // Normalize timestamp to ISO string. Mixing integer (ms) and ISO text in the
    // same column makes ORDER BY timestamp return text rows before integer rows
    // (SQLite NUMERIC affinity), so history fetches silently dropped integer rows.
    let ts;
    if (msg.timestamp == null) {
      ts = new Date().toISOString();
    } else if (typeof msg.timestamp === 'number') {
      ts = new Date(msg.timestamp).toISOString();
    } else {
      ts = msg.timestamp;
    }
    stmt.run(id, msg.role, msg.content, partsStr, msg.source, targetChatId, msg.cost || 0, msg.tokenCount || 0, ts, metaStr);
  }

  // Insert variant for the proactive-mirror wrapper. Idempotent on id so callers
  // that send a payload already saved by the main reply loop (same id) don't
  // create a duplicate row; payloads with no/new id are saved fresh.
  saveMessageIfNew(msg) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (id, role, content, parts, source, chat_id, cost, token_count, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const id = msg.id || crypto.randomUUID();
    const partsStr = msg.parts ? JSON.stringify(msg.parts) : null;
    const metaStr = msg.metadata ? JSON.stringify(msg.metadata) : null;
    const targetChatId = msg.chatId || msg.chat_id || msg.metadata?.chatId;
    let ts;
    if (msg.timestamp == null) {
      ts = new Date().toISOString();
    } else if (typeof msg.timestamp === 'number') {
      ts = new Date(msg.timestamp).toISOString();
    } else {
      ts = msg.timestamp;
    }
    const result = stmt.run(id, msg.role, msg.content, partsStr, msg.source, targetChatId, msg.cost || 0, msg.tokenCount || 0, ts, metaStr);
    return { inserted: result.changes > 0, id };
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
    const { category, confidence, source, kind, summary } = options;
    const stmt = this.db.prepare(`
      INSERT INTO kv_store (key, value, category, confidence, source, kind, summary)
      VALUES (?, ?, COALESCE(?, 'general'), COALESCE(?, 'inferred'), COALESCE(?, 'system'), ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP,
        category = COALESCE(excluded.category, kv_store.category),
        confidence = COALESCE(excluded.confidence, kv_store.confidence),
        source = COALESCE(excluded.source, kv_store.source),
        -- The kind describes the key, not the value, so it survives a new
        -- value. Losing it would move the fact to another section and, worse,
        -- drop the guard that makes forgetFact ask before deleting a fact
        -- about the owner.
        kind = COALESCE(excluded.kind, kv_store.kind),
        -- A summary written for the old value must not survive a new one: the
        -- prompt shows the summary, so it would state the old fact.
        summary = CASE WHEN excluded.summary IS NOT NULL THEN excluded.summary
                       WHEN excluded.value <> kv_store.value THEN NULL
                       ELSE kv_store.summary END
    `);
    stmt.run(key, valStr, category || null, confidence || null, source || null,
      kind ? String(kind) : null, summary ? String(summary).slice(0, FACT_SUMMARY_CHARS) : null);
  }

  /**
   * Facts the owner asked for by name, or that a search returned, have earned
   * their place in the index. Never throws: this is bookkeeping.
   */
  touchFacts(keys) {
    const list = (Array.isArray(keys) ? keys : [keys]).map(k => String(k || '')).filter(Boolean).slice(0, 20);
    if (list.length === 0) return;
    try {
      const stmt = this.db.prepare('UPDATE kv_store SET use_count = COALESCE(use_count, 0) + 1, last_used_at = CURRENT_TIMESTAMP WHERE key = ?');
      for (const key of list) stmt.run(key);
    } catch (e) {
      console.warn('[DB] Could not record fact use:', e.message);
    }
  }

  /**
   * Facts whose key, summary or value holds `term`, for a tool that has to
   * find the fact the owner means. Exact key first.
   * @returns {Array<{ key: string, value: any, kind: string, summary: string|null, pinned: number }>}
   */
  findFacts(term, limit = 5, { keysOnly = false, includeState = false } = {}) {
    const q = String(term || '').trim().toLowerCase();
    if (!q) return [];
    // % and _ are wildcards in LIKE, so a term holding them must not widen the
    // search.
    const esc = (t) => t.replace(/[\\%_]/g, (c) => `\\${c}`);
    // People ask questions, not keywords: "what is his birthday?" used to keep
    // the question mark inside the last word and match nothing. Punctuation
    // goes, and the words that carry no meaning go with it.
    const cleaned = q.replace(/[^\p{L}\p{N}\s_]+/gu, ' ');
    const all = cleaned.split(/[\s_]+/).filter((w) => w.length >= 2);
    let words = all.filter((w) => !FACT_STOP_WORDS.has(w)).slice(0, 6);
    if (words.length === 0) words = all.slice(0, 6);
    if (words.length === 0) return [];
    const target = keysOnly
      ? 'LOWER(key)'
      : "LOWER(key) || ' ' || LOWER(COALESCE(summary, '')) || ' ' || LOWER(COALESCE(value, ''))";
    const lim = Math.max(1, Math.min(20, Number(limit) || 5));
    // He asks in the plural, the key is written in the singular: "car tyres"
    // used to miss user_car_tyre_size entirely. Only a plain trailing "s" on a
    // word of four letters or more goes, so "gas" and "address" stay whole.
    // The stem is a prefix of the word, so this only ever widens the search.
    const stem = (w) => (w.length >= 4 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
    const pats = words.map((w) => `%${esc(stem(w))}%`);
    const decorate = (rows) => rows
      .map((row) => {
        const { hit_count, ...rest } = row;
        let value = rest.value;
        try { value = JSON.parse(rest.value); } catch { /* keep raw */ }
        return { ...rest, value, kind: factKind(rest.key, rest.category, rest.kind) };
      })
      // A job's bookkeeping and the Node-RED and Home Assistant dumps are kept
      // out of the prompt on purpose. Handing them back through a search puts
      // tens of thousands of characters into the turn instead, and a long dump
      // holds more of the words than a real fact, so it wins the ranking too.
      .filter((row) => includeState || row.kind !== 'state');

    // Every word has to appear, so a two-word query finds the fact that holds
    // both rather than everything that holds either.
    const where = words.map(() => `${target} LIKE ? ESCAPE '\\'`).join(' AND ');
    const rows = this.db.prepare(`
      SELECT * FROM kv_store
      WHERE LOWER(key) = ? OR (${where})
      ORDER BY (LOWER(key) = ?) DESC, (LOWER(key) LIKE ? ESCAPE '\\') DESC, pinned DESC, updated_at DESC
      LIMIT ?
    `).all(q, ...pats, q, `%${esc(q)}%`, lim);
    if (rows.length > 0 || words.length < 2 || keysOnly) return decorate(rows);

    // Nothing held every word. Rather than answer "I do not know" when the
    // fact is there under other wording, take the rows that hold any word,
    // best match first. Not for keysOnly: updateFact and forgetFact write, so
    // they must never act on a loose match.
    const score = words.map(() => `(CASE WHEN ${target} LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`).join(' + ');
    const anyWhere = words.map(() => `${target} LIKE ? ESCAPE '\\'`).join(' OR ');
    const loose = this.db.prepare(`
      SELECT *, (${score}) AS hit_count FROM kv_store
      WHERE ${anyWhere}
      ORDER BY hit_count DESC, (LOWER(key) LIKE ? ESCAPE '\\') DESC, pinned DESC, updated_at DESC
      LIMIT ?
    `).all(...pats, ...pats, `%${esc(q)}%`, lim);
    return decorate(loose);
  }

  getKey(key) {
    const stmt = this.db.prepare('SELECT value FROM kv_store WHERE key = ?');
    const row = stmt.get(key);
    return row ? JSON.parse(row.value) : null;
  }

  getFact(key) {
    const row = this.db.prepare('SELECT * FROM kv_store WHERE key = ?').get(key);
    if (!row) return null;
    // The kind a caller reads is the stored one, or the one the key implies.
    const kind = factKind(row.key, row.category, row.kind);
    try { return { ...row, kind, value: JSON.parse(row.value) }; }
    catch (e) { return { ...row, kind }; }
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

  /**
   * The facts block the prompt carries: one line per fact, the owner's profile
   * first, then the agent's own notes, each inside a character budget. Stable
   * between turns (no query in the ordering), so the cached prefix survives.
   * State keys, stale dated facts and Node-RED dumps stay out; getFact and
   * searchMemory still reach them.
   * @returns {{ text: string, shown: number, total: number, hidden: number, chars: number }}
   */
  getFactsIndex({ indexChars = factsIndexBudget(), now = Date.now() } = {}) {
    let rows = [];
    try {
      rows = this.db.prepare('SELECT key, value, category, kind, summary, pinned, last_used_at, updated_at FROM kv_store').all();
    } catch (e) {
      // The caller falls back to the full list rather than tell the model
      // there is nothing stored.
      console.warn('[Memory] Facts index read failed:', e.message);
      return null;
    }
    const total = rows.length;
    const usable = [];
    let stateRows = 0;
    for (const row of rows) {
      const kind = factKind(row.key, row.category, row.kind);
      if (kind === 'state' || factIsStale(row.key, now)) { stateRows++; continue; }
      // The key is printed into the prompt too, so it is flattened for the
      // same reason as the summary: one fact, one line, always.
      usable.push({
        key: String(row.key).replace(/\s+/g, ' ').trim(),
        kind,
        pinned: row.pinned ? 1 : 0,
        line: factSummary(row),
        updated: row.updated_at || ''
      });
    }
    // Stable order: pinned first, the owner's facts before the agent's notes,
    // newest first, then the key. Nothing here depends on what was read
    // lately, so the block moves only when the facts do and the cached prefix
    // survives.
    usable.sort((a, b) => (b.pinned - a.pinned)
      || (a.kind === b.kind ? 0 : a.kind === 'profile' ? -1 : 1)
      || String(b.updated).localeCompare(String(a.updated))
      || a.key.localeCompare(b.key));

    const render = (f) => `- ${f.key}: ${f.line}`;
    const lineCost = (f) => render(f).length + 1;
    const nameCost = (f) => f.key.length + 2;
    // The headings and the closing note are printed too. Reserving them keeps
    // the block inside the budget the caller asked for, which matters because
    // the voice prompt sizes the rest of its instruction around it.
    const content = Math.max(0, indexChars - FACT_INDEX_RESERVE);
    const profileRows = usable.filter(f => f.kind === 'profile');
    const noteRows = usable.filter(f => f.kind === 'note');

    // Naming every key costs this much. If it fits, no fact is ever invisible
    // to the model: it can read any of them by name with getFact.
    const wholeTail = usable.reduce((n, f) => n + nameCost(f), 0);
    const withTail = wholeTail > 0 && wholeTail <= content;

    let profileLines = [];
    let noteLines = [];
    let hidden = 0;
    let named = [];

    if (withTail) {
      // Every key is named already. A value line only has to buy the value,
      // so promoting a fact costs its line minus the name it drops.
      const promote = (list, room) => {
        const taken = [];
        let used = 0;
        for (const f of list) {
          const extra = lineCost(f) - nameCost(f);
          if (used + extra > room) continue;
          taken.push(f);
          used += extra;
        }
        return { taken, used };
      };
      const room = content - wholeTail;
      // The notes take at most a quarter of the room, and only what they need;
      // the profile takes the rest, and lends back what it leaves.
      const notesWanted = noteRows.reduce((n, f) => n + lineCost(f) - nameCost(f), 0);
      const notesRoom = Math.min(Math.round(room * FACT_NOTES_SHARE), notesWanted);
      const profile = promote(profileRows, room - notesRoom);
      const notes = promote(noteRows, room - profile.used);
      const promoted = new Set([...profile.taken, ...notes.taken]);
      profileLines = profile.taken.map(render);
      noteLines = notes.taken.map(render);
      named = usable.filter(f => !promoted.has(f)).map(f => f.key);
    } else {
      // Too little room to name them all, so fall back to as many value lines
      // as fit and a count of the rest.
      const fit = (list, budget) => {
        const lines = [];
        let used = 0;
        let left = 0;
        for (const f of list) {
          if (used + lineCost(f) > budget) { left++; continue; }
          lines.push(render(f));
          used += lineCost(f);
        }
        return { lines, left, used };
      };
      const notesWanted = noteRows.reduce((n, f) => n + lineCost(f), 0);
      const notesBudget = Math.min(Math.round(content * FACT_NOTES_SHARE), notesWanted);
      const profile = fit(profileRows, content - notesBudget);
      const notes = fit(noteRows, content - profile.used);
      profileLines = profile.lines;
      noteLines = notes.lines;
      hidden = profile.left + notes.left;
    }

    const parts = [];
    if (profileLines.length > 0) parts.push(`USER PROFILE (durable facts about the owner):\n${profileLines.join('\n')}`);
    if (noteLines.length > 0) parts.push(`AGENT NOTES (what you learned about doing the job):\n${noteLines.join('\n')}`);
    if (named.length > 0) {
      parts.push(`ALSO STORED, names only (${named.length}). Their values are kept in full; getFact(key) reads one:\n${named.join(', ')}`);
    }
    if (parts.length > 0 && hidden > 0) {
      parts.push(`(${hidden} more facts are stored and not listed. getFact(key) reads any fact by name; searchMemory(query) finds one by words. Use them before saying you do not know.)`);
    }
    const text = parts.join('\n');
    return {
      text,
      shown: profileLines.length + noteLines.length,
      named: named.length,
      total,
      hidden,
      state: stateRows,
      chars: text.length
    };
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

  // --- Goals (agent's multi-session work) ---
  addGoal(description, metadata = {}, progress = null) {
    const metaStr = JSON.stringify(metadata);
    const stmt = this.db.prepare(
      "INSERT INTO goals (description, metadata, progress, last_activity_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)"
    );
    return stmt.run(description, metaStr, progress);
  }

  getPendingGoals() {
    // Fall back to created_at for rows predating the last_activity_at column
    // so old goals don't all bunch at the bottom with NULL activity.
    const stmt = this.db.prepare("SELECT * FROM goals WHERE status = 'pending' ORDER BY COALESCE(last_activity_at, created_at) DESC, id DESC");
    const rows = stmt.all();
    return rows.map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : {}
    }));
  }

  /**
   * Mark a goal as written by a run that read untrusted content. Merges
   * { tainted, taintSources } into its metadata; later runs that load the
   * goal into their prompt start tainted.
   */
  /**
   * Mark a goal's text as written by a tainted run. `field` is the text that
   * run wrote: 'progress' (updateGoalProgress) or 'description'. The taint
   * lasts while some tainted text is still there (see clearGoalTaint).
   */
  markGoalTainted(id, { taintSources = [] } = {}, field = 'progress') {
    const row = this.db.prepare('SELECT metadata FROM goals WHERE id = ?').get(id);
    if (!row) return { changes: 0 };
    let meta = {};
    try { meta = row.metadata ? JSON.parse(row.metadata) : {}; } catch { meta = {}; }
    const sources = [...new Set([...(Array.isArray(meta.taintSources) ? meta.taintSources : []), ...taintSources])].slice(0, 10);
    const fields = [...new Set([...goalTaintedFields(meta), field])];
    meta = { ...meta, tainted: true, taintSources: sources, taintedFields: fields };
    return this.db.prepare('UPDATE goals SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), id);
  }

  /**
   * Drop the taint from one field of a goal (its text was replaced by clean
   * text), or from all of them. The goal stops carrying taint once no
   * tainted field is left.
   */
  clearGoalTaint(id, field = null) {
    const row = this.db.prepare('SELECT metadata FROM goals WHERE id = ?').get(id);
    if (!row) return { changes: 0 };
    let meta = {};
    try { meta = row.metadata ? JSON.parse(row.metadata) : {}; } catch { meta = {}; }
    if (meta.tainted !== true) return { changes: 0 };
    const fields = field ? goalTaintedFields(meta).filter(f => f !== field) : [];
    if (fields.length > 0) {
      meta = { ...meta, taintedFields: fields };
    } else {
      const { tainted, taintSources, taintedFields, ...rest } = meta;
      meta = rest;
    }
    return this.db.prepare('UPDATE goals SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), id);
  }

  updateGoalProgress(id, progress) {
    const stmt = this.db.prepare(
      "UPDATE goals SET progress = ?, last_activity_at = CURRENT_TIMESTAMP WHERE id = ?"
    );
    return stmt.run(progress, id);
  }

  completeGoal(id) {
    const stmt = this.db.prepare(
      "UPDATE goals SET status = 'completed', last_activity_at = CURRENT_TIMESTAMP WHERE id = ?"
    );
    stmt.run(id);
  }

  // --- Watchers ---
  createWatcher(watcher) {
    const stmt = this.db.prepare(`
        INSERT INTO watchers (name, contact_string, person_id, condition, instruction, status, taint_sources)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const taint = Array.isArray(watcher.taintSources) && watcher.taintSources.length > 0
      ? JSON.stringify(watcher.taintSources.map(String))
      : null;
    return stmt.run(
      watcher.name || 'New Watcher',
      watcher.contactString,
      watcher.personId || null,
      watcher.condition,
      watcher.instruction,
      watcher.status || 'active',
      taint
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

  logTokenUsage({ model, promptTokens, candidateTokens, totalTokens, chatId, estimatedCost, tag, cachedTokens, thoughtsTokens,
    sysTokensEst, toolsTokensEst, historyTokensEst, declCount }) {
    const stmt = this.db.prepare(`
      INSERT INTO token_usage(model, prompt_tokens, candidate_tokens, total_tokens, chat_id, estimated_cost, tag, cached_tokens, thoughts_tokens,
        sys_tokens_est, tools_tokens_est, history_tokens_est, decl_count)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const est = (v) => (Number.isFinite(v) ? Math.round(v) : null);
    stmt.run(model, promptTokens, candidateTokens, totalTokens, chatId, estimatedCost, tag || null, cachedTokens || 0, thoughtsTokens || 0,
      est(sysTokensEst), est(toolsTokensEst), est(historyTokensEst), est(declCount));
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
  /**
   * Search stored messages. Ranked full-text search when the index is ready
   * (utils/messages-fts.js); the old LIKE scan before that, with
   * `MESSAGES_FTS=0`, and when the index finds nothing (LIKE also matches
   * inside a word).
   * @param {string} query
   * @param {number} [limit]
   * @param {{ chatId?: string, notChatId?: string, from?: string, to?: string, indexOnly?: boolean }} [opts]
   *   `from` and `to` are local days, YYYY-MM-DD, both inclusive. `indexOnly`
   *   skips the scan: for a caller that has its answer and only wants more.
   * @returns {Array<{ timestamp: string, role: string, content: string, chat_id: string }>}
   */
  searchMessages(query, limit = 10, opts = {}) {
    const { chatId, notChatId, from, to, indexOnly } = opts || {};
    if (this._messagesFtsReady) {
      try {
        const rows = messagesFts.searchMessagesFts(this.db, query, { limit, chatId, notChatId, from, to });
        if (rows.length > 0) return rows;
      } catch (err) {
        console.warn('[DB] Full-text message search failed, using the plain scan:', err.message);
      }
      if (indexOnly) return [];
    }

    // Substring LIKE search. Escape LIKE wildcards so a literal "%" or "_"
    // in the query doesn't match everything.
    // Rows that matched only inside tool data (parts) have no content; return
    // a short excerpt of the parts instead. Cap every result so a search can't
    // flood the context window.
    const where = ["(content LIKE ? ESCAPE '\\' OR parts LIKE ? ESCAPE '\\')"];
    const escaped = String(query ?? '').replace(/[\\%_]/g, '\\$&');
    const params = [`%${escaped}%`, `%${escaped}%`];
    if (chatId) { where.push('chat_id = ?'); params.push(chatId); }
    if (notChatId) { where.push('(chat_id IS NULL OR chat_id != ?)'); params.push(notChatId); }
    if (from) { where.push("date(timestamp, 'localtime') >= ?"); params.push(from); }
    if (to) { where.push("date(timestamp, 'localtime') <= ?"); params.push(to); }
    const stmt = this.db.prepare(`
        SELECT timestamp, role, chat_id,
          substr(COALESCE(NULLIF(content, ''), parts), 1, CASE WHEN content IS NULL OR content = '' THEN 400 ELSE 1000 END) AS content
        FROM messages
        WHERE ${where.join(' AND ')}
        ORDER BY timestamp DESC
        LIMIT ?
        `);
    return stmt.all(...params, limit);
  }

  /**
   * Agent messages of one local day, merged with messages the caller fetched
   * elsewhere. WhatsApp messages come from the interfaces service (its
   * /internal/whatsapp/messages-by-date route): the session files live in
   * that container only, so the agent never opens that database.
   * @param {string} dateStr YYYY-MM-DD
   * @param {Array} externalMessages rows in the same shape, already fetched
   */
  getMessagesByDate(dateStr, externalMessages = []) {
    const stmt = this.db.prepare(`
        SELECT role, content, timestamp, source, metadata FROM messages
        WHERE date(timestamp, 'localtime') = ?
      `);
    const agentMessages = stmt.all(dateStr);
    console.log(`[DB] getMessagesByDate(${dateStr}): agent DB ${agentMessages.length}, external ${externalMessages?.length || 0}`);

    const allMessages = [...agentMessages, ...(Array.isArray(externalMessages) ? externalMessages : [])];
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

    // Get last N messages for this chat. rowid breaks ties between rows saved
    // in the same millisecond (a tool call and its result, for example).
    const stmt = this.db.prepare(`
      SELECT id, role, content, parts, metadata, timestamp FROM messages 
      WHERE chat_id = ?
      ORDER BY timestamp DESC, rowid DESC 
      LIMIT ?
    `);

    const rows = stmt.all(chatId, limit).reverse(); // Reverse to get chronological order
    return this._mapHistoryRows(rows);
  }

  /**
   * Role, source, the first 40 characters and the metadata of a chat's newest
   * rows, newest first. The approval gate reads it to tell the owner's words
   * from other people's (untrusted-content.js originsHaveForeignText).
   */
  getRecentMessageOrigins(chatId, limit = 100) {
    if (!chatId) return [];
    return this.db.prepare(`
      SELECT role, source, substr(content, 1, 40) AS head, metadata FROM messages
      WHERE chat_id = ?
      ORDER BY timestamp DESC, rowid DESC
      LIMIT ?
    `).all(chatId, Math.max(1, Math.min(200, Number(limit) || 100)));
  }

  /** The newest role-user rows of one chat, newest first: { id, content }. */
  getRecentUserMessages(chatId, limit = 5) {
    if (!chatId) return [];
    return this.db.prepare(`
      SELECT id, content FROM messages
      WHERE chat_id = ? AND role = 'user'
      ORDER BY timestamp DESC, rowid DESC
      LIMIT ?
    `).all(chatId, Math.max(1, Math.min(20, Number(limit) || 5)));
  }

  /**
   * Same window as getHistoryForChat, but for token estimates and summaries.
   * Rows whose parts exceed `maxPartsLength` bytes (media blobs) come back
   * with parts NULL, so the mapper falls back to the caption in `content`.
   * This keeps 100 base64 blobs from being parsed on every turn.
   */
  getHistoryForSummary(chatId, limit = 100, maxPartsLength = 20000) {
    if (!chatId) return [];
    const stmt = this.db.prepare(`
      SELECT id, role, content,
             CASE WHEN length(parts) > ? THEN NULL ELSE parts END AS parts,
             metadata, timestamp
      FROM messages
      WHERE chat_id = ?
      ORDER BY timestamp DESC, rowid DESC
      LIMIT ?
    `);
    const rows = stmt.all(maxPartsLength, chatId, limit).reverse();
    return this._mapHistoryRows(rows);
  }

  // Map raw message rows (chronological order) to the Gemini SDK shape.
  _mapHistoryRows(rows) {
    return rows.map(row => {
      let meta = {};
      try { meta = row.metadata ? JSON.parse(row.metadata) : {}; } catch (e) { }

      // Map 'assistant' role to 'model' for Gemini

      // Map 'function' role to 'user' for Gemini (function results are considered user input in the chat loop)
      let role = row.role;
      if (role === 'assistant') role = 'model';
      if (role === 'function') role = 'user';

      // Old rows may still hold epoch ms; hand callers an ISO string either way.
      const timestamp = typeof row.timestamp === 'number'
        ? new Date(row.timestamp).toISOString()
        : row.timestamp;

      if (row.parts) {
        try {
          const parts = JSON.parse(row.parts);
          // A media row keeps its caption in `content`; its parts hold only the file.
          // Put the caption back so the model still sees what was said.
          const hasText = Array.isArray(parts) && parts.some(p => typeof p.text === 'string' && p.text.trim());
          const isToolRow = Array.isArray(parts) && parts.some(p => p.functionCall || p.functionResponse);
          if (Array.isArray(parts) && !hasText && !isToolRow && typeof row.content === 'string' && row.content.trim()) {
            parts.unshift({ text: row.content });
          }
          return { id: row.id, role, parts, metadata: meta, timestamp };
        } catch (e) {
          console.error('[DB] Failed to parse message parts:', e);
        }
      }

      // Fallback to content
      return {
        id: row.id,
        role: role,
        parts: [{ text: row.content || '' }],
        metadata: meta,
        timestamp
      };
    });
  }

  /**
   * Count the messages in a chat saved after the given message.
   * Returns null when the message is missing (deleted or unknown id).
   */
  countMessagesAfter(chatId, messageId) {
    if (!chatId || !messageId) return null;
    const target = this.db.prepare('SELECT rowid, timestamp FROM messages WHERE id = ? AND chat_id = ?').get(messageId, chatId);
    if (!target) return null;
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE chat_id = ?
      AND (timestamp > ? OR (timestamp = ? AND rowid > ?))
    `).get(chatId, target.timestamp, target.timestamp, target.rowid);
    return row.count;
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
      stmt.run(`%${chatId}%`);
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
   * The database part of GET /health. Returns { ok, details }.
   *
   * `quick_check` walks every page of the file. It ran on every health
   * request, and better-sqlite3 is synchronous: on the device it blocked the
   * whole agent for 1.2 to 2.0 seconds each time, several times a minute (the
   * dashboard, the API and the supervisor all ask). Once the message search
   * index made the file bigger, the answer also came later than the API's
   * one-second wait, so the dashboard showed a working agent as down.
   *
   * A request now costs one `SELECT 1` and a stat of the WAL file. The scan
   * runs in a worker thread, at most every HEALTH_INTEGRITY_MINUTES, so it
   * blocks neither the request nor the agent. A request reports the last scan:
   * 'pending' until the first one lands. A damaged file does not heal itself,
   * so "corrupt" is kept and shown until a later scan says otherwise. A scan
   * that could not run is tried again within a minute.
   * @param {{ now?: number }} [opts]
   */
  healthCheck({ now = Date.now() } = {}) {
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

    // 2. Integrity: the slow part, from the last scan.
    this._startIntegrityScan(now);
    const scan = this._integrity;
    if (!scan) {
      details.integrity = integrityScanEveryMs() ? 'pending' : 'off';
    } else {
      details.integrity = scan.integrity;
      details.integrityCheckedAt = new Date(scan.at).toISOString();
      if (scan.integrityErrors) details.integrityErrors = scan.integrityErrors;
      if (scan.integrityError) details.integrityError = scan.integrityError;
      if (scan.integrity === 'corrupt') details.status = 'corrupt';
      else if (scan.integrity === 'error') details.status = 'error';
    }

    // 3. WAL size. SQLite checkpoints it on its own; this only reports.
    try {
      details.wal = { bytes: fs.statSync(`${this.dbPath}-wal`).size };
    } catch {
      details.wal = { bytes: 0 };
    }

    return { ok: details.status === 'ok', details };
  }

  /** Start one scan when the last is too old and none is running. Returns its promise, or null. */
  _startIntegrityScan(now = Date.now()) {
    const every = integrityScanEveryMs();
    if (!every || this._integrityRun) return null;
    const last = this._integrity;
    const wait = last && last.integrity === 'error' ? Math.min(every, INTEGRITY_RETRY_MS) : every;
    if (last && now - last.at <= wait) return null;
    this._integrityRun = this.scanIntegrity(now).then((scan) => {
      this._integrityRun = null;
      // A scan of a file that was closed meanwhile says nothing about the next one.
      if (this.db && this.db.open) this._integrity = scan;
      return scan;
    });
    return this._integrityRun;
  }

  /**
   * One full scan, in a worker thread on its own read-only connection.
   * Resolves to { at, integrity, integrityErrors?, integrityError? }; never rejects.
   */
  scanIntegrity(now = Date.now()) {
    const started = Date.now();
    return new Promise((resolve) => {
      let settled = false;
      const done = (scan) => {
        if (settled) return;
        settled = true;
        const took = Date.now() - started;
        if (took > 500 || scan.integrity !== 'ok') {
          console.log(`[DB] Integrity scan: ${scan.integrity} in ${took} ms, off the main thread.${scan.integrityError ? ` ${scan.integrityError}` : ''}`);
        }
        resolve({ at: now, ...scan });
      };
      let worker;
      try {
        worker = new Worker(INTEGRITY_WORKER, { workerData: { file: this.dbPath } });
      } catch (err) {
        return done({ integrity: 'error', integrityError: err.message });
      }
      worker.once('message', (msg) => {
        if (msg && msg.error) return done({ integrity: 'error', integrityError: msg.error });
        const rows = (msg && msg.rows) || [];
        if (rows.length === 1 && rows[0] === 'ok') return done({ integrity: 'ok' });
        done({ integrity: 'corrupt', integrityErrors: rows });
      });
      worker.once('error', (err) => done({ integrity: 'error', integrityError: err.message }));
      worker.once('exit', (code) => done({ integrity: 'error', integrityError: `the scan worker exited with code ${code} and no result` }));
      // A scan in flight must not hold a shutdown open.
      worker.unref();
    });
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
   * What fills the prompt, by tag and model: the billed prompt tokens beside
   * the system, tools and history estimates written with each row. Rows from
   * before those columns existed carry NULL and are left out.
   * @param {string} [start] - ISO start date
   * @param {string} [end] - ISO end date
   * @param {number} [days] - Fallback window when there is no start or end
   * @returns {Array<{ tag: string, model: string, calls: number, prompt_tokens: number,
   *   sys_tokens: number, tools_tokens: number, history_tokens: number, decl_count: number }>}
   */
  getPromptComposition(start, end, days = 7) {
    let sql = `
      SELECT
        COALESCE(tag, 'untagged') as tag,
        model,
        COUNT(*) as calls,
        AVG(prompt_tokens) as prompt_tokens,
        AVG(sys_tokens_est) as sys_tokens,
        AVG(tools_tokens_est) as tools_tokens,
        AVG(history_tokens_est) as history_tokens,
        AVG(decl_count) as decl_count
      FROM token_usage
      WHERE sys_tokens_est IS NOT NULL AND `;
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
    sql += ` GROUP BY tag, model ORDER BY calls DESC`;
    return this.db.prepare(sql).all(...params);
  }

  /**
   * Cost by the tag as written, so a turn and its tool loop stay apart
   * (`chat` against `chat_tool_loop`). Rows with no tag fall back to the same
   * chat_id classification the category chart uses.
   * @param {string} [start] - ISO start date
   * @param {string} [end] - ISO end date
   * @param {number} [days] - Fallback window when there is no start or end
   * @returns {Array<{ tag: string, cost: number, tokens: number, calls: number }>}
   */
  getCostByRawTag(start, end, days = 7) {
    let sql = `
      SELECT
        COALESCE(tag, ${EFFECTIVE_TAG_SQL}) as tag,
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
    // Group on the expression, not the name: SQLite reads a bare `tag` in the
    // GROUP BY as the token_usage column, so every untagged row would land in
    // one bucket with a label taken from an arbitrary row.
    sql += ` GROUP BY COALESCE(tag, ${EFFECTIVE_TAG_SQL}) ORDER BY cost DESC`;
    return this.db.prepare(sql).all(...params);
  }

  /**
   * Turns against prefix changes per day. A change means the cached part of
   * the prompt moved, so the next call pays full price for it.
   * @param {string} [start] - ISO start date
   * @param {string} [end] - ISO end date
   * @param {number} [days] - Fallback window when there is no start or end
   * @returns {Array<{ date: string, turns: number, changed: number }>}
   */
  getPrefixChurn(start, end, days = 7) {
    let sql = `
      SELECT
        date(timestamp, 'localtime') as date,
        COUNT(*) as turns,
        SUM(value) as changed
      FROM metrics
      WHERE type = 'prefix_hash' AND `;
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
    sql += ` GROUP BY date(timestamp, 'localtime') ORDER BY date(timestamp, 'localtime')`;
    return this.db.prepare(sql).all(...params);
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

  // Rows in the 'system' category (migration flags) are internal bookkeeping
  // and stay out of the settings the UI and the agent read.
  getAllAgentSettings() {
    const stmt = this.db.prepare("SELECT key, value, category FROM agent_settings WHERE COALESCE(category, 'general') != 'system'");
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

  updateSubAgent(id, { status, result, resultFull, error, completedAt }) {
    const updates = ['completed_at = ?'];
    const args = [completedAt || new Date().toISOString()];

    if (status) { updates.push('status = ?'); args.push(status); }
    if (result !== undefined) { updates.push('result = ?'); args.push(typeof result === 'string' ? result : JSON.stringify(result)); }
    if (resultFull !== undefined) { updates.push('result_full = ?'); args.push(typeof resultFull === 'string' ? resultFull : JSON.stringify(resultFull)); }
    if (error !== undefined) { updates.push('error = ?'); args.push(error); }

    args.push(id);
    this.db.prepare(`UPDATE subagents SET ${updates.join(', ')} WHERE id = ?`).run(...args);
  }

  getSubAgent(id) {
    return this.db.prepare('SELECT * FROM subagents WHERE id = ?').get(id);
  }

  listSubAgents(parentChatId, { page = 1, limit = 50, search = null, status = null } = {}) {
    // Lists leave out result_full; getSubAgent returns it.
    const SUBAGENT_LIST_COLUMNS = 'id, parent_chat_id, task, status, model, result, error, created_at, completed_at';
    const offset = (page - 1) * limit;
    if (parentChatId) {
      const tasks = this.db.prepare(`SELECT ${SUBAGENT_LIST_COLUMNS} FROM subagents WHERE parent_chat_id = ? ORDER BY created_at DESC`).all(parentChatId);
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
    const tasks = this.db.prepare(`SELECT ${SUBAGENT_LIST_COLUMNS} FROM subagents${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
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

  // --- askUser: pending questions ---

  createPendingQuestion({ id, chatId, replyChatId, replySource, source, question, options, expiresAt }) {
    this.db.prepare(`
      INSERT INTO pending_questions (id, chat_id, reply_chat_id, reply_source, source, question, options, status, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, chatId || null, replyChatId, replySource || null, source || null, question,
      options ? JSON.stringify(options) : null, expiresAt || null);
  }

  /** The open question waiting on `replyChatId`, or undefined. */
  getPendingQuestion(replyChatId) {
    return this.db.prepare(`
      SELECT * FROM pending_questions WHERE reply_chat_id = ? AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1
    `).get(replyChatId);
  }

  /** The newest question on `replyChatId` that ended without an answer. */
  getLastClosedQuestion(replyChatId) {
    return this.db.prepare(`
      SELECT * FROM pending_questions
      WHERE reply_chat_id = ? AND status IN ('expired', 'timeout')
      ORDER BY answered_at DESC LIMIT 1
    `).get(replyChatId);
  }

  closePendingQuestion(id, status, answer = null) {
    const { changes } = this.db.prepare(`
      UPDATE pending_questions
      SET status = ?, answer = ?, answered_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).run(status, answer, id);
    // A question he has answered stops asking from the bell.
    if (changes > 0) this.markQuestionNotificationsRead(id);
  }

  /**
   * Boot: no wait survives a restart, so every open row becomes 'expired'.
   * Returns the rows it closed.
   */
  expirePendingQuestions() {
    const rows = this.db.prepare(`SELECT id, reply_chat_id, options FROM pending_questions WHERE status = 'pending'`).all();
    if (rows.length > 0) {
      this.db.prepare(`
        UPDATE pending_questions SET status = 'expired', answered_at = datetime('now')
        WHERE status = 'pending'
      `).run();
      this.markQuestionNotificationsRead(rows.map(r => r.id));
    }
    return rows;
  }

  /** Source of the newest user message in a chat (used to route sub-agent questions). */
  getLastUserSource(chatId) {
    if (!chatId) return null;
    const row = this.db.prepare(`
      SELECT source FROM messages WHERE chat_id = ? AND role = 'user'
      ORDER BY timestamp DESC LIMIT 1
    `).get(chatId);
    return row ? row.source : null;
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

  // --- Notification outbox (delivery ledger) ---
  //
  // One row per outbound owner notification. services/delivery-service.js
  // owns the state machine: pending -> sent, or pending -> failed (retry
  // with backoff) -> dead. A row that a fallback channel delivered is 'sent'
  // with delivered_via set to that channel.

  static get OUTBOX_STATUSES() { return ['pending', 'sent', 'failed', 'dead']; }

  _mapOutboxRow(row) {
    if (!row) return null;
    let payload = {};
    try { payload = row.payload ? JSON.parse(row.payload) : {}; } catch { payload = {}; }
    return { ...row, payload };
  }

  /**
   * Insert a ledger row. `attempts` and `status` may be preset when the
   * caller already made the first attempt (a reply the interface refused).
   */
  enqueueOutbox({ id, kind, channel, target, payload, origin, contentHash, expiresAt,
    status = 'pending', attempts = 0, lastError = null, nextAttemptAt = null, createdAt = null }) {
    const rowId = id || crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO notification_outbox
        (id, kind, channel, target, payload, status, attempts, next_attempt_at, last_error, created_at, origin, content_hash, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(rowId, kind, channel, target, JSON.stringify(payload || {}), status, attempts,
      nextAttemptAt || now, lastError, createdAt || now, origin || null, contentHash || null, expiresAt || null);
    return this.getOutboxRow(rowId);
  }

  getOutboxRow(id) {
    return this._mapOutboxRow(this.db.prepare('SELECT * FROM notification_outbox WHERE id = ?').get(id));
  }

  /**
   * Rows whose next attempt is due. Each claimed row gets a short lease so a
   * second tick (or a crash mid-send) does not pick it again at once.
   */
  claimDueOutbox(limit = 20, { now = new Date(), leaseMs = 2 * 60 * 1000 } = {}) {
    const safeLimit = Math.min(Math.max(1, limit), 200);
    const nowIso = now.toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM notification_outbox
      WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC
      LIMIT ?
    `).all(nowIso, safeLimit);
    if (rows.length === 0) return [];
    const lease = new Date(now.getTime() + leaseMs).toISOString();
    const bump = this.db.prepare('UPDATE notification_outbox SET next_attempt_at = ? WHERE id = ?');
    const tx = this.db.transaction((ids) => { for (const id of ids) bump.run(lease, id); });
    tx(rows.map(r => r.id));
    return rows.map(r => this._mapOutboxRow(r));
  }

  markOutboxSent(id, { via = null, now = new Date() } = {}) {
    this.db.prepare(`
      UPDATE notification_outbox
      SET status = 'sent', sent_at = ?, delivered_via = COALESCE(?, channel), attempts = attempts + 1, last_error = NULL
      WHERE id = ?
    `).run(now.toISOString(), via, id);
    return this.getOutboxRow(id);
  }

  /**
   * Record a failed attempt. Schedules the next one with backoff, or moves
   * the row to 'dead' once it used up its attempts.
   * @param {string} id
   * @param {string} error
   * @param {{ backoffMs?: number[], maxAttempts?: number, now?: Date }} opts
   */
  markOutboxFailed(id, error, { backoffMs = [60e3, 300e3, 900e3, 3600e3], maxAttempts = 6, now = new Date() } = {}) {
    const row = this.getOutboxRow(id);
    if (!row) return null;
    const attempts = row.attempts + 1;
    const message = String(error || 'send failed').slice(0, 500);
    if (attempts >= maxAttempts) {
      return this.deadLetterOutbox(id, message, { attempts, now });
    }
    const delay = backoffMs[Math.min(attempts - 1, backoffMs.length - 1)];
    const nextAt = new Date(now.getTime() + delay).toISOString();
    this.db.prepare(`
      UPDATE notification_outbox
      SET status = 'failed', attempts = ?, next_attempt_at = ?, last_error = ?
      WHERE id = ?
    `).run(attempts, nextAt, message, id);
    return this.getOutboxRow(id);
  }

  deadLetterOutbox(id, error, { attempts = null, now = new Date() } = {}) {
    this.db.prepare(`
      UPDATE notification_outbox
      SET status = 'dead', attempts = COALESCE(?, attempts), next_attempt_at = NULL, last_error = ?
      WHERE id = ?
    `).run(attempts, String(error || 'gave up').slice(0, 500), id);
    return this.getOutboxRow(id);
  }

  /** Note the one fallback attempt made for a row. */
  noteOutboxFallback(id, { channel, target, status, error = null, now = new Date() }) {
    this.db.prepare(`
      UPDATE notification_outbox
      SET fallback_channel = ?, fallback_target = ?, fallback_status = ?, fallback_at = ?,
          last_error = CASE WHEN ? IS NULL THEN last_error ELSE ? END
      WHERE id = ?
    `).run(channel, target, status, now.toISOString(), error, error ? String(error).slice(0, 500) : null, id);
    return this.getOutboxRow(id);
  }

  /** Put a row back in line for an attempt right now (Retry button). */
  resetOutboxRow(id, { now = new Date() } = {}) {
    const res = this.db.prepare(`
      UPDATE notification_outbox
      SET status = 'pending', next_attempt_at = ?, sent_at = NULL
      WHERE id = ? AND status != 'sent'
    `).run(now.toISOString(), id);
    return res.changes > 0 ? this.getOutboxRow(id) : null;
  }

  /** A row with the same kind, target and content created after `since`. */
  findOutboxDuplicate(kind, target, contentHash, since) {
    if (!contentHash) return null;
    const sinceIso = since instanceof Date ? since.toISOString() : since;
    return this._mapOutboxRow(this.db.prepare(`
      SELECT * FROM notification_outbox
      WHERE kind = ? AND target = ? AND content_hash = ? AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(kind, target, contentHash, sinceIso));
  }

  listRecentOutbox({ limit = 50, status = null } = {}) {
    const safeLimit = Math.min(Math.max(1, limit), 500);
    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status, safeLimit] : [safeLimit];
    return this.db.prepare(`
      SELECT * FROM notification_outbox ${where}
      ORDER BY created_at DESC LIMIT ?
    `).all(...params).map(r => this._mapOutboxRow(r));
  }

  countOutboxByStatus() {
    const counts = { pending: 0, sent: 0, failed: 0, dead: 0 };
    for (const row of this.db.prepare('SELECT status, COUNT(*) AS n FROM notification_outbox GROUP BY status').all()) {
      counts[row.status] = row.n;
    }
    return counts;
  }

  /** Drop sent and dead rows older than `days`. Returns the number removed. */
  cleanupOutbox(days = 30) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`
      DELETE FROM notification_outbox WHERE status IN ('sent', 'dead') AND created_at < ?
    `).run(cutoff).changes;
  }

  // --- Approvals: pending confirmations ---
  //
  // A tool call the safety rules paused. The row outlives the run and the
  // process: the owner may answer from any of his chats, minutes or hours
  // later. `mode` is 'interactive' when the origin chat is where the owner
  // answers (web, telegram, his WhatsApp chat) and 'deferred' when the run
  // came from a job, a watcher or the system and the prompt went to the
  // owner channel instead.

  _mapConfirmationRow(row) {
    if (!row) return null;
    let args = {};
    let originMeta = null;
    let result = null;
    try { args = JSON.parse(row.args || '{}'); } catch { args = {}; }
    try { originMeta = row.origin_meta ? JSON.parse(row.origin_meta) : null; } catch { originMeta = null; }
    try { result = row.result ? JSON.parse(row.result) : null; } catch { result = row.result; }
    return { ...row, args, origin_meta: originMeta, result };
  }

  createPendingConfirmation({ id, originChatId, originSource, originMeta, replyChatId, replyChannel, mode,
    toolName, args, summary, reason, expiresAt, createdAt = null }) {
    const rowId = id || crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO pending_confirmations
        (id, origin_chat_id, origin_source, origin_meta, reply_chat_id, reply_channel, mode, tool_name, args,
         summary, reason, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(rowId, originChatId || null, originSource || null, originMeta ? JSON.stringify(originMeta) : null,
      replyChatId, replyChannel || null, mode || 'interactive', toolName, JSON.stringify(args || {}),
      summary || null, reason || null, createdAt || now, expiresAt);
    return this.getPendingConfirmation(rowId);
  }

  getPendingConfirmation(id) {
    return this._mapConfirmationRow(this.db.prepare('SELECT * FROM pending_confirmations WHERE id = ?').get(id));
  }

  /**
   * Open rows, oldest first. `replyChatId` narrows to one chat. Rows past
   * their expiry are left out even before the sweeper marks them.
   */
  listPendingConfirmations({ replyChatId = null, now = new Date() } = {}) {
    const nowIso = now.toISOString();
    const rows = replyChatId
      ? this.db.prepare(`
          SELECT * FROM pending_confirmations
          WHERE status = 'pending' AND reply_chat_id = ? AND expires_at > ?
          ORDER BY created_at ASC
        `).all(replyChatId, nowIso)
      : this.db.prepare(`
          SELECT * FROM pending_confirmations
          WHERE status = 'pending' AND expires_at > ?
          ORDER BY created_at ASC
        `).all(nowIso);
    return rows.map(r => this._mapConfirmationRow(r));
  }

  /**
   * Close a pending row. Only one caller wins: the UPDATE is guarded on
   * status = 'pending', so a second yes (or a yes after the sweeper) does
   * nothing and returns null. An approve or deny also needs the row to be
   * within its expiry, so a row the sweeper has not marked yet cannot run.
   */
  decidePendingConfirmation(id, status, { via = null, now = new Date() } = {}) {
    if (!['approved', 'denied', 'expired'].includes(status)) throw new Error(`bad confirmation status '${status}'`);
    const nowIso = now.toISOString();
    const res = status === 'expired'
      ? this.db.prepare(`
          UPDATE pending_confirmations
          SET status = ?, decided_at = ?, decided_via = ?
          WHERE id = ? AND status = 'pending'
        `).run(status, nowIso, via, id)
      : this.db.prepare(`
          UPDATE pending_confirmations
          SET status = ?, decided_at = ?, decided_via = ?
          WHERE id = ? AND status = 'pending' AND expires_at > ?
        `).run(status, nowIso, via, id, nowIso);
    if (res.changes > 0) this._settleGuardianDecision([id], status, { via });
    if (res.changes === 0) return null;
    // The question has an answer now, so it stops asking from the bell.
    this.markApprovalNotificationsRead(id);
    return this.getPendingConfirmation(id);
  }

  /**
   * Mark the bell entries for these approvals read. They stay in the list,
   * so he can still see what was asked and what he said.
   * @returns {number} rows changed
   */
  markApprovalNotificationsRead(ids) {
    return this._markAnsweredNotificationsRead('approval', 'approvalId', ids);
  }

  /** The same for a question he has answered, or that ran out of time. */
  markQuestionNotificationsRead(ids) {
    return this._markAnsweredNotificationsRead('ask_user', 'questionId', ids);
  }

  _markAnsweredNotificationsRead(type, field, ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
    if (list.length === 0) return 0;
    const holes = list.map(() => '?').join(',');
    try {
      const { changes } = this.db.prepare(`
        UPDATE notifications SET is_read = 1
        WHERE type = ? AND is_read = 0
          AND json_extract(metadata, '$.${field}') IN (${holes})
      `).run(type, ...list);
      // The open page should not keep the count it had a moment ago.
      if (changes > 0) this.onNotificationsRead?.(list);
      return changes;
    } catch (err) {
      console.warn(`[DB] Could not mark ${type} notifications read:`, err.message);
      return 0;
    }
  }

  /** What the approved call returned (or the error), for the settings card. */
  setConfirmationResult(id, result) {
    let text;
    try { text = JSON.stringify(result === undefined ? null : result); } catch { text = String(result); }
    if (text && text.length > 4000) text = JSON.stringify(text.slice(0, 4000) + '...');
    this.db.prepare('UPDATE pending_confirmations SET result = ? WHERE id = ?').run(text, id);
  }

  /** Sweeper: every open row past its expiry becomes 'expired'. Returns them. */
  expirePendingConfirmations({ now = new Date() } = {}) {
    const nowIso = now.toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM pending_confirmations WHERE status = 'pending' AND expires_at <= ?
    `).all(nowIso).map(r => this._mapConfirmationRow(r));
    if (rows.length > 0) {
      this.db.prepare(`
        UPDATE pending_confirmations
        SET status = 'expired', decided_at = ?, decided_via = 'sweeper'
        WHERE status = 'pending' AND expires_at <= ?
      `).run(nowIso, nowIso);
      this._settleGuardianDecision(rows.map(r => r.id), 'expired');
      // A card that ran out of time is not a question any more either.
      this.markApprovalNotificationsRead(rows.map(r => r.id));
    }
    return rows;
  }

  listRecentConfirmations({ limit = 50 } = {}) {
    const safeLimit = Math.min(Math.max(1, limit), 500);
    return this.db.prepare(`
      SELECT * FROM pending_confirmations ORDER BY created_at DESC LIMIT ?
    `).all(safeLimit).map(r => this._mapConfirmationRow(r));
  }

  countConfirmationsByStatus() {
    const counts = { pending: 0, approved: 0, denied: 0, expired: 0 };
    for (const row of this.db.prepare('SELECT status, COUNT(*) AS n FROM pending_confirmations GROUP BY status').all()) {
      counts[row.status] = row.n;
    }
    return counts;
  }

  /** Drop decided rows older than `days`. Returns the number removed. */
  cleanupConfirmations(days = 30) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`
      DELETE FROM pending_confirmations WHERE status != 'pending' AND created_at < ?
    `).run(cutoff).changes;
  }

  // --- Approval guardian: decisions ---
  //
  // One row per gated tool call (services/approval-service.js review()).
  // Outcomes: auto_allowed, auto_denied, escalated (still waiting),
  // escalated_approved, escalated_denied, escalated_expired,
  // escalated_failed (nobody could be asked), deny_list, breaker_stop,
  // ran_unasked (mode off), owner_instructed (the owner asked for it in his
  // own chat, so no card), escalated_duplicate (a card for that action was
  // already waiting), escalated_superseded (the action ran another way before
  // he answered), shell_refused (the shell blocks that command whatever anyone
  // approves, so the gate refuses it with no card, counts it toward the
  // breaker and tells the owner once per run). An escalated row follows its
  // approval row.

  /** An escalated decision takes the owner's answer (or the expiry). */
  _settleGuardianDecision(approvalIds, status, { via = null } = {}) {
    // A card the action outran is not one he let expire.
    const outcome = via === 'superseded' ? 'escalated_superseded'
      : { approved: 'escalated_approved', denied: 'escalated_denied', expired: 'escalated_expired' }[status];
    if (!outcome || !approvalIds || approvalIds.length === 0) return;
    try {
      const stmt = this.db.prepare(`
        UPDATE guardian_decisions SET outcome = ?, updated_at = ?,
          decided_by = CASE WHEN ? = 'escalated_expired' THEN 'nobody' ELSE 'owner' END
        WHERE approval_id = ? AND outcome = 'escalated'
      `);
      const now = new Date().toISOString();
      for (const id of approvalIds) stmt.run(outcome, now, outcome, id);
    } catch (e) {
      console.warn('[DB] guardian decision settle failed:', e.message);
    }
  }

  _mapGuardianRow(row, { withInput = true } = {}) {
    if (!row) return null;
    const parse = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };
    const out = {
      ...row,
      taint_sources: parse(row.taint_sources, []),
      floor: parse(row.floor, []),
      always_ask: parse(row.always_ask, []),
      breaker_tripped: !!row.breaker_tripped,
    };
    if (withInput) out.guardian_input = parse(row.guardian_input, null);
    else delete out.guardian_input;
    return out;
  }

  recordGuardianDecision(d) {
    const id = d.id || crypto.randomUUID();
    const now = d.createdAt || new Date().toISOString();
    const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
    this.db.prepare(`
      INSERT INTO guardian_decisions
        (id, created_at, updated_at, run_id, chat_id, source, source_kind, job_name, tool_name, target, taint_sources,
         mode, floor, always_ask, outcome, decided_by, verdict, model_verdict, reason, risk, latency_ms, tokens, cost,
         guardian_input, approval_id, breaker_tripped)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, now, now, d.runId || null, d.chatId || null, d.source || null, d.sourceKind || null, d.jobName || null,
      String(d.toolName || ''), d.target || null, json(d.taintSources || []), d.mode || null, json(d.floor || []),
      json(d.alwaysAsk || []), d.outcome, d.decidedBy || null, d.verdict || null, d.modelVerdict || null,
      d.reason || null, d.risk || null, Number.isFinite(d.latencyMs) ? Math.round(d.latencyMs) : null,
      Number.isFinite(d.tokens) ? Math.round(d.tokens) : null, Number.isFinite(d.cost) ? d.cost : null,
      json(d.guardianInput), d.approvalId || null, d.breakerTripped ? 1 : 0);
    return this.getGuardianDecision(id);
  }

  getGuardianDecision(id) {
    return this._mapGuardianRow(this.db.prepare('SELECT * FROM guardian_decisions WHERE id = ?').get(String(id || '')));
  }

  updateGuardianDecision(id, fields = {}) {
    const allowed = { outcome: 'outcome', approvalId: 'approval_id', decidedBy: 'decided_by', reason: 'reason' };
    const sets = [];
    const vals = [];
    for (const [k, col] of Object.entries(allowed)) {
      if (fields[k] !== undefined) { sets.push(`${col} = ?`); vals.push(fields[k]); }
    }
    if (sets.length === 0) return this.getGuardianDecision(id);
    sets.push('updated_at = ?');
    vals.push(new Date().toISOString(), id);
    this.db.prepare(`UPDATE guardian_decisions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.getGuardianDecision(id);
  }

  /** WHERE clause for the history and stats filters. */
  _guardianWhere({ outcome, tool, risk, sourceKind, from, to, feedback } = {}) {
    const where = [];
    const vals = [];
    const list = (v) => String(v).split(',').map(x => x.trim()).filter(Boolean);
    if (outcome) { const l = list(outcome); where.push(`outcome IN (${l.map(() => '?').join(',')})`); vals.push(...l); }
    if (tool) { where.push('tool_name LIKE ?'); vals.push(String(tool).replace(/\*/g, '%')); }
    if (risk) { const l = list(risk); where.push(`risk IN (${l.map(() => '?').join(',')})`); vals.push(...l); }
    if (sourceKind) { const l = list(sourceKind); where.push(`source_kind IN (${l.map(() => '?').join(',')})`); vals.push(...l); }
    if (from) { where.push('created_at >= ?'); vals.push(String(from)); }
    if (to) { where.push('created_at <= ?'); vals.push(/^\d{4}-\d{2}-\d{2}$/.test(String(to)) ? `${to}T23:59:59.999Z` : String(to)); }
    if (feedback === true || feedback === 'any') where.push('feedback IS NOT NULL');
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', vals };
  }

  /** History, newest first. Rows carry the guardian input only with `withInput`. */
  listGuardianDecisions({ limit = 50, offset = 0, withInput = false, ...filters } = {}) {
    const safeLimit = Math.min(Math.max(1, parseInt(limit) || 50), 500);
    const safeOffset = Math.max(0, parseInt(offset) || 0);
    const { sql, vals } = this._guardianWhere(filters);
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM guardian_decisions ${sql}`).get(...vals).n;
    const rows = this.db.prepare(`SELECT * FROM guardian_decisions ${sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...vals, safeLimit, safeOffset).map(r => this._mapGuardianRow(r, { withInput }));
    return { rows, total, limit: safeLimit, offset: safeOffset };
  }

  /**
   * Owner feedback on a decided row: 'should_allow' | 'should_deny' | null
   * (clears it). Never changes the decision.
   */
  setGuardianFeedback(id, feedback, note = null) {
    if (feedback !== null && !['should_allow', 'should_deny'].includes(feedback)) throw new Error(`bad feedback '${feedback}'`);
    const res = this.db.prepare(`
      UPDATE guardian_decisions SET feedback = ?, feedback_note = ?, feedback_at = ?, updated_at = ? WHERE id = ?
    `).run(feedback, feedback ? (note ? String(note).slice(0, 500) : null) : null, feedback ? new Date().toISOString() : null,
      new Date().toISOString(), String(id || ''));
    return res.changes > 0 ? this.getGuardianDecision(id) : null;
  }

  /**
   * Stats for a date range (ISO days, inclusive). Detailed rows and the
   * daily aggregates are added together; taint sources and the median
   * latency come from detailed rows only (the last 180 days).
   */
  guardianStats({ from = null, to = null } = {}) {
    const fromDay = from ? String(from).slice(0, 10) : null;
    const toDay = to ? String(to).slice(0, 10) : null;
    const { sql, vals } = this._guardianWhere({ from: fromDay, to: toDay });
    const dailyWhere = [];
    const dailyVals = [];
    if (fromDay) { dailyWhere.push('day >= ?'); dailyVals.push(fromDay); }
    if (toDay) { dailyWhere.push('day <= ?'); dailyVals.push(toDay); }
    const dsql = dailyWhere.length ? `WHERE ${dailyWhere.join(' AND ')}` : '';

    const perDayMap = new Map();
    const addDay = (day, outcome, n) => {
      if (!perDayMap.has(day)) perDayMap.set(day, { day });
      const d = perDayMap.get(day);
      d[outcome] = (d[outcome] || 0) + n;
    };
    for (const r of this.db.prepare(`SELECT substr(created_at, 1, 10) AS day, outcome, COUNT(*) AS n FROM guardian_decisions ${sql} GROUP BY day, outcome`).all(...vals)) addDay(r.day, r.outcome, r.n);
    for (const r of this.db.prepare(`SELECT day, outcome, SUM(count) AS n FROM guardian_daily ${dsql} GROUP BY day, outcome`).all(...dailyVals)) addDay(r.day, r.outcome, r.n);
    const perDay = [...perDayMap.values()].sort((a, b) => a.day.localeCompare(b.day));

    const outcomes = {};
    for (const d of perDay) for (const [k, v] of Object.entries(d)) if (k !== 'day') outcomes[k] = (outcomes[k] || 0) + v;
    const total = Object.values(outcomes).reduce((a, b) => a + b, 0);
    // Calls the gate had to decide. A call the owner asked for himself, and a
    // call that waited on a card already open, were never the guardian's to judge.
    const ownerInstructed = outcomes.owner_instructed || 0;
    const duplicates = outcomes.escalated_duplicate || 0;
    // A command the shell blocks is refused before the guardian sees it.
    const shellRefused = outcomes.shell_refused || 0;
    const judged = total - ownerInstructed - duplicates - shellRefused;
    const auto = (outcomes.auto_allowed || 0) + (outcomes.auto_denied || 0);
    const escalatedDecided = (outcomes.escalated_approved || 0) + (outcomes.escalated_denied || 0);
    const escalations = escalatedDecided + (outcomes.escalated || 0) + (outcomes.escalated_expired || 0) + (outcomes.escalated_failed || 0);

    const fb = this.db.prepare(`
      SELECT
        SUM(CASE WHEN feedback = 'should_allow' THEN 1 ELSE 0 END) AS should_allow,
        SUM(CASE WHEN feedback = 'should_deny' THEN 1 ELSE 0 END) AS should_deny,
        SUM(CASE WHEN feedback = 'should_allow' AND outcome IN ('auto_denied', 'breaker_stop') THEN 1 ELSE 0 END) AS denied_but_should_allow,
        SUM(CASE WHEN feedback = 'should_deny' AND outcome = 'auto_allowed' THEN 1 ELSE 0 END) AS allowed_but_should_deny,
        SUM(CASE WHEN breaker_tripped = 1 THEN 1 ELSE 0 END) AS breaker_trips,
        SUM(COALESCE(cost, 0)) AS cost,
        SUM(COALESCE(tokens, 0)) AS tokens
      FROM guardian_decisions ${sql}
    `).get(...vals);
    const agg = this.db.prepare(`
      SELECT SUM(feedback_allow) AS should_allow, SUM(feedback_deny) AS should_deny, SUM(breaker_trips) AS breaker_trips,
        SUM(cost) AS cost, SUM(latency_sum) AS latency_sum, SUM(latency_n) AS latency_n
      FROM guardian_daily ${dsql}
    `).get(...dailyVals);

    const latencies = this.db.prepare(`SELECT latency_ms FROM guardian_decisions ${sql ? `${sql} AND` : 'WHERE'} latency_ms IS NOT NULL ORDER BY latency_ms`).all(...vals).map(r => r.latency_ms);
    const median = latencies.length === 0 ? null
      : (latencies.length % 2 ? latencies[(latencies.length - 1) / 2] : Math.round((latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2));

    const topTools = new Map();
    for (const r of this.db.prepare(`SELECT tool_name, COUNT(*) AS n FROM guardian_decisions ${sql} GROUP BY tool_name`).all(...vals)) topTools.set(r.tool_name, (topTools.get(r.tool_name) || 0) + r.n);
    for (const r of this.db.prepare(`SELECT tool_name, SUM(count) AS n FROM guardian_daily ${dsql} GROUP BY tool_name`).all(...dailyVals)) topTools.set(r.tool_name, (topTools.get(r.tool_name) || 0) + r.n);

    const sourceCounts = new Map();
    for (const r of this.db.prepare(`SELECT taint_sources FROM guardian_decisions ${sql}`).all(...vals)) {
      let list = [];
      try { list = JSON.parse(r.taint_sources || '[]'); } catch { list = []; }
      for (const s of new Set((Array.isArray(list) ? list : []).map(x => String(x).replace(/ \[carried by .*\]$/, '')))) {
        sourceCounts.set(s, (sourceCounts.get(s) || 0) + 1);
      }
    }
    const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));

    // token_usage keeps only 30 days (cleanupTokenUsage), so these two are
    // side figures. The full-range cost is `cost`, from the decision rows.
    const usageFor = (tag) => {
      try {
        const u = [];
        const uv = [tag];
        if (fromDay) { u.push('timestamp >= ?'); uv.push(`${fromDay} 00:00:00`); }
        if (toDay) { u.push('timestamp <= ?'); uv.push(`${toDay} 23:59:59`); }
        const row = this.db.prepare(`SELECT SUM(estimated_cost) AS cost, COUNT(*) AS calls FROM token_usage WHERE tag = ? ${u.length ? `AND ${u.join(' AND ')}` : ''}`).get(...uv);
        return { cost: row.cost || 0, calls: row.calls || 0 };
      } catch { return { cost: 0, calls: 0 }; } // older schema
    };
    const usage = usageFor('guardian');
    const dryRunUsage = usageFor('guardian_dry_run');

    return {
      range: { from: fromDay, to: toDay },
      total,
      outcomes,
      perDay,
      autoDecisions: auto,
      autoRate: judged > 0 ? auto / judged : null,
      judged,
      ownerInstructed,
      duplicates,
      escalations,
      escalationsApproved: outcomes.escalated_approved || 0,
      escalationApprovalShare: escalatedDecided > 0 ? (outcomes.escalated_approved || 0) / escalatedDecided : null,
      feedback: {
        shouldAllow: (fb.should_allow || 0) + (agg.should_allow || 0),
        shouldDeny: (fb.should_deny || 0) + (agg.should_deny || 0),
        deniedButShouldAllow: fb.denied_but_should_allow || 0,
        allowedButShouldDeny: fb.allowed_but_should_deny || 0,
      },
      topTools: top(topTools),
      topTaintSources: top(sourceCounts),
      cost: (fb.cost || 0) + (agg.cost || 0),
      tokens: fb.tokens || 0,
      tokenUsage: usage,
      dryRunUsage,
      medianLatencyMs: median,
      breakerTrips: (fb.breaker_trips || 0) + (agg.breaker_trips || 0),
    };
  }

  /**
   * Retention: detailed rows older than `days` are folded into
   * guardian_daily (counts, cost, latency, feedback, breaker trips per day,
   * outcome, tool, source kind and risk), then deleted. Returns the number
   * of rows folded.
   */
  cleanupGuardianDecisions(days = 180) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const fold = this.db.transaction(() => {
      const groups = this.db.prepare(`
        SELECT substr(created_at, 1, 10) AS day, outcome, tool_name, COALESCE(source_kind, '') AS source_kind, COALESCE(risk, '') AS risk,
          COUNT(*) AS n, SUM(COALESCE(cost, 0)) AS cost,
          SUM(COALESCE(latency_ms, 0)) AS latency_sum, SUM(CASE WHEN latency_ms IS NULL THEN 0 ELSE 1 END) AS latency_n,
          SUM(CASE WHEN feedback = 'should_allow' THEN 1 ELSE 0 END) AS fa,
          SUM(CASE WHEN feedback = 'should_deny' THEN 1 ELSE 0 END) AS fd,
          SUM(breaker_tripped) AS bt
        FROM guardian_decisions WHERE created_at < ?
        GROUP BY day, outcome, tool_name, source_kind, risk
      `).all(cutoff);
      const upsert = this.db.prepare(`
        INSERT INTO guardian_daily (day, outcome, tool_name, source_kind, risk, count, cost, latency_sum, latency_n, feedback_allow, feedback_deny, breaker_trips)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, outcome, tool_name, source_kind, risk) DO UPDATE SET
          count = count + excluded.count, cost = cost + excluded.cost,
          latency_sum = latency_sum + excluded.latency_sum, latency_n = latency_n + excluded.latency_n,
          feedback_allow = feedback_allow + excluded.feedback_allow, feedback_deny = feedback_deny + excluded.feedback_deny,
          breaker_trips = breaker_trips + excluded.breaker_trips
      `);
      for (const g of groups) upsert.run(g.day, g.outcome, g.tool_name, g.source_kind, g.risk, g.n, g.cost, g.latency_sum, g.latency_n, g.fa, g.fd, g.bt);
      return this.db.prepare(`DELETE FROM guardian_decisions WHERE created_at < ?`).run(cutoff).changes;
    });
    return fold();
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
      'source_image_path', 'crop_image_path', 'generated_image_path', 'bbox', 'source',
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
    for (const p of [garment.source_image_path, garment.crop_image_path, garment.generated_image_path]) {
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
      INSERT INTO wr_outfits (id, name, occasion, weather_tags, garment_ids, rendered_image_path, liked, last_suggested_at, labels)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      outfit.name || null,
      outfit.occasion || null,
      outfit.weather_tags ? JSON.stringify(outfit.weather_tags) : null,
      outfit.garment_ids ? JSON.stringify(outfit.garment_ids) : '[]',
      outfit.rendered_image_path || null,
      outfit.liked ? 1 : 0,
      outfit.last_suggested_at || new Date().toISOString(),
      Array.isArray(outfit.labels) ? JSON.stringify(outfit.labels) : null
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
    const allowed = ['name', 'occasion', 'weather_tags', 'garment_ids', 'rendered_image_path', 'variations_image_path', 'liked', 'last_suggested_at', 'labels'];
    const jsonCols = new Set(['weather_tags', 'garment_ids', 'labels']);
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
      labels: safeParse(row.labels, []),
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
      'suggested_context', 'priority', 'status', 'resolved_garment_id', 'purchased_at',
      'reference_image_path'];
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
            style_preferences = '{}',
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
      sizing: safeParse(row.sizing, {}),
      style_preferences: safeParse(row.style_preferences, {})
    };
  }

  updateUserProfile(fields) {
    const allowed = ['reference_image_path', 'preferred_brands', 'sizing', 'style_notes', 'style_preferences'];
    const jsonCols = new Set(['preferred_brands', 'sizing', 'style_preferences']);
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

module.exports = { AgentDB, SERVICE_CATEGORIES, MAIN_PATH_TAGS };
