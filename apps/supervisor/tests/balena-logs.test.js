const { PassThrough } = require('stream');
const { BalenaLogs, balenaApiAvailable, journalSince, messageText } = require('../src/balena-logs');

const ENV = { BALENA_SUPERVISOR_ADDRESS: 'http://127.0.0.1:48484', BALENA_SUPERVISOR_API_KEY: 'key' };

function webStream(lines) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(lines.slice(0, 2).join('\n') + '\n'));
            controller.enqueue(encoder.encode(lines.slice(2).join('\n') + '\n'));
            controller.close();
        }
    });
}

describe('balena logs', () => {
    test('available only with the supervisor API address and key', () => {
        expect(balenaApiAvailable(ENV)).toBe(true);
        expect(balenaApiAvailable({ BALENA_SUPERVISOR_ADDRESS: 'x' })).toBe(false);
        expect(balenaApiAvailable({})).toBe(false);
    });

    test('journalSince turns durations and unix times into journal dates', () => {
        const now = Date.parse('2026-01-02T03:04:05Z');
        expect(journalSince('10m', now)).toBe('2026-01-02 02:54:05');
        expect(journalSince('1767323045', now)).toBe('2026-01-02 03:04:05');
        expect(journalSince('garbage', now)).toBeUndefined();
        expect(journalSince(undefined, now)).toBeUndefined();
    });

    test('messageText decodes byte arrays', () => {
        expect(messageText({ MESSAGE: [104, 105] })).toBe('hi');
        expect(messageText({ MESSAGE: 'plain' })).toBe('plain');
    });

    test('streams only the lines of the wanted containers, with a prefix for several', async () => {
        const calls = [];
        const fetchImpl = jest.fn(async (url, opts) => {
            calls.push({ url, opts });
            if (url.endsWith('/v2/containerId')) {
                return { ok: true, json: async () => ({ status: 'success', services: { agent: 'id-agent', api: 'id-api', web: 'id-web' } }) };
            }
            return {
                ok: true,
                body: webStream([
                    JSON.stringify({ CONTAINER_ID_FULL: 'id-agent', MESSAGE: 'agent line' }),
                    JSON.stringify({ _SYSTEMD_UNIT: 'host.service', MESSAGE: 'host line' }),
                    'not json',
                    JSON.stringify({ CONTAINER_ID_FULL: 'id-api', MESSAGE: [111, 107] })
                ])
            };
        });
        const out = new PassThrough();
        let text = '';
        out.on('data', (c) => { text += c.toString(); });
        const ended = new Promise((resolve) => out.on('end', resolve));

        const logs = new BalenaLogs({ env: ENV, fetchImpl });
        await logs.stream({ services: ['agent', 'api'], tail: 20, out });
        await ended;

        expect(text).toBe('[agent] agent line\n[api] ok\n');
        expect(calls[0].opts.headers.Authorization).toBe('Bearer key');
        const body = JSON.parse(calls[1].opts.body);
        expect(calls[1].url).toBe('http://127.0.0.1:48484/v2/journal-logs');
        expect(body).toMatchObject({ follow: true, format: 'json', count: 200 });
    });

    test('a followed stream sends a heartbeat until it stops', async () => {
        jest.useFakeTimers();
        try {
            const fetchImpl = jest.fn(async (url) => {
                if (url.endsWith('/v2/containerId')) {
                    return { ok: true, json: async () => ({ services: { agent: 'id-agent' } }) };
                }
                return { ok: true, body: new ReadableStream({ start() {} }) };
            });
            const out = new PassThrough();
            let text = '';
            out.on('data', (c) => { text += c.toString(); });
            const logs = new BalenaLogs({ env: ENV, fetchImpl });
            const handle = await logs.stream({ services: ['agent'], out });

            jest.advanceTimersByTime(31000);
            await Promise.resolve();
            expect(text).toBe('[SYSTEM] HEARTBEAT\n[SYSTEM] HEARTBEAT\n');

            handle.stop();
            jest.advanceTimersByTime(60000);
            await Promise.resolve();
            expect(text).toBe('[SYSTEM] HEARTBEAT\n[SYSTEM] HEARTBEAT\n');
        } finally {
            jest.useRealTimers();
        }
    });

    test('a journal stream that breaks ends the response and its heartbeat', async () => {
        jest.useFakeTimers();
        try {
            let fail;
            const fetchImpl = jest.fn(async (url) => {
                if (url.endsWith('/v2/containerId')) {
                    return { ok: true, json: async () => ({ services: { agent: 'id-agent' } }) };
                }
                return { ok: true, body: new ReadableStream({ start(controller) { fail = (e) => controller.error(e); } }) };
            });
            const out = new PassThrough();
            let text = '';
            out.on('data', (c) => { text += c.toString(); });
            const ended = new Promise((resolve) => out.on('end', resolve));
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const logs = new BalenaLogs({ env: ENV, fetchImpl });
            await logs.stream({ services: ['agent'], out });

            fail(new Error('connection reset'));
            jest.useRealTimers();
            await ended;
            warn.mockRestore();
            expect(out.writableEnded).toBe(true);
            expect(text).toBe('');
        } finally {
            jest.useRealTimers();
        }
    });

    test('an unknown service is a 404', async () => {
        const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ services: { agent: 'id' } }) }));
        const logs = new BalenaLogs({ env: ENV, fetchImpl });
        await expect(logs.stream({ services: ['nope'], out: new PassThrough() })).rejects.toMatchObject({ status: 404 });
    });
});
