
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { ConfigService } = require('./config-service');

// Matryoshka dimensions supported by gemini-embedding-2-preview: 768, 1536, 3072
// Default 768 for backward compat with existing embeddings; set EMBEDDING_DIMENSIONS to upgrade
const EMBEDDING_DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS, 10) || 768;

// Max file size for multimodal embedding (base64 encoding adds ~33% overhead)
const MAX_MULTIMODAL_SIZE = 20 * 1024 * 1024; // 20MB

// Supported media types for native multimodal embedding via gemini-embedding-2-preview
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

class RagService {
    constructor(agent) {
        this.agent = agent;
        this.config = new ConfigService();
        this.dbPath = path.join(process.cwd(), 'data', 'rag.db');
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
        } else if (modelChanged) {
            // Model changed but dimensions same — embeddings from different models
            // are still comparable at the same dimension, but quality improves with re-indexing
            console.log(`[RAG] Embedding model changed: ${prevModel} → ${currentModel} (dimensions unchanged at ${currentDims}).`);
            console.log('[RAG] Existing embeddings remain valid. Re-index recommended for improved quality.');
            this.db.prepare("INSERT OR REPLACE INTO rag_metadata (key, value) VALUES ('embedding_model', ?)").run(currentModel);
            this.needsReindex = false;
        } else {
            this.needsReindex = false;
        }
    }

    /**
     * Force re-embed all documents. Call manually or after dimension change.
     * Clears all embeddings and hashes, then triggers a full scan.
     */
    async reindexAll(vaultsDir, journalDir) {
        console.log('[RAG] Starting full re-index...');

        // Clear all embeddings and hashes
        this.db.prepare('UPDATE chunks SET embedding = NULL').run();
        this.db.prepare("UPDATE documents SET hash = ''").run();

        // Recreate vec0
        if (this.useVec) {
            try { this.db.exec('DROP TABLE IF EXISTS chunks_vec'); } catch (e) { }
            try {
                this.db.exec(`
                    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
                        chunk_id INTEGER PRIMARY KEY,
                        embedding float[${EMBEDDING_DIMENSIONS}]
                    );
                `);
            } catch (e) {
                console.warn('[RAG] Failed to recreate vec0:', e.message);
            }
        }

        // Re-scan if directories provided
        if (vaultsDir) await this.scanAndIngest(vaultsDir);
        if (journalDir) await this.scanJournals(journalDir);

        console.log('[RAG] Full re-index complete.');
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
            // Re-index: delete old chunks (vec0 first, then chunks)
            if (this.useVec) {
                const oldChunkIds = this.db.prepare('SELECT id FROM chunks WHERE document_id = ?').all(existing.id);
                for (const c of oldChunkIds) {
                    try { this.db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?').run(c.id); } catch (e) { }
                }
            }
            this.db.prepare('DELETE FROM chunks_fts WHERE document_id = ?').run(existing.id);
            this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(existing.id);
            this.db.prepare('UPDATE documents SET hash = ?, vault_id = ?, indexed_at = ? WHERE id = ?')
                .run(hash, vaultId, new Date().toISOString(), existing.id);
            console.log(`[RAG] Re-indexing ${filename}...`);
        }

        const ext = path.extname(filepath).toLowerCase();
        const mediaType = this._getMediaType(ext);

        // Insert Document if new
        let docId = existing ? existing.id : null;
        if (!docId) {
            const info = this.db.prepare('INSERT INTO documents (filepath, filename, hash, vault_id, indexed_at) VALUES (?, ?, ?, ?, ?)')
                .run(filepath, filename, hash, vaultId, new Date().toISOString());
            docId = info.lastInsertRowid;
        }

        // === Path A: Media files (image/audio/video) — one embedding per file, no chunking ===
        if (mediaType) {
            const fileSize = buffer.length;
            if (fileSize > MAX_MULTIMODAL_SIZE) {
                console.warn(`[RAG] Skipping multimodal embedding for ${filename}: ${(fileSize / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_MULTIMODAL_SIZE / 1024 / 1024}MB limit.`);
                return;
            }

            console.log(`[RAG] Embedding ${mediaType.type} file: ${filename} (${(fileSize / 1024).toFixed(0)}KB)...`);
            try {
                const embedding = await this._getMultimodalEmbedding(filepath, mediaType.mimeType);
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
            }
            return;
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
            await this._embedTextChunks(docId, chunks, 'text');

            // Additionally: native multimodal PDF embedding for better visual/layout understanding
            if (buffer.length <= MAX_MULTIMODAL_SIZE) {
                try {
                    const pdfEmbedding = await this._getMultimodalEmbedding(filepath, 'application/pdf');
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
                }
            }

            console.log(`[RAG] Ingestion complete for ${filename}.`);
            return;
        }

        // === Path C: Text files (default) — unchanged behavior ===
        const text = buffer.toString('utf-8');
        const chunks = this._chunkText(text, 2000, 400);

        console.log(`[RAG] Embedding ${chunks.length} chunks for ${filename}...`);
        await this._embedTextChunks(docId, chunks, 'text');
        console.log(`[RAG] Ingestion complete for ${filename}.`);
    }

    /**
     * Embed text chunks and store in chunks table, FTS, and vec0.
     * Shared by PDF text extraction (Path B) and plain text (Path C).
     */
    async _embedTextChunks(docId, chunks, contentType = 'text') {
        for (let i = 0; i < chunks.length; i += 10) {
            const batch = chunks.slice(i, i + 10);
            await Promise.all(batch.map(async (chunk, idx) => {
                const globalIdx = i + idx;
                try {
                    const embedding = await this._getEmbedding(chunk, 'RETRIEVAL_DOCUMENT');
                    const vectorBuf = Buffer.from(new Float32Array(embedding).buffer);

                    const insertResult = this.db.prepare('INSERT INTO chunks (document_id, content, embedding, chunk_index, content_type) VALUES (?, ?, ?, ?, ?)')
                        .run(docId, chunk, vectorBuf, globalIdx, contentType);

                    // Insert into FTS (text chunks only)
                    if (contentType === 'text') {
                        this.db.prepare('INSERT INTO chunks_fts (content, chunk_index, document_id) VALUES (?, ?, ?)')
                            .run(chunk, globalIdx, docId);
                    }

                    // Insert into vec0 if available
                    if (this.useVec) {
                        try {
                            this.db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)').run(insertResult.lastInsertRowid, vectorBuf);
                        } catch (e) {
                            console.warn(`[RAG] vec0 insert failed for chunk ${globalIdx}:`, e.message);
                        }
                    }
                } catch (e) {
                    console.error(`[RAG] Failed to embed chunk ${globalIdx}:`, e.message);
                }
            }));
        }
    }

    async deleteDocument(filename, vaultId) {
        const doc = this.db.prepare('SELECT id FROM documents WHERE filename = ? AND vault_id = ?').get(filename, vaultId);
        if (doc) {
            console.log(`[RAG] Deleting document ${filename} (Vault: ${vaultId})`);
            // Delete from vec0 first (needs chunk IDs)
            if (this.useVec) {
                const chunkIds = this.db.prepare('SELECT id FROM chunks WHERE document_id = ?').all(doc.id);
                for (const c of chunkIds) {
                    try { this.db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?').run(c.id); } catch (e) { }
                }
            }
            this.db.prepare('DELETE FROM chunks_fts WHERE document_id = ?').run(doc.id);
            this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(doc.id);
            this.db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
            return true;
        }
        return false;
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

    async scanAndIngest(vaultsDir) {
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

                const indexFile = path.join(vaultsDir, vault, 'index.md');
                if (fs.existsSync(indexFile)) {
                    try {
                        await this.ingestDocument(indexFile, vault);
                        processed++;
                    } catch (e) {
                        console.error(`[RAG] Failed to ingest index.md in vault ${vault}:`, e.message);
                    }
                }
            }
            console.log(`[RAG] Scan complete. ${processed} files checked.`);

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
    async scanJournals(journalDir) {
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

        console.log(`[RAG] Journal scan complete. ${ingested} ingested, ${skipped} skipped (too short).`);
    }

    async search(query, vaultId = null, limit = 5, minScore = 0.3) {
        console.log(`[RAG] Hybrid Searching for: "${query}" (Vault: ${vaultId || 'Global'}, minScore: ${minScore})`);
        const queryEmbedding = await this._getEmbedding(query, 'RETRIEVAL_QUERY');

        if (this.useVec) {
            return this._searchWithVec(queryEmbedding, query, vaultId, limit, minScore);
        }
        return this._searchBruteForce(queryEmbedding, query, vaultId, limit, minScore);
    }

    /**
     * Native vector search via sqlite-vec (KNN) + FTS boost.
     */
    _searchWithVec(queryEmbedding, query, vaultId, limit, minScore) {
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
        }
        vecSql += ` ORDER BY cv.distance LIMIT ?`;
        params.push(candidateLimit);

        let candidates;
        try {
            candidates = this.db.prepare(vecSql).all(...params);
        } catch (e) {
            console.warn('[RAG] vec0 search failed, falling back to brute force:', e.message);
            return this._searchBruteForce(queryEmbedding, query, vaultId, limit, minScore);
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
    _searchBruteForce(queryEmbedding, query, vaultId, limit, minScore) {
        let vectorSql = 'SELECT chunks.id, chunks.content, chunks.embedding, chunk_index, document_id, chunks.content_type, documents.filename, documents.vault_id FROM chunks JOIN documents ON chunks.document_id = documents.id';
        const params = [];
        if (vaultId) {
            vectorSql += ' WHERE documents.vault_id = ?';
            params.push(vaultId);
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

module.exports = { RagService };
