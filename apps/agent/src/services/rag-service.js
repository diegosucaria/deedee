
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const pdf = require('pdf-parse');
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
            const data = await pdf(buffer);
            text = data.text;
        } else {
            text = buffer.toString('utf-8');
        }

        // Chunking (Simple sliding window or paragraph based)
        // Let's use paragraph + overlap
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
                    const embedding = await this._getEmbedding(chunk);
                    // Store as Buffer (Float32Array)
                    const vectorApi = Buffer.from(new Float32Array(embedding).buffer);

                    this.db.prepare('INSERT INTO chunks (document_id, content, embedding, chunk_index) VALUES (?, ?, ?, ?)')
                        .run(docId, chunk, vectorApi, globalIdx);
                } catch (e) {
                    console.error(`[RAG] Failed to embed chunk ${globalIdx}:`, e.message);
                }
            }));
        }

        console.log(`[RAG] Ingestion complete for ${filename}.`);
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
        console.log(`[RAG] Searching for: "${query}" (Vault: ${vaultId || 'Global'})`);
        const queryEmbedding = await this._getEmbedding(query);

        // Fetch all chunks (Brute force for now)
        let sql = 'SELECT chunks.id, chunks.content, chunks.embedding, documents.filename, documents.vault_id FROM chunks JOIN documents ON chunks.document_id = documents.id';
        const params = [];

        if (vaultId) {
            sql += ' WHERE documents.vault_id = ?';
            params.push(vaultId);
        }

        const allChunks = this.db.prepare(sql).all(...params);

        const results = allChunks.map(chunk => {
            const vector = new Float32Array(chunk.embedding.buffer, chunk.embedding.byteOffset, chunk.embedding.byteLength / 4);
            const score = this._cosineSimilarity(queryEmbedding, vector);
            return { ...chunk, score };
        });

        // Sort descending
        results.sort((a, b) => b.score - a.score);

        return results.slice(0, limit);
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

    async _getEmbedding(text) {
        // Use text-embedding-004 ? Or what's current?
        const model = 'text-embedding-004';
        const result = await this.agent.client.embedContent({
            model: model,
            content: { parts: [{ text }] }
        });
        return result.embedding.values;
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
