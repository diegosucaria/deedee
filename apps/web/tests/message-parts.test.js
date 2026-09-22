// The parts view in Message History. The faults it guards against: a row of
// base64 filling the screen, a JSON string that will not parse taking the page
// down, a tool call whose name or arguments go missing.
const { describeParts, parseParts, stripBlobs, prettyJson, clipBody, MEDIA_MARKER } = require('../src/lib/message-parts.js');

describe('parseParts', () => {
    test('a JSON string and an array both come back as an array', () => {
        expect(parseParts('[{"text":"hi"}]')).toEqual([{ text: 'hi' }]);
        expect(parseParts([{ text: 'hi' }])).toEqual([{ text: 'hi' }]);
    });

    test('anything else is empty, never a throw', () => {
        for (const none of [null, undefined, '', '   ', 'not json', '{"a":1}', 42]) {
            expect(parseParts(none)).toEqual([]);
        }
    });
});

describe('stripBlobs', () => {
    test('an image argument becomes a marker', () => {
        expect(stripBlobs({ prompt: 'a cat', image_base64: 'AAAABBBBCCCC' }))
            .toEqual({ prompt: 'a cat', image_base64: MEDIA_MARKER });
    });

    test('an inline blob keeps its type and loses its bytes', () => {
        expect(stripBlobs({ mimeType: 'image/png', data: 'AAAA' }))
            .toEqual({ mimeType: 'image/png', data: MEDIA_MARKER });
    });

    test('a blob nested in a tool result is found too', () => {
        expect(stripBlobs({ items: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }))
            .toEqual({ items: [{ inlineData: MEDIA_MARKER }] });
    });

    test('ordinary text is left alone', () => {
        const value = { name: 'Alice', count: 3, ok: true, when: null };
        expect(stripBlobs(value)).toEqual(value);
    });

    test('a very deep object still returns', () => {
        let deep = { end: true };
        for (let i = 0; i < 40; i++) deep = { next: deep };
        expect(() => stripBlobs(deep)).not.toThrow();
    });
});

describe('prettyJson', () => {
    test('arguments come out indented', () => {
        expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    });

    test('nothing comes out empty', () => {
        expect(prettyJson(null)).toBe('');
        expect(prettyJson(undefined)).toBe('');
    });

    test('a cycle does not throw', () => {
        const loop = { name: 'x' };
        loop.self = loop;
        expect(() => prettyJson(loop)).not.toThrow();
    });
});

describe('describeParts', () => {
    test('a tool call keeps its name and its arguments', () => {
        const [row] = describeParts('[{"functionCall":{"name":"sendMessage","args":{"to":"Alice"}}}]');
        expect(row.kind).toBe('call');
        expect(row.name).toBe('sendMessage');
        expect(row.body).toContain('"to": "Alice"');
    });

    test('a tool result keeps its name and its response', () => {
        const [row] = describeParts([{ functionResponse: { name: 'getTime', response: { time: 'noon' } } }]);
        expect(row.kind).toBe('result');
        expect(row.name).toBe('getTime');
        expect(row.body).toContain('"time": "noon"');
    });

    test('an image in a tool call is a marker, not a wall of base64', () => {
        const long = 'A'.repeat(50000);
        const [row] = describeParts([{ functionCall: { name: 'editPhoto', args: { image_base64: long } } }]);
        expect(row.body).toContain(MEDIA_MARKER);
        expect(row.body).not.toContain('AAAAAAAAAA');
        expect(row.body.length).toBeLessThan(200);
    });

    test('an inline image part says what it was', () => {
        const [row] = describeParts([{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }]);
        expect(row).toEqual({ kind: 'media', name: 'image/png', body: MEDIA_MARKER });
    });

    test('text and a thought are told apart', () => {
        const rows = describeParts([{ text: 'hello' }, { text: 'hmm', thought: true }]);
        expect(rows.map(r => r.kind)).toEqual(['text', 'thought']);
        expect(rows[0].body).toBe('hello');
    });

    test('a nameless tool call still renders', () => {
        const [row] = describeParts([{ functionCall: { args: {} } }]);
        expect(row.name).toBe('unnamed tool');
        expect(row.kind).toBe('call');
    });

    test('a part of an unknown shape is shown, not dropped', () => {
        const rows = describeParts([{ somethingNew: 1 }]);
        expect(rows).toHaveLength(1);
        expect(rows[0].kind).toBe('other');
        expect(rows[0].body).toContain('somethingNew');
    });

    test('no parts, no rows', () => {
        expect(describeParts(null)).toEqual([]);
        expect(describeParts('broken json')).toEqual([]);
    });
});

describe('clipBody', () => {
    test('a short body is shown whole, with nothing hidden', () => {
        expect(clipBody('one\ntwo')).toEqual({ head: 'one\ntwo', hidden: 0 });
    });

    test('a long body keeps a first screenful and counts the rest', () => {
        const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
        const { head, hidden } = clipBody(body, 12);
        expect(head.split('\n')).toHaveLength(12);
        expect(hidden).toBe(18);
    });

    test('nothing at all is still a string', () => {
        expect(clipBody(undefined)).toEqual({ head: '', hidden: 0 });
    });
});
