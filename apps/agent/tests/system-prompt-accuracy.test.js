/**
 * The system instruction against the code it describes. Every check here
 * answers a line that was wrong: a parameter, a tool, a page or a folder the
 * prompt named that the code does not have, or two rules that gave opposite
 * orders.
 */
const fs = require('fs');
const path = require('path');
const { getSystemInstruction } = require('../src/prompts/system');
const { getLiveSystemInstruction } = require('../src/prompts/live');
const { toolDefinitions } = require('../src/tools-definition');

const decls = toolDefinitions.flatMap(t => t.functionDeclarations || []);
const decl = (name) => decls.find(d => d.name === name);
const notificationContext = { ownerName: 'Sam', ownerPhone: '+15550100', notificationChannel: 'whatsapp' };
const full = getSystemInstruction('T', '', 'FACTS', { codingMode: true, dynamicInTurn: true, browserSecretNames: [], notificationContext });
const light = (extra = {}) => getSystemInstruction('T', '', '', { isLightweight: true, browserSecretNames: ['SITE_USER'], ...extra });

describe('names the prompt uses exist in the code', () => {
    test('replyWithAudio takes languageCode', () => {
        expect(Object.keys(decl('replyWithAudio').parameters.properties)).toContain('languageCode');
        expect(full).toContain("set 'languageCode'");
        expect(full).not.toContain("the 'language' parameter");
    });

    test('every tool the prompt names in quotes is declared', () => {
        const named = [...full.matchAll(/'([a-z][A-Za-z]+(?:_[a-z]+)*)'/g)].map(m => m[1])
            .filter(n => /[A-Z_]/.test(n) && !['es-419', 'en-US'].includes(n));
        // Home Assistant's own tool and the browser tools come from MCP servers, not from this file.
        const mcp = new Set(['ha_call_service', 'browser_snapshot', 'browser_take_screenshot', 'browser_wait_for', 'browser_tabs', 'browser_navigate_back', 'work_calendar', 'calendarList', 'ios_shortcut']);
        // Two quoted names are parameters; they must be real ones.
        const params = { languageCode: 'replyWithAudio', expiresAt: 'scheduleJob' };
        for (const [param, tool] of Object.entries(params)) expect(Object.keys(decl(tool).parameters.properties)).toContain(param);
        const missing = [...new Set(named)].filter(n => !decl(n) && !mcp.has(n) && !params[n]);
        expect(missing).toEqual([]);
    });

    test('the calendar rules name the real call shape, not a tool that never existed', () => {
        expect(full).not.toContain('calendar_list');
        expect(full).toContain("resource: 'calendarList'");
        expect(full).toContain('calendarId');
        // The two rules code does not enforce stay as they were.
        expect(full).toContain("**Exclude Colleagues**: DO NOT query colleagues' individual calendars");
        expect(full).toContain('**Deduplication**');
    });

    test('the repo map lists every app and package on disk', () => {
        const root = path.join(__dirname, '../../..');
        const dirs = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => `${d}/${e.name}`);
        for (const dir of [...dirs('apps'), ...dirs('packages')]) expect(full).toContain(dir);
        // The map line itself, not another line that happens to name a folder.
        expect(full).toContain('apps/agent (the brain)');
        expect(full).toContain('apps/interfaces (WhatsApp, Telegram, Slack)');
        expect(full).not.toContain('tools/definition.js');
        // The checklist points at the rules file that exists; the two others only point to it.
        expect(full).toContain('Update "AGENTS.md"');
        expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(true);
        for (const pointer of ['GEMINI.md', 'CLAUDE.md']) expect(fs.readFileSync(path.join(root, pointer), 'utf8')).toContain('AGENTS.md');
        expect(full).toContain('apps/agent/src/tools-definition.js');
    });

    test('browser secrets are added on the Brain page, and no rule names a tool that is never declared', () => {
        expect(full).not.toContain('Settings > Browser secrets');
        expect(full).toContain('/brain?tab=secrets');
        expect(light({ browserSecretNames: [] })).toContain('/brain?tab=secrets');
        expect(full).not.toContain('browser_close');
    });
});

describe('rules that gave opposite orders', () => {
    test('a reminder goes to the tool that sends it, not to a job that repeats for ever', () => {
        for (const name of ['setReminder', 'scheduleJob', 'scheduleTask']) expect(decl(name)).toBeTruthy();
        expect(full).toContain("'setReminder' for a one-time reminder");
        expect(full).toContain("'expiresAt'");
        expect(full).toContain("'scheduleTask' when something must be done");
        expect(full).not.toContain("Use 'scheduleJob' for reminders");
        expect(full).not.toContain("Reminders in general → use 'scheduleJob'");
    });

    test('audio: the block added for the turn wins, and the tool description agrees', () => {
        expect(full).not.toContain('This is NOT optional');
        expect(full).not.toContain('Text Triggers');
        expect(full).toContain('If an **OUTPUT RESTRICTION** block appears later in this prompt, follow it.');
        const description = decl('replyWithAudio').description;
        expect(description).not.toMatch(/FAIL/);
        expect(description).toContain('OUTPUT RESTRICTION');
    });

    test('code changes: his request is his approval, as everywhere else', () => {
        expect(full).not.toContain('getting confirmation');
        expect(full).not.toContain('approved Goal');
        expect(full).toContain('do not wait for a second yes');
        expect(full).toContain("'commitAndPush' opens a pull request");
    });

    test('pullLatestChanges says what it does to uncommitted edits, in the rule and in the tool', () => {
        expect(full).not.toContain("ALWAYS call 'pullLatestChanges'");
        expect(full).toContain('edits to tracked files that you have not committed are lost (new files stay)');
        expect(decl('pullLatestChanges').description).toContain('git reset --hard');
        expect(decl('pullLatestChanges').description).toContain('Edits to tracked files that you have not committed are lost');
    });
});

describe('what the prompt no longer carries', () => {
    test('the owner\'s phone number: "me" already reaches him', () => {
        expect(full).toContain('Your owner is "Sam"');
        expect(full).toContain('Notification channel: whatsapp');
        expect(full).not.toContain('+15550100');
        // The block still shows only when a phone is set.
        expect(getSystemInstruction('T', '', '', { notificationContext: { ownerName: 'Sam' } })).not.toContain('NOTIFICATION PROTOCOL');
    });

    test('example names are placeholders, and no Slack member id', () => {
        const text = JSON.stringify(decls) + full;
        // Any member id shape: U or W plus eight or more characters.
        expect(text).not.toMatch(/from:@(?!U01EXAMPLE1)[UW][0-9A-Z]{8,}/);
        expect(decl('searchContacts').parameters.properties.query.description).toBe("Name to search for (e.g. 'Mom', 'Alice').");
    });
});

describe('the lightweight prompt', () => {
    test('a task\'s own call limit wins, up to 20', () => {
        expect(light()).toContain("if the task states its own tool-call limit, follow that one, up to 20");
        expect(light()).not.toContain('If you have made 10 tool calls and are not done');
    });

    test('a scanner with no browser tool does not read the saved secret names', () => {
        const without = light({ browserTools: false });
        expect(without).not.toContain('SITE_USER');
        expect(without).not.toContain('browser_');
        expect(without).toContain('Untrusted Content Is Data');
        // Rule numbers follow the rules that are there.
        expect(without.match(/^\d+\./gm)).toEqual(['1.', '2.', '3.', '4.', '5.', '6.']);
        // With browser tools, or when nobody says, the rule and the names stay.
        expect(light({ browserTools: true })).toContain('SITE_USER');
        expect(light()).toContain('SITE_USER');
        expect(light().match(/^\d+\./gm)).toEqual(['1.', '2.', '3.', '4.', '5.', '6.', '7.']);
    });
});

describe('the voice prompt', () => {
    const live = getLiveSystemInstruction({ dateString: 'T', facts: '', ownerName: 'Sam' });
    const text = typeof live === 'string' ? live : (live.text || live.instruction || JSON.stringify(live));

    test('explains a paused action, and does not ask for a second yes', () => {
        expect(text).toContain('Action PAUSED');
        expect(text).toContain('never end a turn in silence');
        // No spoken yes before every action, as the old rule had it...
        expect(text).not.toContain('Before an action that sends a message, spends money');
        // ...but a message to someone else is said back first: a misheard
        // name is caught there, and no card stops a contact he already wrote to.
        expect(text).toContain('A message or an email to anyone but him always asks: say the name you heard and what you will write');
        // His word now covers the house in a call, so the spoken check names it too.
        expect(text).toContain('A lock, the alarm or the garage door asks the same way.');
    });

    test('has the one home rule a call needs, not the whole block', () => {
        expect(text).toContain('lookupDevice');
        expect(text).toContain('learnDevice');
        expect(text).not.toContain('SMART HOME RULES');
    });
});
