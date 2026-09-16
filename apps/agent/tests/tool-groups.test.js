const { filterToolsByGroups, ToolGroupMemory, mcpServerGroup, TOOL_GROUPS } = require('../src/services/tool-groups');

describe('filterToolsByGroups', () => {
    const internal = [
        { name: 'rememberFact', category: 'memory' },
        { name: 'sendMessage', category: 'communication' },
        { name: 'lookupDevice', category: 'smarthome' },
        { name: 'recommend_outfit', category: 'wardrobe' },
        { name: 'list_vinyls' } // no category → core
    ];
    const external = [
        { name: 'ha_call_service', serverName: 'homeassistant' },
        { name: 'work_gmail', serverName: 'gws_work' },
        { name: 'plex_play', serverName: 'plex' },
        { name: 'future_tool', serverName: 'some-new-server' }
    ];

    test('core only keeps uncategorised/core tools and unmapped servers', () => {
        const r = filterToolsByGroups(internal, external, []);
        expect(r.internalTools.map(t => t.name)).toEqual(['rememberFact', 'sendMessage', 'list_vinyls']);
        expect(r.externalTools.map(t => t.name)).toEqual(['future_tool']);
    });

    test('a group brings in both its internal category and its MCP servers', () => {
        const r = filterToolsByGroups(internal, external, ['home']);
        expect(r.internalTools.map(t => t.name)).toContain('lookupDevice');
        expect(r.externalTools.map(t => t.name)).toEqual(['ha_call_service', 'future_tool']);
    });

    test('the code group loads nothing extra yet: filesystem tools are core', () => {
        const fs = [{ name: 'runShellCommand', category: 'filesystem' }, { name: 'readFile', category: 'filesystem' }];
        expect(filterToolsByGroups(fs, [], []).internalTools.map(t => t.name)).toEqual(['runShellCommand', 'readFile']);
        expect(filterToolsByGroups(fs, [], ['code']).internalTools.map(t => t.name)).toEqual(['runShellCommand', 'readFile']);
        expect(TOOL_GROUPS.code).toContain('git');
    });

    test('every gws_* server maps to workspace', () => {
        expect(mcpServerGroup('gws_personal')).toBe('workspace');
        expect(mcpServerGroup('gws_anything')).toBe('workspace');
        expect(mcpServerGroup('unknown')).toBeNull();
    });
});

describe('ToolGroupMemory', () => {
    test('keeps a chat\'s recent groups for follow-ups, then forgets them', () => {
        const m = new ToolGroupMemory(1000);
        expect(m.merge('c1', ['home'], 0)).toEqual(['home']);
        expect(m.merge('c1', [], 500)).toEqual(['home']);
        expect(m.merge('c1', [], 2000)).toEqual([]);
    });

    test('ignores unknown group names and keeps chats apart', () => {
        const m = new ToolGroupMemory();
        expect(m.merge('c1', ['home', 'not-a-group'])).toEqual(['home']);
        expect(m.merge('c2', [])).toEqual([]);
        expect(Object.keys(TOOL_GROUPS)).toContain('workspace');
    });
});

describe('groupsNamedIn', () => {
    const { groupsNamedIn } = require('../src/services/tool-groups');
    test('maps named integrations to their groups', () => {
        expect(groupsNamedIn('puedes ver mis proximos turnos con el allende mcp?')).toEqual(['health']);
        expect(groupsNamedIn('Check Plex and my Gmail')).toEqual(['workspace', 'media']);
        expect(groupsNamedIn('turn on the Home Assistant lights')).toEqual(['home']);
        expect(groupsNamedIn('open the browser and check my bill')).toEqual(['browser']);
        expect(groupsNamedIn('use playwright to log in')).toEqual(['browser']);
        expect(mcpServerGroup('browser')).toBe('browser');
        expect(mcpServerGroup('browser-use')).toBeNull();
        expect(TOOL_GROUPS.browser).toContain('Playwright');
        expect(groupsNamedIn('hola, como estas?')).toEqual([]);
        expect(groupsNamedIn(undefined)).toEqual([]);
    });

    test('shell, git and repo name the code group, as whole words only', () => {
        expect(groupsNamedIn('fix the failing test in the repo and commit')).toEqual(['code']);
        expect(groupsNamedIn('run git status')).toEqual(['code']);
        expect(groupsNamedIn('open a shell and check disk space')).toEqual(['code']);
        expect(groupsNamedIn('Refactor the codebase, then push.')).toEqual(['code']);
        expect(groupsNamedIn('send me the digital report')).toEqual([]);
        expect(groupsNamedIn('is the seashell shop open?')).toEqual([]);
        const m = new ToolGroupMemory();
        expect(m.merge('c3', ['code'])).toEqual(['code']);
    });
});
