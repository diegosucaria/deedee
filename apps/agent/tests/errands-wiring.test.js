/**
 * Errands touch shared places: the prompt, the voice tool list, the gate's
 * rules, the guardian history and the send path. Each check guards a fault
 * the first review found.
 */
const express = require('express');
const request = require('supertest');

jest.mock('axios');
const axios = require('axios');
const { getSystemInstruction, getTurnContext, ERRAND_RULES } = require('../src/prompts/system');
const { ConfirmationManager } = require('../src/confirmation-manager');
const { OUTWARD_RULES } = require('../src/services/approval-service');
const { SOURCE_KINDS } = require('../src/routes/guardian');
const { HttpInterface } = require('../src/http-interface');
const { createToolRouter } = require('../src/routes/tools');

describe('errands in shared places', () => {
    test('the errand rules ride only in his own chat\'s turn context, never in the shared prompt', () => {
        const prompt = getSystemInstruction('T', 'G', 'F', { dynamicInTurn: true });
        expect(prompt).not.toContain('startErrand');
        expect(getTurnContext({ dateString: 'T' })).not.toContain('ERRANDS');
        const own = getTurnContext({ dateString: 'T', errandRules: true, openErrands: ['#3 book with Alice: waiting for them'] });
        expect(own).toContain(ERRAND_RULES);
        expect(own).toContain('OPEN ERRANDS');
        expect(own).toContain('#3 book with Alice: waiting for them');
    });

    test('a voice call never gets the errand tools: they only work in his typed chat', async () => {
        const app = express();
        app.use(createToolRouter({ mcp: { getTools: async () => [] } }));
        const res = await request(app).get('/internal/tools');
        expect(res.statusCode).toBe(200);
        const names = res.body.tools.map(t => t.name);
        expect(names).toContain('sendMessage');
        for (const name of ['startErrand', 'answerErrand', 'listErrands']) expect(names).not.toContain(name);
    });

    test('starting or answering an errand is an outward action; cancelling one is not', () => {
        const rules = new ConfirmationManager({});
        expect(rules.check('startErrand', { contact: '5490000000002' })).toMatchObject({ requiresConfirmation: true, rule: 'errand-send' });
        expect(rules.check('answerErrand', { id: 1, action: 'say', text: 'hola' })).toMatchObject({ rule: 'errand-send' });
        expect(rules.check('answerErrand', { id: 1, action: 'cancel' }).requiresConfirmation).toBe(false);
        expect(OUTWARD_RULES.has('errand-send')).toBe(true);
    });

    test('the guardian history knows errand runs', () => {
        expect(SOURCE_KINDS).toContain('errand');
    });

    test('a frozen payload still reports a message that went out', async () => {
        axios.post.mockResolvedValue({ data: { success: true, messageId: 'W1' } });
        jest.spyOn(console, 'log').mockImplementation(() => { });
        const out = await new HttpInterface('http://interfaces:5000', 't').send(Object.freeze({ source: 'whatsapp', content: 'hola', metadata: { chatId: '15550100@s.whatsapp.net' } }));
        expect(out).toBe(true);
        console.log.mockRestore();
    });
});
