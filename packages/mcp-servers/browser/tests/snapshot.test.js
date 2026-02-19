/**
 * Tests for Browser V2 — Snapshot Engine
 */

const {
    parseAriaSnapshot,
    assignRefs,
    compactTree,
    renderTree,
    createRoleNameTracker,
    INTERACTIVE_ROLES,
    CONTENT_ROLES,
    STRUCTURAL_ROLES,
} = require('../src/snapshot');

// Mock the state module (snapshot.js imports storeRefs)
jest.mock('../src/state', () => ({
    storeRefs: jest.fn(),
}));

describe('Snapshot Engine', () => {
    describe('parseAriaSnapshot', () => {
        test('should parse a simple ARIA tree', () => {
            const input = [
                '- heading "Welcome" [level=1]',
                '- textbox "Email"',
                '- button "Submit"',
            ].join('\n');

            const tree = parseAriaSnapshot(input);
            expect(tree).toHaveLength(3);
            expect(tree[0]).toMatchObject({ role: 'heading', name: 'Welcome' });
            expect(tree[0].attrs).toEqual({ level: '1' });
            expect(tree[1]).toMatchObject({ role: 'textbox', name: 'Email' });
            expect(tree[2]).toMatchObject({ role: 'button', name: 'Submit' });
        });

        test('should parse nested children', () => {
            const input = [
                '- navigation "Main":',
                '  - link "Home"',
                '  - link "About"',
                '- main:',
                '  - heading "Title" [level=1]',
            ].join('\n');

            const tree = parseAriaSnapshot(input);
            expect(tree).toHaveLength(2);
            expect(tree[0].role).toBe('navigation');
            expect(tree[0].children).toHaveLength(2);
            expect(tree[0].children[0]).toMatchObject({ role: 'link', name: 'Home' });
            expect(tree[1].role).toBe('main');
            expect(tree[1].children).toHaveLength(1);
        });

        test('should handle empty input', () => {
            expect(parseAriaSnapshot('')).toEqual([]);
            expect(parseAriaSnapshot(null)).toEqual([]);
            expect(parseAriaSnapshot(undefined)).toEqual([]);
        });

        test('should handle text content nodes', () => {
            const input = '- text: "Hello World"';
            const tree = parseAriaSnapshot(input);
            expect(tree).toHaveLength(1);
            expect(tree[0]).toMatchObject({ role: 'text', name: 'Hello World', isText: true });
        });

        test('should parse deeply nested structures', () => {
            const input = [
                '- main:',
                '  - group:',
                '    - list:',
                '      - listitem:',
                '        - link "Item 1"',
            ].join('\n');

            const tree = parseAriaSnapshot(input);
            expect(tree).toHaveLength(1);
            expect(tree[0].children[0].children[0].children[0].children[0])
                .toMatchObject({ role: 'link', name: 'Item 1' });
        });
    });

    describe('assignRefs', () => {
        test('should assign refs to interactive elements', () => {
            const tree = [
                { role: 'heading', name: 'Title', children: [] },
                { role: 'textbox', name: 'Email', children: [] },
                { role: 'button', name: 'Submit', children: [] },
            ];

            const { refs } = assignRefs(tree);
            const refKeys = Object.keys(refs);

            // heading gets a ref (content role with name), textbox and button get refs
            expect(refKeys.length).toBe(3);
            expect(refs.e1).toMatchObject({ role: 'heading', name: 'Title' });
            expect(refs.e2).toMatchObject({ role: 'textbox', name: 'Email' });
            expect(refs.e3).toMatchObject({ role: 'button', name: 'Submit' });
        });

        test('should assign refs only to interactive elements when interactiveOnly', () => {
            const tree = [
                { role: 'heading', name: 'Title', children: [] },
                { role: 'textbox', name: 'Email', children: [] },
            ];

            const { refs } = assignRefs(tree, { interactiveOnly: true });
            const refKeys = Object.keys(refs);

            // heading is content, not interactive — should NOT get a ref
            expect(refKeys.length).toBe(1);
            expect(refs.e1).toMatchObject({ role: 'textbox', name: 'Email' });
        });

        test('should NOT assign refs to structural roles', () => {
            const tree = [
                { role: 'generic', name: '', children: [] },
                { role: 'group', name: '', children: [] },
                { role: 'button', name: 'Click', children: [] },
            ];

            const { refs } = assignRefs(tree);
            expect(Object.keys(refs).length).toBe(1);
            expect(refs.e1).toMatchObject({ role: 'button', name: 'Click' });
        });

        test('should handle duplicate role+name with nth', () => {
            const tree = [
                { role: 'button', name: 'Delete', children: [] },
                { role: 'button', name: 'Delete', children: [] },
                { role: 'button', name: 'Save', children: [] },
            ];

            const { refs } = assignRefs(tree);

            // First Delete: nth=0, Second Delete: nth=1, Save: no nth
            expect(refs.e1).toMatchObject({ role: 'button', name: 'Delete' });
            expect(refs.e1.nth).toBe(0);
            expect(refs.e2).toMatchObject({ role: 'button', name: 'Delete' });
            expect(refs.e2.nth).toBe(1);
            expect(refs.e3).toMatchObject({ role: 'button', name: 'Save' });
            expect(refs.e3.nth).toBeUndefined();
        });

        test('should skip text nodes', () => {
            const tree = [
                { role: 'text', name: 'Hello', isText: true, children: [] },
                { role: 'button', name: 'OK', children: [] },
            ];

            const { refs } = assignRefs(tree);
            expect(Object.keys(refs).length).toBe(1);
            expect(refs.e1).toMatchObject({ role: 'button', name: 'OK' });
        });
    });

    describe('compactTree', () => {
        test('should prune branches without refs', () => {
            const tree = [
                {
                    role: 'group', name: '', children: [
                        { role: 'generic', name: '', children: [] },
                    ]
                },
                {
                    role: 'main', name: '', children: [
                        { role: 'button', name: 'Click', ref: 'e1', children: [] },
                    ]
                },
            ];

            const compacted = compactTree(tree);
            expect(compacted).toHaveLength(1); // group pruned, main kept
            expect(compacted[0].role).toBe('main');
        });

        test('should keep structural nodes that lead to refs', () => {
            const tree = [
                {
                    role: 'navigation', name: 'Main', children: [
                        {
                            role: 'list', name: '', children: [
                                { role: 'link', name: 'Home', ref: 'e1', children: [] },
                            ]
                        },
                    ]
                },
            ];

            const compacted = compactTree(tree);
            expect(compacted).toHaveLength(1);
            expect(compacted[0].children).toHaveLength(1);
            expect(compacted[0].children[0].children[0].ref).toBe('e1');
        });

        test('should return empty for tree with no refs', () => {
            const tree = [
                { role: 'generic', name: '', children: [] },
                { role: 'group', name: '', children: [] },
            ];

            const compacted = compactTree(tree);
            expect(compacted).toHaveLength(0);
        });
    });

    describe('renderTree', () => {
        test('should render a tree with refs', () => {
            const tree = [
                { role: 'heading', name: 'Title', attrs: { level: '1' }, ref: 'e1', children: [] },
                { role: 'textbox', name: 'Email', attrs: {}, ref: 'e2', children: [] },
            ];

            const output = renderTree(tree);
            expect(output).toContain('heading "Title" [level=1] [ref=e1]');
            expect(output).toContain('textbox "Email" [ref=e2]');
        });

        test('should handle nested rendering with indentation', () => {
            const tree = [
                {
                    role: 'main', name: '', attrs: {}, children: [
                        { role: 'button', name: 'Go', attrs: {}, ref: 'e1', children: [] },
                    ]
                },
            ];

            const output = renderTree(tree);
            expect(output).toContain('- main');
            expect(output).toContain('  - button "Go" [ref=e1]');
        });
    });

    describe('createRoleNameTracker', () => {
        test('should track unique role+name without nth', () => {
            const tracker = createRoleNameTracker();
            const result = tracker.track('button', 'Submit');
            expect(result.nth).toBe(0);
            expect(result.isDuplicate).toBe(false);
        });

        test('should track duplicate role+name with nth', () => {
            const tracker = createRoleNameTracker();
            tracker.track('button', 'Delete');
            const second = tracker.track('button', 'Delete');
            expect(second.nth).toBe(1);
            expect(second.isDuplicate).toBe(true);
        });

        test('should clean non-duplicates', () => {
            const tracker = createRoleNameTracker();
            tracker.track('button', 'Submit');
            tracker.track('button', 'Delete');
            tracker.track('button', 'Delete');

            const refs = {
                e1: { role: 'button', name: 'Submit', nth: 0 },
                e2: { role: 'button', name: 'Delete', nth: 0 },
                e3: { role: 'button', name: 'Delete', nth: 1 },
            };

            tracker.cleanNonDuplicates(refs);
            expect(refs.e1.nth).toBeUndefined(); // Submit was unique, nth cleaned
            expect(refs.e2.nth).toBe(0);  // Delete had duplicates, nth preserved
            expect(refs.e3.nth).toBe(1);
        });
    });

    describe('Role Sets', () => {
        test('should classify common roles correctly', () => {
            expect(INTERACTIVE_ROLES.has('button')).toBe(true);
            expect(INTERACTIVE_ROLES.has('textbox')).toBe(true);
            expect(INTERACTIVE_ROLES.has('link')).toBe(true);
            expect(CONTENT_ROLES.has('heading')).toBe(true);
            expect(CONTENT_ROLES.has('img')).toBe(true);
            expect(STRUCTURAL_ROLES.has('generic')).toBe(true);
            expect(STRUCTURAL_ROLES.has('navigation')).toBe(true);
        });

        test('should not overlap between sets', () => {
            for (const role of INTERACTIVE_ROLES) {
                expect(CONTENT_ROLES.has(role)).toBe(false);
                expect(STRUCTURAL_ROLES.has(role)).toBe(false);
            }
            for (const role of CONTENT_ROLES) {
                expect(INTERACTIVE_ROLES.has(role)).toBe(false);
                expect(STRUCTURAL_ROLES.has(role)).toBe(false);
            }
        });
    });
});
