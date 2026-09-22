/**
 * Ten vault Server Actions skipped `requireActionSession()` while their
 * neighbours called it. Middleware still stood in front of them, but they
 * were the only destructive actions that never re-checked a session the
 * owner had revoked. This reads actions.js and holds every vault action to
 * the same rule.
 */
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/app/actions.js'), 'utf8');

const VAULT_ACTIONS = [
    'getVaults', 'createVault', 'getVault', 'getVaultPage', 'updateVaultPage',
    'deleteVault', 'uploadVaultFile', 'deleteVaultFile', 'setVaultPrivate',
    'getVaultEmbeddings', 'deleteVaultEmbedding'
];

/** Every exported action in actions.js, with its body. */
function exportedActions(source) {
    const lines = source.split('\n');
    const heads = [];
    lines.forEach((line, i) => {
        const m = line.match(/^export async function (\w+)/);
        if (m) heads.push({ name: m[1], start: i });
    });
    return heads.map((head, i) => ({
        name: head.name,
        body: lines.slice(head.start, i + 1 < heads.length ? heads[i + 1].start : lines.length).join('\n')
    }));
}

describe('the vault Server Actions check the session', () => {
    const actions = exportedActions(SOURCE);
    const byName = new Map(actions.map(a => [a.name, a.body]));

    test('actions.js still parses into a list of actions', () => {
        expect(actions.length).toBeGreaterThan(100);
    });

    test.each(VAULT_ACTIONS)('%s calls requireActionSession', (name) => {
        const body = byName.get(name);
        expect(body).toBeDefined();
        expect(body).toContain('await requireActionSession();');
    });

    test('the guard runs before the action reaches the API', () => {
        for (const name of VAULT_ACTIONS) {
            const body = byName.get(name);
            const guard = body.indexOf('requireActionSession');
            const call = body.search(/fetchAPI\(|await fetch\(/);
            expect(guard).toBeGreaterThan(-1);
            if (call > -1) expect(guard).toBeLessThan(call);
        }
    });
});
