
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
    }

    async ingestDocument(filepath) {
        if (!fs.existsSync(filepath)) throw new Error('File not found');

        const buffer = fs.readFileSync(filepath);
        const hash = crypto.createHash('md5').update(buffer).digest('hex');
        const filename = path.basename(filepath);

        // Check deduplication
        const existing = this.db.prepare('SELECT * FROM documents WHERE filepath = ?').get(filepath);
        if (existing && existing.hash === hash) {
            console.log(`[RAG] Document ${filename} already indexed (unchanged).`);
            return;
        }

        if (existing) {
            // Re-index: delete old chunks
            this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(existing.id);
            this.db.prepare('UPDATE documents SET hash = ?, indexed_at = ? WHERE id = ?')
                .run(hash, new Date().toISOString(), existing.id);
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
            const info = this.db.prepare('INSERT INTO documents (filepath, filename, hash, indexed_at) VALUES (?, ?, ?, ?)')
                .run(filepath, filename, hash, new Date().toISOString());
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

    async search(query, limit = 5) {
        console.log(`[RAG] Searching for: "${query}"`);
        const queryEmbedding = await this._getEmbedding(query);

        // Fetch all chunks (Brute force for now)
        // Optimization: In standard prod, use pgvector or similar. 
        // For local SQLite < 100k chunks, JS brute force is surprisingly fast (ms).
        const allChunks = this.db.prepare('SELECT chunks.id, chunks.content, chunks.embedding, documents.filename FROM chunks JOIN documents ON chunks.document_id = documents.id').all();

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
}

module.exports = { RagService };
