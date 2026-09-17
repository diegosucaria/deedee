/**
 * Read helpers for the #233 columns: what fills the prompt, cost by the tag as
 * written, and how often the cached prefix moves.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');
const { AgentDB } = require('../src/db');
const { createInternalRouter } = require('../src/routes/internal');

describe('prompt composition, raw tags and prefix churn', () => {
    let db, tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-comp-'));
        db = new AgentDB(tmpDir);
    });

    afterEach(() => {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const log = (row) => db.logTokenUsage({
        model: 'gemini-3.6-flash', promptTokens: 1000, candidateTokens: 10, totalTokens: 1010,
        chatId: 'web-1', estimatedCost: 0.01, ...row
    });

    test('getPromptComposition averages the estimates by tag and model', () => {
        log({ tag: 'chat', promptTokens: 1000, sysTokensEst: 100, toolsTokensEst: 400, historyTokensEst: 500, declCount: 40 });
        log({ tag: 'chat', promptTokens: 2000, sysTokensEst: 200, toolsTokensEst: 600, historyTokensEst: 1100, declCount: 60 });
        log({ tag: 'chat_tool_loop', promptTokens: 3000, sysTokensEst: 100, toolsTokensEst: 400, historyTokensEst: 2400, declCount: 40 });

        const rows = db.getPromptComposition(null, null, 1);
        const chat = rows.find(r => r.tag === 'chat');
        expect(chat).toMatchObject({ model: 'gemini-3.6-flash', calls: 2 });
        expect(chat.prompt_tokens).toBe(1500);
        expect(chat.sys_tokens).toBe(150);
        expect(chat.tools_tokens).toBe(500);
        expect(chat.history_tokens).toBe(800);
        expect(chat.decl_count).toBe(50);

        const loop = rows.find(r => r.tag === 'chat_tool_loop');
        expect(loop.calls).toBe(1);
        expect(loop.history_tokens).toBe(2400);
    });

    test('rows written before the columns existed are left out', () => {
        log({ tag: 'chat' }); // no estimates at all
        log({ tag: 'chat', sysTokensEst: 100, toolsTokensEst: 200, historyTokensEst: 300, declCount: 10 });
        const rows = db.getPromptComposition(null, null, 1);
        expect(rows).toHaveLength(1);
        expect(rows[0].calls).toBe(1);
    });

    test('an untagged row is grouped as untagged', () => {
        log({ tag: null, sysTokensEst: 1, toolsTokensEst: 2, historyTokensEst: 3, declCount: 4 });
        expect(db.getPromptComposition(null, null, 1)[0].tag).toBe('untagged');
    });

    test('getCostByRawTag keeps a turn and its tool loop apart', () => {
        log({ tag: 'chat', estimatedCost: 1 });
        log({ tag: 'chat', estimatedCost: 2 });
        log({ tag: 'chat_tool_loop', estimatedCost: 5 });
        log({ tag: 'tts', estimatedCost: 0.5 });
        // No tag: falls back to the chat_id classification.
        log({ tag: null, chatId: '123@s.us', estimatedCost: 0.25 });

        const rows = db.getCostByRawTag(null, null, 1);
        const byTag = Object.fromEntries(rows.map(r => [r.tag, r]));
        expect(byTag.chat).toMatchObject({ cost: 3, calls: 2 });
        expect(byTag.chat_tool_loop).toMatchObject({ cost: 5, calls: 1 });
        expect(byTag.tts.cost).toBe(0.5);
        expect(byTag.whatsapp.cost).toBe(0.25);
        // Most expensive first.
        expect(rows[0].tag).toBe('chat_tool_loop');
    });

    test('untagged rows keep their chat_id classes apart', () => {
        log({ tag: null, chatId: '000@s.us', estimatedCost: 1 });
        log({ tag: null, chatId: 'web-1', estimatedCost: 2 });
        log({ tag: null, chatId: 'system_nightly_dream_1', estimatedCost: 4 });
        log({ tag: null, chatId: 'subagent-7', estimatedCost: 8 });

        const rows = db.getCostByRawTag(null, null, 1);
        const byTag = Object.fromEntries(rows.map(r => [r.tag, r]));
        expect(rows).toHaveLength(4);
        expect(byTag.whatsapp).toMatchObject({ cost: 1, calls: 1 });
        expect(byTag.web_chat).toMatchObject({ cost: 2, calls: 1 });
        expect(byTag.system_job).toMatchObject({ cost: 4, calls: 1 });
        expect(byTag.subagent).toMatchObject({ cost: 8, calls: 1 });
    });

    test('getPrefixChurn counts turns and changes per day', () => {
        db.logMetric('prefix_hash', 0, { chatId: 'web-1' });
        db.logMetric('prefix_hash', 1, { chatId: 'web-1' });
        db.logMetric('prefix_hash', 1, { chatId: 'web-2' });
        db.logMetric('latency_model', 1200, { chatId: 'web-1' });

        const rows = db.getPrefixChurn(null, null, 1);
        expect(rows).toHaveLength(1);
        expect(rows[0].turns).toBe(3);
        expect(rows[0].changed).toBe(2);
        expect(rows[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('the three routes answer with the rows', async () => {
        log({ tag: 'chat', sysTokensEst: 100, toolsTokensEst: 200, historyTokensEst: 300, declCount: 10 });
        db.logMetric('prefix_hash', 1, { chatId: 'web-1' });

        const app = express();
        app.use(express.json());
        app.use('/internal', createInternalRouter({ db }));

        const comp = await request(app).get('/internal/stats/prompt-composition?days=1');
        expect(comp.status).toBe(200);
        expect(comp.body[0]).toMatchObject({ tag: 'chat', calls: 1 });

        const raw = await request(app).get('/internal/stats/cost-by-raw-tag?days=1');
        expect(raw.status).toBe(200);
        expect(raw.body[0].tag).toBe('chat');

        const churn = await request(app).get('/internal/stats/prefix-churn?days=1');
        expect(churn.status).toBe(200);
        expect(churn.body[0]).toMatchObject({ turns: 1, changed: 1 });
    });

    test('the routes answer 503 without a database', async () => {
        const app = express();
        app.use('/internal', createInternalRouter({}));
        for (const route of ['prompt-composition', 'cost-by-raw-tag', 'prefix-churn']) {
            expect((await request(app).get(`/internal/stats/${route}`)).status).toBe(503);
        }
    });
});
