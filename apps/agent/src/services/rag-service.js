
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { ConfigService } = require('./config-service');

const EMBEDDING_DIMENSIONS = 768; // Gemini text-embedding-004

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
        // Try to load sqlite-vec extension for native vector search
        try {
            const sqliteVec = require('sqlite-vec');
            // sqliteVec.load() passes the full path (e.g. vec0.so) to db.loadExtension(),
            // but SQLite's C API appends the platform suffix automatically (.so on Linux),
            // causing a double extension (vec0.so.so). Fix: get the path and strip the
            // extension so SQLite can append it correctly.
            const loadablePath = sqliteVec.getLoadablePath();
            const extFreePath = loadablePath.replace(/\.(so|dylib|dll)$/, '');
            this.db.loadExtension(extFreePath);
            this.useVec = true;
            console.log('[RAG] sqlite-vec extension loaded successfully.');
        } catch (e) {
            console.warn('[RAG] sqlite-vec not available, falling back to in-memory cosine similarity:', e.message);
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
        `);

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

        let text = '';
        const ext = path.extname(filepath).toLowerCase();

        if (ext === '.pdf') {
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
        } else {
            text = buffer.toString('utf-8');
        }

        const chunks = this._chunkText(text, 1000, 200);

        // Insert Document if new
        let docId = existing ? existing.id : null;
        if (!docId) {
            const info = this.db.prepare('INSERT INTO documents (filepath, filename, hash, vault_id, indexed_at) VALUES (?, ?, ?, ?, ?)')
                .run(filepath, filename, hash, vaultId, new Date().toISOString());
            docId = info.lastInsertRowid;
        }

        console.log(`[RAG] Embedding ${chunks.length} chunks for ${filename}...`);

        // Process in batches of 10 to avoid rate limits
        for (let i = 0; i < chunks.length; i += 10) {
            const batch = chunks.slice(i, i + 10);
            await Promise.all(batch.map(async (chunk, idx) => {
                const globalIdx = i + idx;
                try {
                    const embedding = await this._getEmbedding(chunk, 'RETRIEVAL_DOCUMENT');
                    const vectorBuf = Buffer.from(new Float32Array(embedding).buffer);

                    const insertResult = this.db.prepare('INSERT INTO chunks (document_id, content, embedding, chunk_index) VALUES (?, ?, ?, ?)')
                        .run(docId, chunk, vectorBuf, globalIdx);

                    // Insert into FTS
                    this.db.prepare('INSERT INTO chunks_fts (content, chunk_index, document_id) VALUES (?, ?, ?)')
                        .run(chunk, globalIdx, docId);

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

        console.log(`[RAG] Ingestion complete for ${filename}.`);
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
                   c.content, c.chunk_index, c.document_id,
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
        let vectorSql = 'SELECT chunks.id, chunks.content, chunks.embedding, chunk_index, document_id, documents.filename, documents.vault_id FROM chunks JOIN documents ON chunks.document_id = documents.id';
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

    async _getEmbedding(text, taskType = 'RETRIEVAL_DOCUMENT') {
        const modelName = this.config.getModel('EMBEDDING');
        try {
            const result = await this.agent.client.models.embedContent({
                model: modelName,
                contents: [
                    {
                        parts: [
                            { text: text }
                        ]
                    }
                ],
                config: {
                    taskType: taskType
                }
            });

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

            return {
                documents: docCount,
                chunks: chunkCount,
                vaults: vaultStats,
                sizeBytes,
                vectorSearchEnabled: this.useVec
            };
        } catch (e) {
            console.error('[RAG] Error getting stats:', e);
            return { error: e.message };
        }
    }
}

module.exports = { RagService };
