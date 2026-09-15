const { getSystemInstruction, getTurnContext } = require('../src/prompts/system');

describe('system prompt vs turn context', () => {
    const opts = { codingMode: true, skillsContext: 'SKILL-MARKER', vaultContext: 'VAULT-MARKER' };

    test('dynamicInTurn keeps per-message parts out of the system prompt', () => {
        const a = getSystemInstruction('TIME-MARKER', 'GOAL-MARKER', 'FACT-MARKER', { ...opts, dynamicInTurn: true });
        const b = getSystemInstruction('OTHER-TIME', 'OTHER-GOAL', 'FACT-MARKER', { ...opts, dynamicInTurn: true });
        for (const marker of ['TIME-MARKER', 'GOAL-MARKER', 'SKILL-MARKER', 'VAULT-MARKER']) {
            expect(a).not.toContain(marker);
        }
        expect(a).toContain('FACT-MARKER');
        // Same facts, different time/goals → identical prompt, so the prefix cache can hit.
        expect(a).toBe(b);
    });

    test('without dynamicInTurn the prompt keeps everything (Grok path)', () => {
        const p = getSystemInstruction('TIME-MARKER', 'GOAL-MARKER', 'FACT-MARKER', opts);
        for (const marker of ['TIME-MARKER', 'GOAL-MARKER', 'FACT-MARKER', 'SKILL-MARKER', 'VAULT-MARKER']) {
            expect(p).toContain(marker);
        }
    });

    test('getTurnContext carries time, location, goals, skills and vault', () => {
        const t = getTurnContext({ dateString: 'TIME-MARKER', activeGoals: 'GOAL-MARKER', skillsContext: 'SKILL-MARKER', vaultContext: 'VAULT-MARKER', location: 'LOC-MARKER' });
        for (const marker of ['TIME-MARKER', 'GOAL-MARKER', 'SKILL-MARKER', 'VAULT-MARKER', 'LOC-MARKER']) {
            expect(t).toContain(marker);
        }
        expect(t.startsWith('[TURN CONTEXT')).toBe(true);
    });

    test('browser secret names appear as names only, in the turn context or the prompt', () => {
        const t = getTurnContext({ dateString: 'T', browserSecretNames: ['SITE_USER', 'SITE_PASSWORD'] });
        expect(t).toContain('BROWSER SECRETS (type these names exactly): SITE_USER, SITE_PASSWORD');
        expect(getTurnContext({ dateString: 'T', browserSecretNames: [] })).toContain('BROWSER SECRETS: none saved');
        expect(getTurnContext({ dateString: 'T' })).not.toContain('BROWSER SECRETS');

        const full = getSystemInstruction('T', 'G', 'F', { dynamicInTurn: true, browserSecretNames: ['SITE_USER'] });
        expect(full).toContain('BROWSER PROTOCOL');
        expect(full).toContain('askUser');
        expect(full).toContain('/browser');
        expect(full).not.toContain('browser_use');
        expect(full).not.toContain('SITE_USER'); // names live in the turn context here

        const grok = getSystemInstruction('T', 'G', 'F', { dynamicInTurn: false, browserSecretNames: ['SITE_USER'] });
        expect(grok).toContain('BROWSER SECRETS (type these names exactly): SITE_USER');

        const light = getSystemInstruction('T', 'G', 'F', { isLightweight: true, browserSecretNames: ['SITE_USER'] });
        expect(light).toContain('SITE_USER');
    });
});
