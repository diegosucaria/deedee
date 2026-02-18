
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
// const pdf = require('pdf-parse'); // Moved to lazy load
const { ConfigService } = require('./config-service');

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
        this._initDB();
    }

    _initDB() {
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
        // content is indexed for full text search
        // chunk_index, document_id are unindexed columns for join
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

        // Migration: Backfill FTS if empty but chunks exist (Avoid re-ingest if possible)
        try {
            const ftsCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks_fts').get().count;
            if (ftsCount === 0) {
                const chunksCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks').get().count;
                if (chunksCount > 0) {
                    console.log(`[RAG] Backfilling FTS index from ${chunksCount} existing chunks...`);
                    // Bulk insert
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
        } catch (e) {
            // Ignore if column exists
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
            // Re-index: delete old chunks
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
                // v2 API: new PDFParse({ data: buffer })
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

        // Chunking (Simple sliding window or paragraph based)
        // Paragraph-based chunking with overlap
        const chunks = this._chunkText(text, 1000, 200);

        // Insert Document if new
        let docId = existing ? existing.id : null;
        if (!docId) {
            const info = this.db.prepare('INSERT INTO documents (filepath, filename, hash, vault_id, indexed_at) VALUES (?, ?, ?, ?, ?)')
                .run(filepath, filename, hash, vaultId, new Date().toISOString());
            docId = info.lastInsertRowid;
        }

        // Embed and Insert Chunks
        // Batch embedding if possible? Gemini supports batch?
        // SDK: embedContent or batchEmbedContents
        console.log(`[RAG] Embedding ${chunks.length} chunks for ${filename}...`);

        // Process in batches of 10 to avoid rate limits
        for (let i = 0; i < chunks.length; i += 10) {
            const batch = chunks.slice(i, i + 10);
            await Promise.all(batch.map(async (chunk, idx) => {
                const globalIdx = i + idx;
                try {
                    const embedding = await this._getEmbedding(chunk, 'RETRIEVAL_DOCUMENT');
                    // Store as Buffer (Float32Array)
                    const vectorApi = Buffer.from(new Float32Array(embedding).buffer);

                    this.db.prepare('INSERT INTO chunks (document_id, content, embedding, chunk_index) VALUES (?, ?, ?, ?)')
                        .run(docId, chunk, vectorApi, globalIdx);

                    // Insert into FTS
                    this.db.prepare('INSERT INTO chunks_fts (content, chunk_index, document_id) VALUES (?, ?, ?)')
                        .run(chunk, globalIdx, docId);
                } catch (e) {
                    console.error(`[RAG] Failed to embed chunk ${globalIdx}:`, e.message);
                }
            }));
        }

        console.log(`[RAG] Ingestion complete for ${filename}.`);
    }

    async deleteDocument(filename, vaultId) {
        // Find document
        const doc = this.db.prepare('SELECT id FROM documents WHERE filename = ? AND vault_id = ?').get(filename, vaultId);
        if (doc) {
            console.log(`[RAG] Deleting document ${filename} (Vault: ${vaultId})`);
            // Cascade delete chunks
            this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(doc.id);
            this.db.prepare('DELETE FROM chunks_fts WHERE document_id = ?').run(doc.id);
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
        let added = 0;
        let updated = 0;

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
                            const result = await this.ingestDocument(filePath, vault);
                            processed++;
                            // ingestDocument currently returns nothing if unchanged, or undefined if success?
                            // I need to check ingestDocument return value.
                            // But for now let's just count processed.
                        } catch (e) {
                            console.error(`[RAG] Failed to ingest ${file} in vault ${vault}:`, e.message);
                        }
                    }
                }

                // Ingest the Wiki Page (index.md)
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

            // Broadcast update
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

    async search(query, vaultId = null, limit = 5) {
        console.log(`[RAG] Hybrid Searching for: "${query}" (Vault: ${vaultId || 'Global'})`);
        const queryEmbedding = await this._getEmbedding(query, 'RETRIEVAL_QUERY');

        // 1. Vector Search (Cosine Similarity)
        // Fetch All Chunks (Current Limitations of Better-Sqlite3 / No Vector Extension)
        let vectorSql = 'SELECT chunks.id, chunks.content, chunks.embedding, chunk_index, document_id, documents.filename, documents.vault_id FROM chunks JOIN documents ON chunks.document_id = documents.id';
        const params = [];
        if (vaultId) {
            vectorSql += ' WHERE documents.vault_id = ?';
            params.push(vaultId);
        }

        const allChunks = this.db.prepare(vectorSql).all(...params);

        // Calculate similarity and store in map
        const vectorScores = new Map(); // id -> score (0-1)

        allChunks.forEach(chunk => {
            const vector = new Float32Array(chunk.embedding.buffer, chunk.embedding.byteOffset, chunk.embedding.byteLength / 4);
            const score = this._cosineSimilarity(queryEmbedding, vector);
            vectorScores.set(chunk.id, score);
        });

        // 2. Keyword Search (FTS5) - BM25
        // FTS5 rank is negative (lower is better), so we need to inverse/normalize it?
        // FTS5 rank is negative (lower = better relevance)
        // Simple approach: SELECT *, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank
        // But matching constraint is tricky with joins if we need to filter by Vault.
        // We can select document_ids first?
        // FTS Table has (content, chunk_index, document_id)

        // Construct MATCH query. Sanitize query by removing special chars that break FTS syntax
        const sanitizedQuery = query.replace(/[^a-zA-Z0-9 ]/g, ' ').trim();

        const ftsScores = new Map(); // chunk table id?? No, chunks_fts rowid! 
        // Wait, proper mapping: 
        // We inserted into chunks_fts. Rowid might not match chunks.id unless we forced it?
        // We didn't force ROWID. 
        // But we stored `document_id` and `chunk_index`. This forms a unique composite key.
        // Map (document_id, chunk_index) composite key → chunks.id for FTS↔vector correlation
        const chunkLookup = new Map();
        allChunks.forEach(c => chunkLookup.set(`${c.document_id}_${c.chunk_index}`, c.id));

        if (sanitizedQuery.length > 2) {
            try {
                // simple OR query or phrase? Standard match using FTS5
                // We perform search and get unindexed cols
                const keywordResults = this.db.prepare(`
                    SELECT document_id, chunk_index, rank 
                    FROM chunks_fts 
                    WHERE chunks_fts MATCH ? 
                    ORDER BY rank 
                    LIMIT 20
                `).all(`"${sanitizedQuery}"`); // simple phrase search?

                // Normalize Rank: FTS rank is arbitrary magnitude. 
                // Apply flat +0.3 boost for keyword matches
                // Simpler: If it matches keyword, boost score by +0.3
                keywordResults.forEach(res => {
                    const key = `${res.document_id}_${res.chunk_index}`;
                    const chunkId = chunkLookup.get(key);
                    if (chunkId && vectorScores.has(chunkId)) {
                        ftsScores.set(chunkId, 1.0); // Binary boost for now, or use rank?
                    }
                });
            } catch (e) {
                console.warn('[RAG] FTS Search failed:', e.message);
            }
        }

        // 3. Combine Scores
        // Weight: 0.7 Vector + 0.3 Keyword
        // Note: Vector is Cosine (-1 to 1). We should clamp to 0-1?
        // FTS is binary 1.0 here.

        const finalResults = allChunks.map(chunk => {
            const vScore = Math.max(0, vectorScores.get(chunk.id) || 0); // Clamp negative
            const fScore = ftsScores.get(chunk.id) || 0;

            // Formula: Weighted Average
            // If FTS match, it's very significant.
            const combined = (vScore * 0.7) + (fScore * 0.3);

            return {
                ...chunk,
                score: combined,
                debug: { vScore, fScore }
            };
        });

        // Sort descending
        finalResults.sort((a, b) => b.score - a.score);

        return finalResults.slice(0, limit);
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
        // Use configured embedding model
        const modelName = this.config.getModel('EMBEDDING');
        try {
            // New SDK @google/genai uses client.models.embedContent
            // Note: signature is (config: { model, content, config: { taskType, title? } })
            // Wait, for taskType it is often inside 'config' or top level depending on method.
            // In @google/genai, it is:
            // client.models.embedContent({
            //   model: ...,
            //   contents: ...,
            //   config: { taskType: ... } 
            // })
            // Or properties directly. Checking docs logic. usually it is inside 'config' object or direct. 
            // In REST: "taskType": "..."
            // In SDK: usually top level options or config.
            // @google/genai SDK maps camelCase to snake_case for the API

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

            // Result structure for @google/genai: result.embeddings[0].values
            if (result.embeddings && result.embeddings.length > 0) {
                return result.embeddings[0].values;
            }
            // Fallback just in case
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

            // Vault distribution
            const vaults = this.db.prepare('SELECT vault_id, COUNT(*) as count FROM documents GROUP BY vault_id').all();
            const vaultStats = {};
            vaults.forEach(v => {
                vaultStats[v.vault_id || 'Global'] = v.count;
            });

            // DB Size
            let sizeBytes = 0;
            try {
                const stat = fs.statSync(this.db.name);
                sizeBytes = stat.size;
            } catch (e) {
                // If in-memory or error
                sizeBytes = 0;
            }

            return {
                documents: docCount,
                chunks: chunkCount,
                vaults: vaultStats,
                sizeBytes
            };
        } catch (e) {
            console.error('[RAG] Error getting stats:', e);
            return { error: e.message };
        }
    }
}

module.exports = { RagService };
