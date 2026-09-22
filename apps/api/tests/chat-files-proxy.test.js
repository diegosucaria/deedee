/**
 * POST /v1/chat/:id/files streams a multipart upload to the agent with raw
 * http, so the axios interceptor that adds the internal token never runs. It
 * used to forward the caller's own header, the api token, which the agent
 * refuses now that every agent route but /health wants the internal token.
 */
const http = require('http');
const request = require('supertest');

describe('the chat file upload proxy carries the internal token', () => {
    let agentStub, seen, app;
    const saved = { api: process.env.DEEDEE_API_TOKEN, internal: process.env.DEEDEE_INTERNAL_TOKEN, url: process.env.AGENT_URL };

    beforeAll(async () => {
        seen = [];
        agentStub = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (d) => chunks.push(d));
            req.on('end', () => {
                seen.push({ url: req.url, authorization: req.headers.authorization, contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            });
        });
        await new Promise((r) => agentStub.listen(0, '127.0.0.1', r));
        process.env.DEEDEE_API_TOKEN = 'api-token-for-callers';
        process.env.DEEDEE_INTERNAL_TOKEN = 'internal-token-for-the-agent';
        process.env.AGENT_URL = `http://127.0.0.1:${agentStub.address().port}`;
        jest.resetModules();
        ({ app } = require('../src/server'));
    });

    afterAll(async () => {
        await new Promise((r) => agentStub.close(r));
        for (const [k, v] of [['DEEDEE_API_TOKEN', saved.api], ['DEEDEE_INTERNAL_TOKEN', saved.internal], ['AGENT_URL', saved.url]]) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    });

    test('the agent sees the internal token, not the api token the web sent, and the multipart body intact', async () => {
        const res = await request(app)
            .post('/v1/chat/chat-1/files')
            .set('Authorization', 'Bearer api-token-for-callers')
            .attach('file', Buffer.from('hello'), 'note.txt');
        expect(res.statusCode).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0].url).toBe('/v1/chat/chat-1/files');
        expect(seen[0].authorization).toBe('Bearer internal-token-for-the-agent');
        expect(seen[0].contentType).toMatch(/^multipart\/form-data; boundary=/);
        // The body reached the agent whole: the file's name and its bytes.
        expect(seen[0].body).toContain('filename="note.txt"');
        expect(seen[0].body).toContain('hello');
    });
});
