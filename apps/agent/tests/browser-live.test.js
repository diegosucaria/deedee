const {
    BrowserLive, inputToCdp, normalizeUrl, pickPageTarget,
    SCREENCAST_PARAMS, WATCH_TTL_MS, RECONNECT_MS, MIN_FRAME_GAP_MS
} = require('../src/services/browser-live');

// ---- fakes -----------------------------------------------------------------

class FakeWebSocket {
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this.answered = new Set();
        this.autoAnswer = true;
        FakeWebSocket.instances.push(this);
    }
    send(raw) {
        const msg = JSON.parse(raw);
        this.sent.push(msg);
        // Answer every request on the next tick, like a real CDP endpoint.
        if (this.autoAnswer && msg.id !== undefined) setImmediate(() => this.answer(msg.id));
    }
    answer(id, result = {}) {
        if (this.answered.has(id) || this.readyState !== 1) return;
        this.answered.add(id);
        this.receive({ id, result });
    }
    close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        if (this.onclose) this.onclose({});
    }
    // test helpers
    open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
    receive(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
    methods() { return this.sent.map(m => m.method); }
}
FakeWebSocket.instances = [];

const flush = () => new Promise(r => setImmediate(r));

/** Timers driven by a test clock. */
function fakeTimers() {
    let now = 1_000_000;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + ms, every: null }); return id; },
        clearTimeout(id) { timers.delete(id); },
        setInterval(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + ms, every: ms }); return id; },
        clearInterval(id) { timers.delete(id); },
        async advance(ms) {
            const target = now + ms;
            for (;;) {
                let next = null;
                for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t };
                if (!next) break;
                now = next.t.at;
                if (next.t.every) next.t.at = now + next.t.every; else timers.delete(next.id);
                await next.t.fn();
                await flush();
            }
            now = target;
        },
        pending() { return timers.size; }
    };
}

function makeLive({ targets = [] } = {}) {
    FakeWebSocket.instances = [];
    const clock = fakeTimers();
    const state = { targets };
    const broadcast = jest.fn().mockResolvedValue(true);
    const mcp = {
        busy: false,
        isServerBusy: jest.fn(() => mcp.busy),
        callTool: jest.fn(async () => ({ output: 'ok' })),
        config: { browser: {} }
    };
    const agent = { interface: { broadcast }, mcp };
    const fetch = jest.fn(async () => ({ ok: true, json: async () => state.targets }));
    const live = new BrowserLive(agent, {
        WebSocket: FakeWebSocket, fetch, now: clock.now, timers: clock, port: 9222
    });
    return { live, clock, state, broadcast, mcp, fetch };
}

const PAGE = { type: 'page', url: 'https://example.test/a', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1' };

/** Starts a watch and completes the CDP handshake on the fake socket. */
async function watchAndOpen(live) {
    const p = live.watch('sock-1');
    await flush();
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.open();
    const result = await p;
    return { ws, result };
}

// ---- pure mapping ----------------------------------------------------------

describe('inputToCdp', () => {
    test('mouse move, press and release carry button and clickCount', () => {
        expect(inputToCdp({ type: 'mousemove', x: 10.4, y: 20.6 })).toEqual([
            { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 10, y: 21, modifiers: 0, button: 'none' } }
        ]);
        expect(inputToCdp({ type: 'mousedown', x: 1, y: 2, button: 'right', clickCount: 2 })).toEqual([
            { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 1, y: 2, modifiers: 0, button: 'right', clickCount: 2 } }
        ]);
        expect(inputToCdp({ type: 'mouseup', x: 1, y: 2 })[0].params).toMatchObject({ type: 'mouseReleased', button: 'left', clickCount: 1 });
    });

    test('drag keeps the pressed button on move', () => {
        expect(inputToCdp({ type: 'mousemove', x: 0, y: 0, pressed: true })[0].params.button).toBe('left');
    });

    test('wheel maps deltas', () => {
        expect(inputToCdp({ type: 'wheel', x: 5, y: 5, deltaX: 0, deltaY: 120 })[0].params).toEqual(
            { type: 'mouseWheel', x: 5, y: 5, modifiers: 0, deltaX: 0, deltaY: 120 });
    });

    test('printable text becomes Input.insertText and control bytes are dropped', () => {
        expect(inputToCdp({ type: 'text', text: 'héllo' })).toEqual([{ method: 'Input.insertText', params: { text: 'héllo' } }]);
        expect(inputToCdp({ type: 'text', text: '\n' })).toEqual([]);
    });

    test('Enter sends keyDown with text and keyUp with the Windows key code', () => {
        const msgs = inputToCdp({ type: 'key', key: 'Enter' });
        expect(msgs.map(m => m.method)).toEqual(['Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
        expect(msgs[0].params).toMatchObject({ type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        expect(msgs[1].params).toMatchObject({ type: 'keyUp', windowsVirtualKeyCode: 13 });
    });

    test('named keys use rawKeyDown and their codes; unknown keys are ignored', () => {
        const codes = { Tab: 9, Backspace: 8, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
        for (const [key, code] of Object.entries(codes)) {
            const [down] = inputToCdp({ type: 'key', key });
            expect(down.params).toMatchObject({ type: 'rawKeyDown', windowsVirtualKeyCode: code });
            expect(down.params.text).toBeUndefined();
        }
        expect(inputToCdp({ type: 'key', key: 'F5' })).toEqual([]);
        expect(inputToCdp({ type: 'nope' })).toEqual([]);
        expect(inputToCdp(null)).toEqual([]);
    });

    test('modifiers map to CDP bits', () => {
        expect(inputToCdp({ type: 'key', key: 'Tab', modifiers: { shift: true, ctrl: true } })[0].params.modifiers).toBe(10);
    });
});

describe('normalizeUrl and pickPageTarget', () => {
    test('adds https and rejects other schemes', () => {
        expect(normalizeUrl('example.test/x')).toBe('https://example.test/x');
        expect(normalizeUrl('http://a.test')).toBe('http://a.test/');
        expect(normalizeUrl('about:blank')).toBe('about:blank');
        expect(normalizeUrl('About:Blank')).toBe('about:blank');
        expect(normalizeUrl('about:flags')).toBeNull();
        expect(normalizeUrl('about:settings')).toBeNull();
        expect(normalizeUrl('chrome://history')).toBeNull();
        expect(normalizeUrl('javascript:alert(1)')).toBeNull();
        expect(normalizeUrl('file:///etc/passwd')).toBeNull();
        expect(normalizeUrl('')).toBeNull();
    });

    test('prefers the focused page target', () => {
        const a = { ...PAGE, url: 'a' };
        const b = { ...PAGE, url: 'b', focused: true };
        expect(pickPageTarget([{ type: 'service_worker', webSocketDebuggerUrl: 'ws://x' }, a, b])).toBe(b);
        expect(pickPageTarget([a])).toBe(a);
        expect(pickPageTarget([])).toBeNull();
        expect(pickPageTarget(null)).toBeNull();
    });
});

// ---- watcher gating --------------------------------------------------------

describe('BrowserLive watcher gating', () => {
    test('first watch connects and starts the screencast with the spec params', async () => {
        const { live, broadcast, fetch } = makeLive({ targets: [PAGE] });
        const { ws, result } = await watchAndOpen(live);

        expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:9222/json/list');
        expect(ws.url).toBe(PAGE.webSocketDebuggerUrl);
        expect(ws.methods()).toEqual(['Page.enable', 'Page.startScreencast']);
        expect(ws.sent[1].params).toEqual(SCREENCAST_PARAMS);
        expect(result).toMatchObject({ running: true, url: PAGE.url, agentBusy: false, watchers: 1, frame: null });
        expect(broadcast).toHaveBeenCalledWith('browser:status', { running: true, url: PAGE.url, agentBusy: false, watchers: 1 });
    });

    test('reports running:false and no socket when there is no page target', async () => {
        const { live, broadcast } = makeLive({ targets: [] });
        const result = await live.watch('s');
        expect(result).toMatchObject({ running: false, watchers: 1 });
        expect(FakeWebSocket.instances).toHaveLength(0);
        expect(broadcast).toHaveBeenCalledWith('browser:status', expect.objectContaining({ running: false }));
    });

    test('retries every 3 s while watched and attaches once a target appears', async () => {
        const { live, clock, state, fetch } = makeLive({ targets: [] });
        await live.watch('s');
        expect(fetch).toHaveBeenCalledTimes(1);
        state.targets = [PAGE];
        await clock.advance(RECONNECT_MS);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(FakeWebSocket.instances).toHaveLength(1);
        FakeWebSocket.instances[0].open();
        await flush(); await flush(); await flush();
        expect(live.status().running).toBe(true);
    });

    test('stops the screencast 30 s after the last ping and does not reconnect', async () => {
        const { live, clock, mcp } = makeLive({ targets: [PAGE] });
        const { ws } = await watchAndOpen(live);
        await clock.advance(20_000);
        await live.watch('sock-1'); // ping keeps it alive
        await clock.advance(20_000);
        expect(ws.readyState).toBe(1);
        expect(live.status().watchers).toBe(1);

        await clock.advance(WATCH_TTL_MS + 100);
        expect(ws.methods()).toContain('Page.stopScreencast');
        expect(ws.readyState).toBe(3);
        // Chromium keeps running after we detach; the next watch checks again.
        expect(live.status()).toMatchObject({ running: true, watchers: 0 });
        await clock.advance(RECONNECT_MS * 2);
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(clock.pending()).toBe(0);
        expect(mcp.callTool).not.toHaveBeenCalled();
    });

    test('reconnects with a 3 s backoff when the socket closes while watched', async () => {
        const { live, clock, broadcast } = makeLive({ targets: [PAGE] });
        const { ws } = await watchAndOpen(live);
        ws.close();
        await flush();
        expect(live.status().running).toBe(false);
        expect(broadcast).toHaveBeenCalledWith('browser:status', expect.objectContaining({ running: false }));
        expect(FakeWebSocket.instances).toHaveLength(1);
        await clock.advance(RECONNECT_MS);
        expect(FakeWebSocket.instances).toHaveLength(2);
    });

    test('counts distinct watchers and drops stale ones', async () => {
        const { live, clock } = makeLive({ targets: [PAGE] });
        await watchAndOpen(live);
        await live.watch('sock-2');
        expect(live.status().watchers).toBe(2);
        await clock.advance(WATCH_TTL_MS - 1000);
        await live.watch('sock-2');
        await clock.advance(2000);
        expect(live.status().watchers).toBe(1);
    });

    test('keeps the MCP idle timer alive every 5 min while watched', async () => {
        const { live, clock, mcp } = makeLive({ targets: [PAGE] });
        await watchAndOpen(live);
        // Ping every 10 s (like the web page) for 5 minutes.
        for (let i = 0; i < 30; i++) { await clock.advance(10_000); await live.watch('sock-1'); }
        expect(mcp.callTool).toHaveBeenCalledWith('browser_tabs', { action: 'list' });
        expect(mcp.callTool).toHaveBeenCalledTimes(1);
        expect(live.status().agentBusy).toBe(false);
    });

    test('a second watcher gets the last frame back', async () => {
        const { live } = makeLive({ targets: [PAGE] });
        const { ws } = await watchAndOpen(live);
        ws.receive({ method: 'Page.screencastFrame', params: { data: 'AAA', sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 800 } } });
        const result = await live.watch('sock-2');
        expect(result.frame).toEqual({ data: 'AAA', w: 1280, h: 800, url: PAGE.url });
    });
});

// ---- frames ----------------------------------------------------------------

describe('BrowserLive frames', () => {
    test('acks every frame and broadcasts at most 5 per second', async () => {
        const { live, clock, broadcast } = makeLive({ targets: [PAGE] });
        const { ws } = await watchAndOpen(live);
        broadcast.mockClear();
        const before = ws.sent.length;
        for (let i = 0; i < 10; i++) {
            ws.receive({ method: 'Page.screencastFrame', params: { data: `f${i}`, sessionId: i, metadata: { deviceWidth: 1280, deviceHeight: 800 } } });
            await clock.advance(50); // 20 fps in
        }
        const acks = ws.sent.slice(before).filter(m => m.method === 'Page.screencastFrameAck');
        expect(acks.map(a => a.params.sessionId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const frames = broadcast.mock.calls.filter(c => c[0] === 'browser:frame');
        expect(frames).toHaveLength(3); // at 0, 200 and 400 ms
        expect(frames.map(f => f[1].data)).toEqual(['f0', 'f4', 'f8']);
        expect(frames[0][1]).toEqual({ data: 'f0', w: 1280, h: 800, url: PAGE.url });
        expect(MIN_FRAME_GAP_MS).toBe(200);
    });

    test('top frame navigation updates the url in status', async () => {
        const { live, broadcast } = makeLive({ targets: [PAGE] });
        const { ws } = await watchAndOpen(live);
        ws.receive({ method: 'Page.frameNavigated', params: { frame: { id: 'f', url: 'https://example.test/b' } } });
        ws.receive({ method: 'Page.frameNavigated', params: { frame: { id: 'c', parentId: 'f', url: 'https://ads.test' } } });
        expect(live.status().url).toBe('https://example.test/b');
        expect(broadcast).toHaveBeenCalledWith('browser:status', expect.objectContaining({ url: 'https://example.test/b' }));
    });
});

// ---- input, navigate, start ------------------------------------------------

describe('BrowserLive input and navigation', () => {
    test('input sends the mapped CDP messages and waits for replies', async () => {
        const { live } = makeLive({ targets: [PAGE] });
        const { ws } = await watchAndOpen(live);
        expect(await live.input({ type: 'key', key: 'Enter' })).toEqual({ ok: true });
        const keys = ws.sent.filter(m => m.method === 'Input.dispatchKeyEvent');
        expect(keys).toHaveLength(2);
    });

    test('input without a connection reports an error; unknown events are ignored', async () => {
        const { live } = makeLive({ targets: [PAGE] });
        expect(await live.input({ type: 'mousemove', x: 1, y: 1 })).toEqual({ error: 'Browser not connected' });
        await watchAndOpen(live);
        expect(await live.input({ type: 'bogus' })).toEqual({ ignored: true });
    });

    test('navigate sends Page.navigate with the cleaned url and rejects bad schemes', async () => {
        const { live } = makeLive({ targets: [PAGE] });
        const { ws } = await watchAndOpen(live);
        expect(await live.navigate('javascript:x')).toEqual({ error: 'Only http, https and about:blank URLs are allowed' });
        expect(await live.navigate('example.test')).toEqual({ ok: true, url: 'https://example.test/' });
        expect(ws.sent[ws.sent.length - 1]).toMatchObject({ method: 'Page.navigate', params: { url: 'https://example.test/' } });
    });

    test('start launches through browser_navigate about:blank and then attaches', async () => {
        const { live, state, mcp } = makeLive({ targets: [] });
        await live.watch('s');
        mcp.callTool.mockImplementation(async () => { state.targets = [PAGE]; return { output: 'ok' }; });
        const p = live.start();
        await flush();
        await flush();
        const ws = FakeWebSocket.instances[0];
        ws.open();
        const result = await p;
        expect(mcp.callTool).toHaveBeenCalledWith('browser_navigate', { url: 'about:blank' });
        expect(result).toMatchObject({ running: true, url: PAGE.url });
    });

    test('start reports the MCP error', async () => {
        const { live, mcp } = makeLive({ targets: [] });
        mcp.callTool.mockRejectedValue(new Error('browser down'));
        expect(await live.start()).toEqual({ error: 'browser down' });
    });

    test('agentBusy mirrors a browser_ call in flight and is broadcast on change', async () => {
        const { live, clock, mcp, broadcast } = makeLive({ targets: [PAGE] });
        await watchAndOpen(live);
        mcp.busy = true;
        await clock.advance(1000);
        expect(live.status().agentBusy).toBe(true);
        expect(broadcast).toHaveBeenCalledWith('browser:status', expect.objectContaining({ agentBusy: true }));
        mcp.busy = false;
        await clock.advance(1000);
        expect(broadcast).toHaveBeenLastCalledWith('browser:status', expect.objectContaining({ agentBusy: false }));
    });
});
