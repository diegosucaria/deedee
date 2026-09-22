/**
 * docs/local-rag.md was written in January 2026 and the code moved on: it
 * named text-embedding-004 as the default, stated 768 numbers as fact, said
 * ~1000-character chunks and described a plain cosine search with no keyword
 * layer. docs/memory.md said the 3 AM job re-embeds MEMORY.md; it does not.
 * This test reads the code and holds the docs to it.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const LOCAL_RAG = read('docs/local-rag.md');
const MEMORY = read('docs/memory.md');
const RAG_SERVICE = read('apps/agent/src/services/rag-service.js');
const SCHEDULER = read('apps/agent/src/scheduler.js');

describe('the RAG docs say what the code does', () => {
    test('the embedding model named in the docs is the one the code defaults to', () => {
        const OLD = process.env.GEMINI_EMBEDDING_MODEL;
        delete process.env.GEMINI_EMBEDDING_MODEL;
        const { ConfigService } = require('../src/services/config-service');
        const model = new ConfigService().getModel('EMBEDDING');
        if (OLD === undefined) delete process.env.GEMINI_EMBEDDING_MODEL; else process.env.GEMINI_EMBEDDING_MODEL = OLD;

        expect(LOCAL_RAG).toContain(model);
        expect(LOCAL_RAG).not.toContain('text-embedding-004');
    });

    test('the chunk size in the docs is the one the code cuts with', () => {
        const calls = [...RAG_SERVICE.matchAll(/_chunkText\([^,]+,\s*(\d+),\s*(\d+)\)/g)]
            .map(m => ({ size: Number(m[1]), overlap: Number(m[2]) }));
        expect(calls.length).toBeGreaterThan(0);
        const sizes = new Set(calls.map(c => c.size));
        const overlaps = new Set(calls.map(c => c.overlap));
        expect(sizes.size).toBe(1);
        expect(overlaps.size).toBe(1);

        const size = [...sizes][0];
        const overlap = [...overlaps][0];
        expect(LOCAL_RAG).toContain(size.toLocaleString('en-US'));
        expect(LOCAL_RAG).toContain(String(overlap));
        expect(LOCAL_RAG).not.toMatch(/~1000 characters/);
    });

    test('the docs do not state one vector size as fact: the device sets it', () => {
        expect(RAG_SERVICE).toContain('process.env.EMBEDDING_DIMENSIONS');
        expect(LOCAL_RAG).toContain('EMBEDDING_DIMENSIONS');
        expect(LOCAL_RAG).toMatch(/1,536/);
    });

    test('the docs describe the keyword layer the search really has', () => {
        expect(RAG_SERVICE).toContain('_ftsSearch');
        expect(LOCAL_RAG).toMatch(/FTS5/);
        expect(LOCAL_RAG).toMatch(/0\.7/);
        expect(LOCAL_RAG).toMatch(/0\.3/);
    });

    test('the 3 AM job does not touch MEMORY.md, and the docs no longer say it does', () => {
        // The job's branch runs to the next job's branch, whatever order the jobs sit in.
        const job = SCHEDULER.slice(SCHEDULER.indexOf("sysJob.name === 'nightly_rag_scan'") + 1);
        const next = job.search(/sysJob\.name === '/);
        const body = next === -1 ? job : job.slice(0, next);
        expect(body).toContain('scanAndIngest');
        expect(body).toContain('scanJournals');
        expect(body).not.toContain('MEMORY.md');
        expect(body).not.toContain('syncFactsToMemory');

        const row = MEMORY.split('\n').find(l => l.includes('nightly_rag_scan'));
        expect(row).toBeDefined();
        expect(row).not.toContain('MEMORY.md');
    });
});
