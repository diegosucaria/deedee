
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { ConfigService } = require('./config-service');

// Matryoshka dimensions supported by gemini-embedding-2: 768, 1536, 3072
// Default 768 for backward compat with existing embeddings; set EMBEDDING_DIMENSIONS to upgrade
const EMBEDDING_DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS, 10) || 768;

// Max file size for multimodal embedding (base64 encoding adds ~33% overhead)
const MAX_MULTIMODAL_SIZE = 20 * 1024 * 1024; // 20MB

// Supported media types for native multimodal embedding via gemini-embedding-2
const MEDIA_TYPES = {
    image: {
        extensions: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
        mimeMap: { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
    },
    audio: {
        extensions: ['.wav', '.mp3', '.ogg', '.opus'],
        mimeMap: { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/opus' }
    },
    video: {
        extensions: ['.mp4', '.mov'],
        mimeMap: { '.mp4': 'video/mp4', '.mov': 'video/quicktime' }
    }
};

/**
 * Where rag.db lives. Same rule as db.js and journal.js so the index sits on
 * the agent-data volume in the container, not under the app's working dir.
 */
function resolveDataDir() {
    if (process.env.DATA_DIR) return process.env.DATA_DIR;
    if (fs.existsSync('/app') && process.platform !== 'darwin') return '/app/data';
    return path.join(process.cwd(), 'data');
}

// Failed indexing passes in a row before the nightly scan stops retrying a
// document. Read on every call; RAG_MAX_INDEX_ATTEMPTS=0 means never stop.
function maxIndexAttempts() {
    const raw = String(process.env.RAG_MAX_INDEX_ATTEMPTS ?? '').trim();
    if (!raw) return 3;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

class RagService {
    constructor(agent) {
        this.agent = agent;
        this.config = new ConfigService();
        this.dbPath = path.join(resolveDataDir(), 'rag.db');
        // Set when the embedding model id changed but the dimensions did not.
        // agent.start() turns it into a background re-embed (startPendingReembed).
        this.pendingModelReembed = null;
        this.reembedInProgress = false;
        // reindexAll lock: the running promise, or null. Scans skip while it is set.
        this.reindexPromise = null;
        // Embedding call limits: parallel calls per document, tries per call,
        // first backoff delay (doubles per try). Tests lower the delay.
        this.embedConcurrency = 3;
        this.embedRetries = 3;
        this.embedRetryBaseMs = 500;
        const dbDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        this.db = new Database(this.dbPath);
        this.useVec = false;
        this._initDB();
    }

    _initDB() {
        // Try to load sqlite-vec for native KNN vector search.
        // Falls back to brute-force cosine similarity if unavailable
        // (e.g. on Alpine/musl where prebuilt binaries are glibc-only).
        try {
            const sqliteVec = require('sqlite-vec');
            const loadablePath = sqliteVec.getLoadablePath();
            const extFreePath = loadablePath.replace(/\.(so|dylib|dll)$/, '');
            this.db.loadExtension(extFreePath);
            this.useVec = true;
            console.log('[RAG] sqlite-vec loaded from npm package.');
        } catch (e) {
            console.warn('[RAG] sqlite-vec not available, using brute-force cosine similarity:', e.message);
            this.useVec = false;
        }

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filepath TEXT UNIQUE,
                filename TEXT,
                hash TEXT,
                vault_id TEXT,
                indexed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id INTEGER,
                content TEXT,
                embedding BLOB,
                chunk_index INTEGER,
                FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS rag_metadata (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);

        // Detect embedding dimension changes and handle migration
        this._handleDimensionMigration();

        // Initialize FTS5 Table for Hybrid Search
        try {
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                    content,
                    chunk_index UNINDEXED,
                    document_id UNINDEXED
                );
            `);
        } catch (e) {
            console.error('[RAG] Failed to init FTS5 table:', e.message);
        }

        // Migration: Backfill FTS if empty but chunks exist
        try {
            const ftsCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks_fts').get().count;
            if (ftsCount === 0) {
                const chunksCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks').get().count;
                if (chunksCount > 0) {
                    console.log(`[RAG] Backfilling FTS index from ${chunksCount} existing chunks...`);
                    this.db.prepare(`
                        INSERT INTO chunks_fts (content, chunk_index, document_id)
                        SELECT content, chunk_index, document_id FROM chunks
                        WHERE content_type = 'text' OR content_type IS NULL
                    `).run();
                    console.log('[RAG] FTS Backfill complete.');
                }
            }
        } catch (e) {
            console.warn('[RAG] FTS Backfill check failed:', e.message);
        }

        // Migration: Add vault_id if missing
        try {
            this.db.prepare('ALTER TABLE documents ADD COLUMN vault_id TEXT').run();
        } catch (e) { /* column exists */ }
        try {
            // Failed indexing passes in a row for this document (see ingestDocument).
            this.db.prepare('ALTER TABLE documents ADD COLUMN failed_attempts INTEGER DEFAULT 0').run();
        } catch (e) { /* column exists */ }
        try {
            // The content hash of the last pass that failed, so a changed file starts its own run of tries.
            this.db.prepare('ALTER TABLE documents ADD COLUMN tried_hash TEXT').run();
        } catch (e) { }

        // Migration: Add content_type to chunks for multimodal support
        try {
            this.db.prepare("ALTER TABLE chunks ADD COLUMN content_type TEXT DEFAULT 'text'").run();
        } catch (e) { }

        // Initialize vec0 virtual table for native vector search
        if (this.useVec) {
            try {
                this.db.exec(`
                    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
                        chunk_id INTEGER PRIMARY KEY,
                        embedding float[${EMBEDDING_DIMENSIONS}]
                    );
                `);

                // Backfill vec0 if empty but chunks exist
                const vecCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks_vec').get().count;
                if (vecCount === 0) {
                    const chunksWithEmb = this.db.prepare('SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL').all();
                    if (chunksWithEmb.length > 0) {
                        console.log(`[RAG] Backfilling vec0 index from ${chunksWithEmb.length} existing chunks...`);
                        const insert = this.db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)');
                        const batch = this.db.transaction((rows) => {
                            for (const row of rows) {
                                insert.run(row.id, row.embedding);
                            }
                        });
                        batch(chunksWithEmb);
                        console.log('[RAG] vec0 backfill complete.');
                    }
                }
            } catch (e) {
                console.warn('[RAG] Failed to create vec0 table:', e.message);
                this.useVec = false;
            }
        }
    }

    /**
     * Detect if embedding dimensions changed since last run.
     * If dimensions changed, existing embeddings are incompatible:
     * - Drop and recreate vec0 with new dimensions
     * - Clear all embeddings (set to NULL) so they get re-embedded
     * - Clear document hashes to force re-ingestion on next scan
     */
    _handleDimensionMigration() {
        const storedDims = this.db.prepare("SELECT value FROM rag_metadata WHERE key = 'embedding_dimensions'").get();
        const storedModel = this.db.prepare("SELECT value FROM rag_metadata WHERE key = 'embedding_model'").get();
        const currentModel = this.config.getModel('EMBEDDING');
        const currentDims = EMBEDDING_DIMENSIONS;

        const prevDims = storedDims ? parseInt(storedDims.value, 10) : null;
        const prevModel = storedModel ? storedModel.value : null;

        // First run of metadata system — check if existing embeddings have different dimensions
        if (!prevDims) {
            // Detect actual embedding dimensions from existing data
            const existingChunk = this.db.prepare('SELECT embedding FROM chunks WHERE embedding IS NOT NULL LIMIT 1').get();
            if (existingChunk && existingChunk.embedding) {
                const existingDims = existingChunk.embedding.byteLength / 4; // float32 = 4 bytes
                if (existingDims !== currentDims) {
                    console.warn(`[RAG] ⚠ First-run migration: existing embeddings are ${existingDims}D but configured for ${currentDims}D.`);
                    console.warn('[RAG] Clearing incompatible embeddings to force re-indexing...');
                    this.db.prepare('UPDATE chunks SET embedding = NULL').run();
                    if (this.useVec) {
                        try { this.db.exec('DROP TABLE IF EXISTS chunks_vec'); } catch (e) { }
                    }
                    this.db.prepare("UPDATE documents SET hash = ''").run();
                    this.needsReindex = true;
                    console.log('[RAG] Embeddings cleared. Documents will be re-embedded on next scan.');
                    if (this.agent?.notifications) {
                        this.agent.notifications.create({
                            type: 'rag_reindex_required',
                            severity: 'warning',
                            title: 'RAG embeddings cleared — re-indexing required',
                            message: `Existing embeddings (${existingDims}D) are incompatible with current config (${currentDims}D). All embeddings were cleared. Documents will be re-embedded on next nightly scan.`,
                            metadata: { prevDims: existingDims, currentDims, link: '/system' }
                        });
                    }
                } else {
                    this.needsReindex = false;
                }
            } else {
                this.needsReindex = false;
            }
            this.db.prepare("INSERT OR REPLACE INTO rag_metadata (key, value) VALUES ('embedding_dimensions', ?)").run(String(currentDims));
            this.db.prepare("INSERT OR REPLACE INTO rag_metadata (key, value) VALUES ('embedding_model', ?)").run(currentModel);
            return;
        }

        const dimsChanged = prevDims !== currentDims;
        const modelChanged = prevModel !== currentModel;

        if (dimsChanged) {
            console.warn(`[RAG] ⚠ Embedding dimensions changed: ${prevDims} → ${currentDims}. Existing embeddings are incompatible.`);
            console.warn('[RAG] Clearing all embeddings and document hashes to force re-indexing on next scan...');

            // Clear embeddings (keep chunks for content/FTS)
            this.db.prepare('UPDATE chunks SET embedding = NULL').run();

            // Clear vec0 table if it exists (will be recreated with new dims below)
            if (this.useVec) {
                try { this.db.exec('DROP TABLE IF EXISTS chunks_vec'); } catch (e) { }
            }

            // Reset document hashes to force re-ingestion
            this.db.prepare("UPDATE documents SET hash = ''").run();

            // Update stored config
            this.db.prepare("INSERT OR REPLACE INTO rag_metadata (key, value) VALUES ('embedding_dimensions', ?)").run(String(currentDims));
            this.db.prepare("INSERT OR REPLACE INTO rag_metadata (key, value) VALUES ('embedding_model', ?)").run(currentModel);
            this.needsReindex = true;
            console.log('[RAG] Embeddings cleared. Documents will be re-embedded on next scan or ingest.');
            if (this.agent?.notifications) {
                this.agent.notifications.create({
                    type: 'rag_reindex_required',
                    severity: 'warning',
                    title: 'RAG embeddings cleared — re-indexing required',
                    message: `Embedding dimensions changed (${prevDims}D → ${currentDims}D). All embeddings were cleared. Documents will be re-embedded on next scan.`,
                    metadata: { prevDims, currentDims, link: '/system' }
                });
            }
        } else {
            // Metadata says dimensions match — but verify actual embeddings agree.
            // Catches case where metadata was written (e.g. 1536) but embeddings were
            // never actually migrated (still 768D from before metadata system existed).
            const existingChunk = this.db.prepare('SELECT embedding FROM chunks WHERE embedding IS NOT NULL LIMIT 1').get();
            if (existingChunk && existingChunk.embedding) {
                const actualDims = existingChunk.embedding.byteLength / 4;
                if (actualDims !== currentDims) {
                    console.warn(`[RAG] ⚠ Metadata says ${currentDims}D but actual embeddings are ${actualDims}D — fixing stale metadata.`);
                    console.warn('[RAG] Clearing incompatible embeddings to force re-indexing...');
                    this.db.prepare('UPDATE chunks SET embedding = NULL').run();
                    if (this.useVec) {
                        try { this.db.exec('DROP TABLE IF EXISTS chunks_vec'); } catch (e) { }
                    }
                    this.db.prepare("UPDATE documents SET hash = ''").run();
                    this.needsReindex = true;
                    console.log('[RAG] Embeddings cleared. Documents will be re-embedded on next scan.');
                    if (modelChanged) {
                        this.db.prepare("INSERT OR REPLACE INTO rag_metadata (key, value) VALUES ('embedding_model', ?)").run(currentModel);
                    }
                    return;
                }
            }

            if (modelChanged) {
                // Same dimensions, so the old vectors still load, but vectors from two
                // models do not share a space: new queries would match old chunks poorly.
                // Keep the old id in rag_metadata until the re-embed finishes, so a crash
                // mid-way retries on the next boot.
                console.warn(`[RAG] ⚠ Embedding model changed: ${prevModel} → ${currentModel} (dimensions unchanged at ${currentDims}).`);
                console.warn('[RAG] The RAG index needs re-embedding. It starts in the background once the agent is up.');
                this.pendingModelReembed = { prevModel, currentModel, dims: currentDims };
            }
            this.needsReindex = false;
        }
    }

    /**
     * Re-embed every indexed document with the configured model, then scan the
     * vaults and journals for new files. Works document by document: a document
     * keeps its old chunks until all its new ones embedded, so a failed call never
     * drops content from vector or keyword search. The new embedding_model id is
     * written only when every document succeeded; otherwise the old id stays and
     * the next agent start retries. One run at a time: a second caller joins it.
     * @returns {Promise<{documents:number, reembedded:number, failedDocuments:number, failedChunks:number, missing:number, complete:boolean}>}
     */
    reindexAll(vaultsDir, journalDir) {
        if (this.reindexPromise) {
            console.log('[RAG] Re-index already running; joining it.');
            return this.reindexPromise;
        }
        this.reindexPromise = this._reindexAll(vaultsDir, journalDir)
            .finally(() => { this.reindexPromise = null; });
        return this.reindexPromise;
    }

    async _reindexAll(vaultsDir, journalDir) {
        const currentModel = this.config.getModel('EMBEDDING');
        console.log(`[RAG] Starting full re-index with ${currentModel} (${EMBEDDING_DIMENSIONS}D)...`);

        const docs = this.db.prepare('SELECT id, filepath, filename, vault_id FROM documents ORDER BY id').all();
        const counts = { documents: docs.length, reembedded: 0, failedDocuments: 0, failedChunks: 0, missing: 0, complete: false };

        for (const doc of docs) {
            if (!doc.filepath || !fs.existsSync(doc.filepath)) {
                counts.missing++;
                continue;
            }
            try {
                const { failed } = await this._reembedDocument(doc);
                if (failed > 0) {
                    counts.failedDocuments++;
                    counts.failedChunks += failed;
                    console.error(`[RAG] Re-embed of ${doc.filename} kept the old vectors: ${failed} chunk(s) failed.`);
                } else {
                    counts.reembedded++;
                }
            } catch (e) {
                counts.failedDocuments++;
                console.error(`[RAG] Re-embed failed for ${doc.filename}:`, e.message);
            }
        }

        // Pick up files that are not indexed yet. Unchanged files are skipped by hash.
        if (vaultsDir) await this.scanAndIngest(vaultsDir, { fromReindex: true });
        if (journalDir) await this.scanJournals(journalDir, { fromReindex: true });

        counts.complete = counts.failedDocuments === 0;
        if (counts.complete) {
            // The index now reflects the configured model and dimensions.
            this.db.prepare("INSERT OR REPLACE INTO rag_metadata (key, value) VALUES ('embedding_dimensions', ?)").run(String(EMBEDDING_DIMENSIONS));
            this.db.prepare("INSERT OR REPLACE INTO rag_metadata (key, value) VALUES ('embedding_model', ?)").run(currentModel);
            this.pendingModelReembed = null;
            this.needsReindex = false;
            console.log(`[RAG] Full re-index complete: ${counts.reembedded} documents re-embedded, ${counts.missing} missing on disk.`);
        } else {
            // Keep the old model id: the next agent start retries the whole run.
            console.error(`[RAG] Re-index incomplete: ${counts.failedDocuments} of ${counts.documents} documents failed (${counts.failedChunks} chunks). The old embedding model id stays; the next start retries.`);
            this._notify({
                type: 'rag_reindex_failed',
                severity: 'error',
                title: `RAG re-embed for ${currentModel} incomplete`,
                message: `${counts.failedDocuments} of ${counts.documents} documents (${counts.failedChunks} chunks) could not be embedded and kept their old vectors. The run retries on the next agent start; or run the reindexEmbeddings tool.`,
                metadata: { ...counts, currentModel, link: '/system' }
            });
        }
        return counts;
    }

    /**
     * Re-embed one document in place. New chunks are written next to the old
     * ones; only when all of them embedded are the old chunks removed. On any
     * failure the new chunks are removed instead and the old ones stay.
     * @returns {Promise<{failed:number}>}
     */
    async _reembedDocument(doc) {
        const buffer = fs.readFileSync(doc.filepath);
        const hash = crypto.createHash('md5').update(buffer).digest('hex');
        const oldChunkIds = new Set(this.db.prepare('SELECT id FROM chunks WHERE document_id = ?').all(doc.id).map(r => r.id));
        const oldFtsRowids = new Set(this.db.prepare('SELECT rowid FROM chunks_fts WHERE document_id = ?').all(doc.id).map(r => r.rowid));

        let result;
        try {
            result = await this._indexContent(doc.id, doc.filepath, buffer);
        } catch (e) {
            this._swapChunks(doc.id, oldChunkIds, oldFtsRowids, false);
            throw e;
        }
        const keepNew = result.failed === 0;
        this._swapChunks(doc.id, oldChunkIds, oldFtsRowids, keepNew);
        if (keepNew) {
            // A complete set of new chunks ends any run of failed nights.
            this.db.prepare('UPDATE documents SET hash = ?, indexed_at = ?, failed_attempts = 0 WHERE id = ?').run(hash, new Date().toISOString(), doc.id);
        }
        return { failed: result.failed };
    }

    /**
     * Drop one generation of a document's chunks in one transaction: the old
     * rows when keepNew is true, the rows added after the snapshot otherwise.
     */
    _swapChunks(docId, oldChunkIds, oldFtsRowids, keepNew) {
        const chunkIds = this.db.prepare('SELECT id FROM chunks WHERE document_id = ?').all(docId).map(r => r.id);
        const ftsRowids = this.db.prepare('SELECT rowid FROM chunks_fts WHERE document_id = ?').all(docId).map(r => r.rowid);
        const dropChunks = chunkIds.filter(id => oldChunkIds.has(id) === keepNew);
        const dropFts = ftsRowids.filter(id => oldFtsRowids.has(id) === keepNew);
        const delVec = this.useVec ? this.db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?') : null;
        const delChunk = this.db.prepare('DELETE FROM chunks WHERE id = ?');
        const delFts = this.db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
        this.db.transaction(() => {
            for (const id of dropChunks) {
                if (delVec) { try { delVec.run(id); } catch (e) { } }
                delChunk.run(id);
            }
            for (const id of dropFts) delFts.run(id);
        })();
    }

    /**
     * Start the background re-embed queued by _handleDimensionMigration when the
     * embedding model id changed. Creates a notification, runs reindexAll without
     * blocking the caller, and records the new model id when it completes.
     * @param {string} [vaultsDir]
     * @param {string} [journalDir]
     * @returns {Promise<boolean>|null} the background task (resolves true on success), or null when nothing is pending
     */
    startPendingReembed(vaultsDir, journalDir) {
        const pending = this.pendingModelReembed;
        if (!pending || this.reembedInProgress) return null;
        this.reembedInProgress = true;

        const { prevModel, currentModel, dims } = pending;
        console.warn(`[RAG] Re-embedding the whole index in the background: ${prevModel} → ${currentModel} (${dims}D).`);
        this._notify({
            type: 'rag_reindex_required',
            severity: 'warning',
            title: `RAG index needs re-embedding for model ${currentModel}`,
            message: `Embedding model changed from ${prevModel} to ${currentModel} (dimensions unchanged at ${dims}). All documents are being re-embedded in the background; search quality may dip until it finishes.`,
            metadata: { prevModel, currentModel, dims, link: '/system' }
        });

        return this.reindexAll(vaultsDir, journalDir)
            .then((counts) => {
                if (!counts?.complete) {
                    // _reindexAll already posted rag_reindex_failed with the counts.
                    console.warn(`[RAG] Re-embed incomplete; ${prevModel} stays recorded until a clean run.`);
                    return false;
                }
                const stats = this.getStats();
                console.log(`[RAG] Re-embed complete: ${stats.chunks} chunks now use ${currentModel}.`);
                this._notify({
                    type: 'rag_reindex_complete',
                    severity: 'info',
                    title: `RAG index re-embedded with ${currentModel}`,
                    message: `${stats.documents} documents / ${stats.chunks} chunks were re-embedded with ${currentModel}.`,
                    metadata: { prevModel, currentModel, dims, documents: stats.documents, chunks: stats.chunks, link: '/system' }
                });
                return true;
            })
            .catch((e) => {
                console.error('[RAG] Background re-embed failed:', e.message);
                this._notify({
                    type: 'rag_reindex_failed',
                    severity: 'error',
                    title: `RAG re-embed for ${currentModel} failed`,
                    message: `Re-embedding failed: ${e.message}. It retries on the next agent start; or run the reindexEmbeddings tool.`,
                    metadata: { prevModel, currentModel, dims, error: e.message, link: '/system' }
                });
                return false;
            })
            .finally(() => {
                this.reembedInProgress = false;
            });
    }

    _notify(opts) {
        try {
            if (this.agent?.notifications?.create) this.agent.notifications.create(opts);
        } catch (e) {
            console.warn('[RAG] Notification failed:', e.message);
        }
    }

    async ingestDocument(filepath, vaultId = null) {
        if (!fs.existsSync(filepath)) throw new Error('File not found');

        const buffer = fs.readFileSync(filepath);
        const hash = crypto.createHash('md5').update(buffer).digest('hex');
        const filename = path.basename(filepath);

        // Check deduplication
        const existing = this.db.prepare('SELECT * FROM documents WHERE filepath = ?').get(filepath);
        if (existing && existing.hash === hash && existing.vault_id === vaultId) {
            console.log(`[RAG] Document ${filename} already indexed (unchanged).`);
            return;
        }

        if (existing) {
            // A changed file, a moved vault, or a retry after a failed night. The
            // old chunks stay until every new one has embedded, as a model change
            // does it (_reembedDocument): a bad night never empties a document
            // that was searchable the night before.
            console.log(`[RAG] Re-indexing ${filename}...`);
            if (existing.vault_id !== vaultId) {
                this.db.prepare('UPDATE documents SET vault_id = ? WHERE id = ?').run(vaultId, existing.id);
            }
            // A changed file gets its own run of tries, whatever the old one did.
            if (existing.failed_attempts && existing.tried_hash && existing.tried_hash !== hash) {
                this.db.prepare('UPDATE documents SET failed_attempts = 0 WHERE id = ?').run(existing.id);
            }
            return this._recordOutcome(existing.id, filename, hash, () => this._reembedDocument({ id: existing.id, filepath }));
        }

        // No hash until the pass succeeds: a process killed mid-pass (a
        // redeploy, an out-of-memory) must not leave a row that looks indexed.
        const info = this.db.prepare('INSERT INTO documents (filepath, filename, hash, vault_id, indexed_at) VALUES (?, ?, NULL, ?, ?)')
            .run(filepath, filename, vaultId, new Date().toISOString());
        const docId = info.lastInsertRowid;
        return this._recordOutcome(docId, filename, hash, () => this._indexContent(docId, filepath, buffer));
    }

    /**
     * Run one indexing pass and record how it went. The row used to be written
     * with the file's hash before any embedding, so a failed pass counted as
     * done: the next scan skipped the file for good, with no vector. The hash
     * is now written only when a pass succeeds; a failed pass (a throw, or
     * chunks that still failed after their retries) leaves it empty, and the
     * next scan indexes the file again. After maxIndexAttempts() failed passes
     * in a row the hash is written anyway, so the scan stops trying, and the
     * owner hears each time that happens; reindexEmbeddings still forces a
     * full pass, and a changed file starts its own run of tries.
     * @returns {Promise<{failed:number}>}
     */
    async _recordOutcome(docId, filename, hash, run) {
        let result;
        try {
            result = await run();
        } catch (e) {
            this._noteFailedPass(docId, filename, hash, e.message);
            throw e;
        }
        if (result && result.failed > 0) {
            this._noteFailedPass(docId, filename, hash, `${result.failed} embedding(s) failed after their retries`);
        } else {
            this.db.prepare('UPDATE documents SET hash = ?, failed_attempts = 0, tried_hash = NULL WHERE id = ?').run(hash, docId);
        }
        return result;
    }

    _noteFailedPass(docId, filename, hash, why) {
        const row = this.db.prepare('SELECT failed_attempts FROM documents WHERE id = ?').get(docId);
        const attempts = (row?.failed_attempts || 0) + 1;
        const cap = maxIndexAttempts();
        if (cap > 0 && attempts >= cap) {
            // Give up: write the file's hash, so the nightly scan skips it, and
            // say so. Search keeps whatever chunks the row already has, if any.
            this.db.prepare('UPDATE documents SET hash = ?, failed_attempts = ?, tried_hash = ? WHERE id = ?').run(hash, attempts, hash, docId);
            console.error(`[RAG] ${filename}: indexing failed ${attempts} times in a row (${why}). Giving up until reindexEmbeddings runs or the file changes.`);
            this._notify({
                type: 'rag_ingest_failed',
                severity: 'warning',
                title: `A document could not be indexed: ${filename}`,
                message: `Indexing failed ${attempts} times in a row (${why}). The nightly scan will not try again until the file changes; run reindexEmbeddings once the cause is fixed. Search keeps whatever chunks this file already had, if any.`,
                metadata: { filename, attempts, link: '/system' }
            });
            return;
        }
        this.db.prepare('UPDATE documents SET hash = NULL, failed_attempts = ?, tried_hash = ? WHERE id = ?').run(attempts, hash, docId);
        console.warn(`[RAG] ${filename}: ${why}; it will be indexed again on the next scan (attempt ${attempts}${cap > 0 ? ` of ${cap}` : ''}).`);
    }

    /**
     * Chunk, embed and store one file's content under docId.
     * Media files get one multimodal vector, PDFs text chunks plus one native
     * vector, everything else text chunks.
     * @returns {Promise<{failed:number}>} embeddings that still failed after retries
     */
    async _indexContent(docId, filepath, buffer) {
        const filename = path.basename(filepath);
        const ext = path.extname(filepath).toLowerCase();
        const mediaType = this._getMediaType(ext);

        // === Path A: Media files (image/audio/video) — one embedding per file, no chunking ===
        if (mediaType) {
            const fileSize = buffer.length;
            if (fileSize > MAX_MULTIMODAL_SIZE) {
                console.warn(`[RAG] Skipping multimodal embedding for ${filename}: ${(fileSize / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_MULTIMODAL_SIZE / 1024 / 1024}MB limit.`);
                return { failed: 0 };
            }

            console.log(`[RAG] Embedding ${mediaType.type} file: ${filename} (${(fileSize / 1024).toFixed(0)}KB)...`);
            try {
                const embedding = await this._withRetry(() => this._getMultimodalEmbedding(filepath, mediaType.mimeType), `${mediaType.type} ${filename}`);
                const vectorBuf = Buffer.from(new Float32Array(embedding).buffer);

                const insertResult = this.db.prepare('INSERT INTO chunks (document_id, content, embedding, chunk_index, content_type) VALUES (?, ?, ?, ?, ?)')
                    .run(docId, `[${mediaType.type.toUpperCase()}] ${filename}`, vectorBuf, 0, mediaType.type);

                // Insert into vec0 (but NOT FTS — media has no text content)
                if (this.useVec) {
                    try {
                        this.db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)').run(insertResult.lastInsertRowid, vectorBuf);
                    } catch (e) {
                        console.warn(`[RAG] vec0 insert failed for ${filename}:`, e.message);
                    }
                }
                console.log(`[RAG] Multimodal ingestion complete for ${filename}.`);
            } catch (e) {
                console.error(`[RAG] Failed to embed ${mediaType.type} ${filename}:`, e.message);
                return { failed: 1 };
            }
            return { failed: 0 };
        }

        // === Path B: PDF files — text extraction for FTS + native multimodal embedding ===
        if (ext === '.pdf') {
            let text = '';
            let parser;
            try {
                const { PDFParse } = require('pdf-parse');
                parser = new PDFParse({ data: buffer });
                const data = await parser.getText();
                text = data.text;
            } catch (pdfErr) {
                console.error(`[RAG] Failed to parse PDF ${filename}:`, pdfErr);
                throw pdfErr;
            } finally {
                if (parser) {
                    await parser.destroy();
                }
            }

            // Embed text chunks for FTS + vector search
            const chunks = this._chunkText(text, 2000, 400);
            console.log(`[RAG] Embedding ${chunks.length} text chunks + native PDF embedding for ${filename}...`);
            let failed = await this._embedTextChunks(docId, chunks, 'text');

            // Additionally: native multimodal PDF embedding for better visual/layout understanding
            if (buffer.length <= MAX_MULTIMODAL_SIZE) {
                try {
                    const pdfEmbedding = await this._withRetry(() => this._getMultimodalEmbedding(filepath, 'application/pdf'), `PDF ${filename}`);
                    const vectorBuf = Buffer.from(new Float32Array(pdfEmbedding).buffer);
                    const insertResult = this.db.prepare('INSERT INTO chunks (document_id, content, embedding, chunk_index, content_type) VALUES (?, ?, ?, ?, ?)')
                        .run(docId, `[PDF] ${filename}`, vectorBuf, chunks.length, 'pdf');
                    if (this.useVec) {
                        try {
                            this.db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)').run(insertResult.lastInsertRowid, vectorBuf);
                        } catch (e) { }
                    }
                    console.log(`[RAG] Native PDF embedding added for ${filename}.`);
                } catch (e) {
                    console.warn(`[RAG] Native PDF embedding failed for ${filename} (text chunks still indexed):`, e.message);
                    failed++;
                }
            }

            console.log(`[RAG] Ingestion complete for ${filename}.`);
            return { failed };
        }

        // === Path C: Text files (default) — unchanged behavior ===
        const text = buffer.toString('utf-8');
        const chunks = this._chunkText(text, 2000, 400);

        console.log(`[RAG] Embedding ${chunks.length} chunks for ${filename}...`);
        const failed = await this._embedTextChunks(docId, chunks, 'text');
        console.log(`[RAG] Ingestion complete for ${filename}.`);
        return { failed };
    }

    /**
     * Run one embedding call up to this.embedRetries times. Waits
     * embedRetryBaseMs before the second try and doubles it each time.
     * Rethrows the last error.
     */
    async _withRetry(fn, label) {
        let lastError;
        for (let attempt = 1; attempt <= this.embedRetries; attempt++) {
            try {
                return await fn();
            } catch (e) {
                lastError = e;
                if (attempt < this.embedRetries) {
                    const delay = this.embedRetryBaseMs * 2 ** (attempt - 1);
                    console.warn(`[RAG] Embedding ${label} failed (try ${attempt}/${this.embedRetries}): ${e.message}. Retrying in ${delay}ms.`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        throw lastError;
    }

    /**
     * Embed text chunks and store them in chunks, FTS and vec0, at most
     * this.embedConcurrency calls in flight. Shared by PDF text (Path B) and
     * plain text (Path C).
     * @returns {Promise<number>} chunks that still failed after retries
     */
    async _embedTextChunks(docId, chunks, contentType = 'text') {
        let failed = 0;
        let next = 0;
        const worker = async () => {
            while (next < chunks.length) {
                const idx = next++;
                const chunk = chunks[idx];
                try {
                    const embedding = await this._withRetry(() => this._getEmbedding(chunk, 'RETRIEVAL_DOCUMENT'), `chunk ${idx}`);
                    this._storeTextChunk(docId, chunk, embedding, idx, contentType);
                } catch (e) {
                    failed++;
                    console.error(`[RAG] Failed to embed chunk ${idx} after ${this.embedRetries} tries:`, e.message);
                }
            }
        };
        const workers = Math.min(this.embedConcurrency, chunks.length);
        await Promise.all(Array.from({ length: workers }, worker));
        return failed;
    }

    _storeTextChunk(docId, chunk, embedding, chunkIndex, contentType) {
        const vectorBuf = Buffer.from(new Float32Array(embedding).buffer);
        const insertResult = this.db.prepare('INSERT INTO chunks (document_id, content, embedding, chunk_index, content_type) VALUES (?, ?, ?, ?, ?)')
            .run(docId, chunk, vectorBuf, chunkIndex, contentType);

        // Insert into FTS (text chunks only)
        if (contentType === 'text') {
            this.db.prepare('INSERT INTO chunks_fts (content, chunk_index, document_id) VALUES (?, ?, ?)')
                .run(chunk, chunkIndex, docId);
        }

        // Insert into vec0 if available
        if (this.useVec) {
            try {
                this.db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)').run(insertResult.lastInsertRowid, vectorBuf);
            } catch (e) {
                console.warn(`[RAG] vec0 insert failed for chunk ${chunkIndex}:`, e.message);
            }
        }
    }

    async deleteDocument(filename, vaultId) {
        const doc = this.db.prepare('SELECT id FROM documents WHERE filename = ? AND vault_id = ?').get(filename, vaultId);
        if (doc) {
            console.log(`[RAG] Deleting document ${filename} (Vault: ${vaultId})`);
            this._deleteDocumentById(doc.id);
            return true;
        }
        return false;
    }

    /** Remove one document and everything that points at it. */
    _deleteDocumentById(docId) {
        // Delete from vec0 first (needs chunk IDs)
        if (this.useVec) {
            const chunkIds = this.db.prepare('SELECT id FROM chunks WHERE document_id = ?').all(docId);
            for (const c of chunkIds) {
                try { this.db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?').run(c.id); } catch (e) { }
            }
        }
        this.db.prepare('DELETE FROM chunks_fts WHERE document_id = ?').run(docId);
        this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(docId);
        this.db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
    }

    /**
     * Drop the index rows of files that are no longer on disk: the chunks,
     * their chunks_fts and chunks_vec rows, and the documents row. The scan
     * only ever added, so a deleted file stayed searchable for good
     * (specs/032, line 37).
     *
     * Only documents under `roots` are looked at, and the caller has already
     * checked each root is there. So an unmounted data volume prunes nothing.
     * RAG_PRUNE_MISSING=0 turns the pruning off; the value is read per call.
     *
     * @param {string[]} roots directories that exist right now
     * @returns {number} documents removed
     */
    pruneMissingDocuments(roots) {
        if (String(process.env.RAG_PRUNE_MISSING ?? '').trim() === '0') return 0;

        const dirs = (Array.isArray(roots) ? roots : [roots])
            .filter(Boolean)
            .map(dir => path.resolve(dir))
            .filter(dir => fs.existsSync(dir));
        if (dirs.length === 0) return 0;

        const under = (file) => dirs.some(dir => file === dir || file.startsWith(dir + path.sep));
        const rows = this.db.prepare('SELECT id, filepath, filename FROM documents').all();

        let removed = 0;
        for (const row of rows) {
            if (!row.filepath) continue;
            const file = path.resolve(row.filepath);
            if (!under(file)) continue;
            if (fs.existsSync(file)) continue;
            console.log(`[RAG] Pruning ${row.filename}: the file is gone.`);
            this._deleteDocumentById(row.id);
            removed++;
        }
        return removed;
    }

    listDocuments(vaultId) {
        let sql = 'SELECT d.id, d.filename, d.indexed_at, COUNT(c.id) as chunk_count FROM documents d LEFT JOIN chunks c ON d.id = c.document_id';
        const params = [];
        if (vaultId && vaultId !== 'all') {
            sql += ' WHERE d.vault_id = ?';
            params.push(vaultId);
        }
        sql += ' GROUP BY d.id ORDER BY d.indexed_at DESC';
        return this.db.prepare(sql).all(...params);
    }

    async scanAndIngest(vaultsDir, { fromReindex = false } = {}) {
        if (this.reindexPromise && !fromReindex) {
            console.log('[RAG] Re-index in progress. Skipping scan.');
            return;
        }
        if (this.isScanning) {
            console.log('[RAG] Scan already in progress. Skipping.');
            return;
        }
        this.isScanning = true;
        let processed = 0;

        try {
            if (!fs.existsSync(vaultsDir)) {
                console.log(`[RAG] Vaults directory not found: ${vaultsDir}`);
                return;
            }

            console.log('[RAG] Starting Nightly Scan...');
            const vaults = fs.readdirSync(vaultsDir).filter(f => fs.statSync(path.join(vaultsDir, f)).isDirectory());

            for (const vault of vaults) {
                const filesDir = path.join(vaultsDir, vault, 'files');
                if (fs.existsSync(filesDir)) {
                    const files = fs.readdirSync(filesDir);
                    for (const file of files) {
                        const filePath = path.join(filesDir, file);
                        try {
                            await this.ingestDocument(filePath, vault);
                            processed++;
                        } catch (e) {
                            console.error(`[RAG] Failed to ingest ${file} in vault ${vault}:`, e.message);
                        }
                    }
                }

                // Ingest all .md pages in vault root (index.md + other pages)
                const vaultDir = path.join(vaultsDir, vault);
                const vaultEntries = fs.readdirSync(vaultDir);
                for (const entry of vaultEntries) {
                    if (entry.endsWith('.md')) {
                        const mdPath = path.join(vaultDir, entry);
                        try {
                            await this.ingestDocument(mdPath, vault);
                            processed++;
                        } catch (e) {
                            console.error(`[RAG] Failed to ingest ${entry} in vault ${vault}:`, e.message);
                        }
                    }
                }
            }
            const pruned = this.pruneMissingDocuments([vaultsDir]);
            console.log(`[RAG] Scan complete. ${processed} files checked, ${pruned} deleted files dropped from the index.`);

            if (this.agent && this.agent.interface && this.agent.interface.broadcast) {
                const stats = this.getStats();
                this.agent.interface.broadcast('rag:stats', stats).catch(e => console.error('[RAG] Broadcast failed:', e.message));
            }

        } catch (e) {
            console.error('[RAG] Scan failed:', e);
        } finally {
            this.isScanning = false;
        }
    }

    /**
     * Scan journal directory and ingest daily summaries into RAG.
     * Skips files under 200 chars (system-only noise like "No messages found").
     */
    async scanJournals(journalDir, { fromReindex = false } = {}) {
        if (this.reindexPromise && !fromReindex) {
            console.log('[RAG] Re-index in progress. Skipping journal scan.');
            return;
        }
        if (!fs.existsSync(journalDir)) {
            console.log(`[RAG] Journal directory not found: ${journalDir}`);
            return;
        }

        const files = fs.readdirSync(journalDir).filter(f => f.endsWith('.md'));
        let ingested = 0;
        let skipped = 0;

        for (const file of files) {
            const filePath = path.join(journalDir, file);
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                if (content.length < 200) {
                    skipped++;
                    continue;
                }
                await this.ingestDocument(filePath, 'journal');
                ingested++;
            } catch (e) {
                console.error(`[RAG] Failed to ingest journal ${file}:`, e.message);
            }
        }

        const pruned = this.pruneMissingDocuments([journalDir]);
        console.log(`[RAG] Journal scan complete. ${ingested} ingested, ${skipped} skipped (too short), ${pruned} deleted days dropped from the index.`);
    }

    /**
     * The vaults the owner marked private. A search over everything skips
     * them; a search that names a vault does not. VAULT_PRIVACY=0 turns the
     * whole idea off, and the value is read on every call.
     * @returns {string[]}
     */
    privateVaultIds() {
        if (String(process.env.VAULT_PRIVACY ?? '').trim() === '0') return [];
        try {
            const db = this.agent?.db;
            return typeof db?.getPrivateVaultIds === 'function' ? db.getPrivateVaultIds() : [];
        } catch (e) {
            console.warn('[RAG] Could not read the private vault list:', e.message);
            return [];
        }
    }

    /**
     * @param {string} query
     * @param {string|null} vaultId one vault, or null for every vault
     * @param {number} limit
     * @param {number} minScore
     *
     * With no vaultId the search skips the vaults marked private: searchMemory
     * runs on every turn, and the owner's medical notes should not answer a
     * question nobody asked about them. Naming the vault still reaches it.
     */
    async search(query, vaultId = null, limit = 5, minScore = 0.3) {
        const skip = vaultId ? [] : this.privateVaultIds();
        console.log(`[RAG] Hybrid Searching for: "${query}" (Vault: ${vaultId || 'Global'}, minScore: ${minScore}${skip.length ? `, skipping ${skip.length} private` : ''})`);
        const queryEmbedding = await this._getEmbedding(query, 'RETRIEVAL_QUERY');

        if (this.useVec) {
            return this._searchWithVec(queryEmbedding, query, vaultId, limit, minScore, skip);
        }
        return this._searchBruteForce(queryEmbedding, query, vaultId, limit, minScore, skip);
    }

    /**
     * ` AND (...)` that keeps private vaults out, with its parameters. A NULL
     * vault_id is a global document: `NULL NOT IN (...)` is NULL in SQL, so
     * the IS NULL arm has to be there or those rows would vanish.
     */
    _skipClause(column, skip) {
        if (!skip || skip.length === 0) return { sql: '', params: [] };
        const holes = skip.map(() => '?').join(', ');
        return { sql: ` AND (${column} IS NULL OR ${column} NOT IN (${holes}))`, params: [...skip] };
    }

    /**
     * Native vector search via sqlite-vec (KNN) + FTS boost.
     */
    _searchWithVec(queryEmbedding, query, vaultId, limit, minScore, skip = []) {
        const queryBuffer = Buffer.from(new Float32Array(queryEmbedding).buffer);
        const candidateLimit = limit * 4;

        // 1. Vector KNN search via vec0
        let vecSql = `
            SELECT cv.chunk_id, cv.distance,
                   c.content, c.chunk_index, c.document_id, c.content_type,
                   d.filename, d.vault_id
            FROM chunks_vec cv
            JOIN chunks c ON cv.chunk_id = c.id
            JOIN documents d ON c.document_id = d.id
            WHERE cv.embedding MATCH ?
        `;
        const params = [queryBuffer];
        if (vaultId) {
            vecSql += ' AND d.vault_id = ?';
            params.push(vaultId);
        } else {
            const skipClause = this._skipClause('d.vault_id', skip);
            vecSql += skipClause.sql;
            params.push(...skipClause.params);
        }
        vecSql += ` ORDER BY cv.distance LIMIT ?`;
        params.push(candidateLimit);

        let candidates;
        try {
            candidates = this.db.prepare(vecSql).all(...params);
        } catch (e) {
            console.warn('[RAG] vec0 search failed, falling back to brute force:', e.message);
            return this._searchBruteForce(queryEmbedding, query, vaultId, limit, minScore, skip);
        }

        // Convert distance to similarity score (vec0 uses L2 distance by default)
        // Cosine distance: 0 = identical, 2 = opposite. Convert: score = 1 - (distance / 2)
        const candidateScores = candidates.map(c => ({
            ...c,
            vScore: Math.max(0, 1 - (c.distance / 2))
        }));

        // 2. FTS boost on candidates
        const ftsMatches = this._ftsSearch(query);
        const ftsSet = new Set(ftsMatches.map(r => `${r.document_id}_${r.chunk_index}`));

        // 3. Combine scores
        const results = candidateScores.map(c => {
            const ftsBoost = ftsSet.has(`${c.document_id}_${c.chunk_index}`) ? 0.3 : 0;
            const score = (c.vScore * 0.7) + ftsBoost;
            return { ...c, score };
        });

        results.sort((a, b) => b.score - a.score);
        return results.filter(r => r.score >= minScore).slice(0, limit);
    }

    /**
     * Brute-force cosine similarity search (fallback when sqlite-vec unavailable).
     */
    _searchBruteForce(queryEmbedding, query, vaultId, limit, minScore, skip = []) {
        let vectorSql = 'SELECT chunks.id, chunks.content, chunks.embedding, chunk_index, document_id, chunks.content_type, documents.filename, documents.vault_id FROM chunks JOIN documents ON chunks.document_id = documents.id';
        const params = [];
        if (vaultId) {
            vectorSql += ' WHERE documents.vault_id = ? AND chunks.embedding IS NOT NULL';
            params.push(vaultId);
        } else {
            // Rows without a vector (cleared by a dimension change) cannot be scored.
            vectorSql += ' WHERE chunks.embedding IS NOT NULL';
            const skipClause = this._skipClause('documents.vault_id', skip);
            vectorSql += skipClause.sql;
            params.push(...skipClause.params);
        }

        const allChunks = this.db.prepare(vectorSql).all(...params);

        // Calculate cosine similarity for all chunks
        const vectorScores = new Map();
        allChunks.forEach(chunk => {
            const vector = new Float32Array(chunk.embedding.buffer, chunk.embedding.byteOffset, chunk.embedding.byteLength / 4);
            const score = this._cosineSimilarity(queryEmbedding, vector);
            vectorScores.set(chunk.id, score);
        });

        // FTS boost
        const ftsMatches = this._ftsSearch(query);
        const chunkLookup = new Map();
        allChunks.forEach(c => chunkLookup.set(`${c.document_id}_${c.chunk_index}`, c.id));

        const ftsScores = new Map();
        ftsMatches.forEach(res => {
            const key = `${res.document_id}_${res.chunk_index}`;
            const chunkId = chunkLookup.get(key);
            if (chunkId) ftsScores.set(chunkId, 1.0);
        });

        // Combine scores
        const finalResults = allChunks.map(chunk => {
            const vScore = Math.max(0, vectorScores.get(chunk.id) || 0);
            const fScore = ftsScores.get(chunk.id) || 0;
            const combined = (vScore * 0.7) + (fScore * 0.3);
            return { ...chunk, score: combined };
        });

        finalResults.sort((a, b) => b.score - a.score);
        return finalResults.filter(r => r.score >= minScore).slice(0, limit);
    }

    /**
     * Flexible FTS5 search: try phrase match first, fall back to OR tokens with prefix.
     */
    _ftsSearch(query) {
        const sanitizedQuery = query.replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
        if (sanitizedQuery.length <= 2) return [];

        // Try exact phrase match first
        try {
            const phraseResults = this.db.prepare(`
                SELECT document_id, chunk_index, rank
                FROM chunks_fts
                WHERE chunks_fts MATCH ?
                ORDER BY rank
                LIMIT 20
            `).all(`"${sanitizedQuery}"`);

            if (phraseResults.length > 0) return phraseResults;
        } catch (e) { }

        // Fall back to OR tokens with prefix matching
        const tokens = sanitizedQuery.split(/\s+/).filter(t => t.length > 2);
        if (tokens.length === 0) return [];

        try {
            const orQuery = tokens.map(t => `${t}*`).join(' OR ');
            return this.db.prepare(`
                SELECT document_id, chunk_index, rank
                FROM chunks_fts
                WHERE chunks_fts MATCH ?
                ORDER BY rank
                LIMIT 20
            `).all(orQuery);
        } catch (e) {
            console.warn('[RAG] FTS Search failed:', e.message);
            return [];
        }
    }

    _chunkText(text, size = 1000, overlap = 200) {
        const chunks = [];
        let start = 0;
        while (start < text.length) {
            const end = start + size;
            let chunk = text.substring(start, end);
            chunks.push(chunk);
            start += (size - overlap);
        }
        return chunks;
    }

    /**
     * Detect media type from file extension.
     * Returns { type, mimeType } or null for text files.
     */
    _getMediaType(ext) {
        for (const [type, config] of Object.entries(MEDIA_TYPES)) {
            if (config.extensions.includes(ext)) {
                return { type, mimeType: config.mimeMap[ext] };
            }
        }
        return null;
    }

    /**
     * Get embedding for a binary file (image, audio, video, PDF) using native multimodal support.
     * Reads the file, base64 encodes it, and sends as inlineData to the embedding API.
     */
    async _getMultimodalEmbedding(filepath, mimeType, taskType = 'RETRIEVAL_DOCUMENT') {
        const modelName = this.config.getModel('EMBEDDING');
        const fileBuffer = fs.readFileSync(filepath);
        const base64Data = fileBuffer.toString('base64');

        const config = { taskType };
        if (EMBEDDING_DIMENSIONS !== 3072) {
            config.outputDimensionality = EMBEDDING_DIMENSIONS;
        }

        try {
            const result = await this.agent.client.models.embedContent({
                model: modelName,
                contents: [{
                    parts: [{ inlineData: { mimeType, data: base64Data } }]
                }],
                config
            });

            this.config.logUsageFromResponse(this.agent.db, modelName, result, null, 'embedding');

            if (result.embeddings && result.embeddings.length > 0) {
                return result.embeddings[0].values;
            }
            if (result.embedding) {
                return result.embedding.values;
            }
            throw new Error('No embedding returned');
        } catch (error) {
            console.error(`[RAG] Multimodal embedding error for ${path.basename(filepath)}:`, error.message);
            throw error;
        }
    }

    async _getEmbedding(text, taskType = 'RETRIEVAL_DOCUMENT') {
        const modelName = this.config.getModel('EMBEDDING');
        try {
            const config = { taskType };

            // Pass outputDimensionality for models that support it (embedding-2+)
            if (EMBEDDING_DIMENSIONS !== 3072) {
                config.outputDimensionality = EMBEDDING_DIMENSIONS;
            }

            const result = await this.agent.client.models.embedContent({
                model: modelName,
                contents: [
                    {
                        parts: [
                            { text: text }
                        ]
                    }
                ],
                config
            });

            this.config.logUsageFromResponse(this.agent.db, modelName, result, null, 'embedding');

            if (result.embeddings && result.embeddings.length > 0) {
                return result.embeddings[0].values;
            }
            if (result.embedding) {
                return result.embedding.values;
            }
            throw new Error('No embedding returned');
        } catch (error) {
            console.error('[RAG] Embedding error:', error.message);
            throw error;
        }
    }

    _cosineSimilarity(a, b) {
        let dot = 0;
        let magA = 0;
        let magB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            magA += a[i] * a[i];
            magB += b[i] * b[i];
        }
        return dot / (Math.sqrt(magA) * Math.sqrt(magB));
    }

    getStats() {
        try {
            const docCount = this.db.prepare('SELECT COUNT(*) as count FROM documents').get().count;
            const chunkCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks').get().count;

            const vaults = this.db.prepare('SELECT vault_id, COUNT(*) as count FROM documents GROUP BY vault_id').all();
            const vaultStats = {};
            vaults.forEach(v => {
                vaultStats[v.vault_id || 'Global'] = v.count;
            });

            let sizeBytes = 0;
            try {
                const stat = fs.statSync(this.db.name);
                sizeBytes = stat.size;
            } catch (e) {
                sizeBytes = 0;
            }

            // Content type breakdown for multimodal stats
            const typeCounts = this.db.prepare('SELECT content_type, COUNT(*) as count FROM chunks GROUP BY content_type').all();
            const contentTypes = {};
            typeCounts.forEach(t => {
                contentTypes[t.content_type || 'text'] = t.count;
            });

            return {
                documents: docCount,
                chunks: chunkCount,
                vaults: vaultStats,
                contentTypes,
                sizeBytes,
                vectorSearchEnabled: this.useVec,
                embeddingModel: this.config.getModel('EMBEDDING'),
                embeddingDimensions: EMBEDDING_DIMENSIONS,
                needsReindex: this.needsReindex || false
            };
        } catch (e) {
            console.error('[RAG] Error getting stats:', e);
            return { error: e.message };
        }
    }
}

module.exports = { RagService, resolveDataDir };
