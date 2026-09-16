const request = require('supertest');
const express = require('express');
const { createInternalRouter } = require('../src/routes/internal');

describe('Internal Router - browser live view', () => {
    let app;
    let agent;

    beforeEach(() => {
        agent = {
            db: {},
            browserLive: {
                watch: jest.fn().mockResolvedValue({ running: true, url: 'about:blank', agentBusy: false, watchers: 1, frame: null }),
                input: jest.fn().mockResolvedValue({ ok: true }),
                navigate: jest.fn().mockResolvedValue({ ok: true, url: 'https://example.test/' }),
                start: jest.fn().mockResolvedValue({ running: true, url: 'about:blank', agentBusy: false, watchers: 0 }),
                status: jest.fn().mockReturnValue({ running: false, url: null, agentBusy: false, watchers: 0 })
            }
        };
        app = express();
        app.use(express.json());
        app.use('/internal', createInternalRouter(agent));
    });

    test('POST watch passes the watcher id and returns the status', async () => {
        const res = await request(app).post('/internal/browser/live/watch').send({ watcherId: 'sock-1' });
        expect(res.status).toBe(200);
        expect(agent.browserLive.watch).toHaveBeenCalledWith('sock-1');
        expect(res.body).toMatchObject({ running: true, watchers: 1 });
    });

    test('POST input forwards the event and rejects a body without a type', async () => {
        const event = { type: 'mousedown', x: 1, y: 2, button: 'left', clickCount: 1 };
        const ok = await request(app).post('/internal/browser/live/input').send({ watcherId: 's', event });
        expect(ok.status).toBe(200);
        expect(agent.browserLive.input).toHaveBeenCalledWith(event);

        const bad = await request(app).post('/internal/browser/live/input').send({ event: { x: 1 } });
        expect(bad.status).toBe(400);
        expect(agent.browserLive.input).toHaveBeenCalledTimes(1);
    });

    test('POST input returns 409 when the browser is not connected', async () => {
        agent.browserLive.input.mockResolvedValue({ error: 'Browser not connected' });
        const res = await request(app).post('/internal/browser/live/input').send({ event: { type: 'mousemove', x: 0, y: 0 } });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'Browser not connected' });
    });

    test('POST navigate needs a url string', async () => {
        const ok = await request(app).post('/internal/browser/live/navigate').send({ url: 'example.test' });
        expect(ok.status).toBe(200);
        expect(agent.browserLive.navigate).toHaveBeenCalledWith('example.test');
        const bad = await request(app).post('/internal/browser/live/navigate').send({});
        expect(bad.status).toBe(400);
    });

    test('POST start and GET status call through', async () => {
        const start = await request(app).post('/internal/browser/live/start').send({});
        expect(start.status).toBe(200);
        expect(start.body.running).toBe(true);
        const status = await request(app).get('/internal/browser/live/status');
        expect(status.body).toEqual({ running: false, url: null, agentBusy: false, watchers: 0 });
    });

    test('returns 503 when the service is missing', async () => {
        delete agent.browserLive;
        const res = await request(app).get('/internal/browser/live/status');
        expect(res.status).toBe(503);
    });
});
