/**
 * BrowserLive: a live view of the browser the MCP server runs.
 *
 * It speaks raw CDP over the global WebSocket to Chromium's debug port (the
 * `--remote-debugging-port` in playwright-mcp.config.json). While at least one
 * watcher pings it, it streams JPEG frames through `interface.broadcast`
 * ('browser:frame') and forwards mouse and key input. The MCP server stays
 * the only launcher: "start" and the idle keepalive go through `mcp.callTool`.
 *
 * The event -> CDP mapping lives in pure functions so tests can check it
 * without a browser.
 */
const path = require('path');
const { debugPortFromConfig } = require('../utils/browser-profile');

const WATCH_TTL_MS = 30_000;        // screencast stops this long after the last ping
const RECONNECT_MS = 3_000;         // backoff between connect attempts while watched
const KEEPALIVE_MS = 5 * 60_000;    // browser_tabs list, so the idle timer does not close Chromium
const BUSY_POLL_MS = 1_000;         // agentBusy check while watched
const MIN_FRAME_GAP_MS = 200;       // 5 fps cap
const SCREENCAST_PARAMS = { format: 'jpeg', quality: 50, maxWidth: 1280, maxHeight: 800, everyNthFrame: 2 };

// Keys the viewer sends as named keys. Everything printable arrives as text.
const KEY_CODES = {
    Enter: 13, Tab: 9, Backspace: 8, Escape: 27, Delete: 46,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Home: 36, End: 35, PageUp: 33, PageDown: 34
};
const KEY_TEXT = { Enter: '\r' };
const MOUSE_BUTTONS = ['left', 'middle', 'right'];

function modifierBits(mods = {}) {
    return (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);
}

function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Maps one viewer input event to a list of CDP messages ({ method, params }).
 * Returns [] for events it does not know. Coordinates are viewport pixels;
 * the viewer scales them against the frame size before sending.
 */
function inputToCdp(event) {
    if (!event || typeof event !== 'object') return [];
    const modifiers = modifierBits(event.modifiers);
    const x = Math.round(num(event.x));
    const y = Math.round(num(event.y));
    const button = MOUSE_BUTTONS.includes(event.button) ? event.button : 'left';

    switch (event.type) {
        case 'mousemove':
            return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, modifiers, button: event.pressed ? button : 'none' } }];
        case 'mousedown':
            return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, modifiers, button, clickCount: Math.max(1, num(event.clickCount, 1)) } }];
        case 'mouseup':
            return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, modifiers, button, clickCount: Math.max(1, num(event.clickCount, 1)) } }];
        case 'wheel':
            return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x, y, modifiers, deltaX: num(event.deltaX), deltaY: num(event.deltaY) } }];
        case 'text': {
            // Printable text only: no control characters.
            const text = String(event.text || '').replace(/[\u0000-\u001f\u007f]/g, '');
            return text ? [{ method: 'Input.insertText', params: { text } }] : [];
        }
        case 'key': {
            const code = KEY_CODES[event.key];
            if (!code) return [];
            const base = { key: event.key, code: event.key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
            const text = KEY_TEXT[event.key];
            const down = { ...base, type: text ? 'keyDown' : 'rawKeyDown' };
            if (text) { down.text = text; down.unmodifiedText = text; }
            return [
                { method: 'Input.dispatchKeyEvent', params: down },
                { method: 'Input.dispatchKeyEvent', params: { ...base, type: 'keyUp' } }
            ];
        }
        default:
            return [];
    }
}

/** Accepts http(s) and about:blank; adds https:// when the scheme is missing. */
function normalizeUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    // Chromium turns a browser-side about:<name> into chrome://<name>, so
    // only about:blank passes; every other about: page stays out like chrome:.
    if (/^about:/i.test(raw)) return raw.toLowerCase() === 'about:blank' ? 'about:blank' : null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    try {
        const u = new URL(withScheme);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return u.href;
    } catch {
        return null;
    }
}

/** Picks the focused page target, else the first page target. */
function pickPageTarget(targets) {
    const pages = (Array.isArray(targets) ? targets : []).filter(t => t && t.type === 'page' && t.webSocketDebuggerUrl);
    if (pages.length === 0) return null;
    return pages.find(t => t.focused) || pages[0];
}

class BrowserLive {
    /**
     * @param {object} agent   needs `interface.broadcast` and `mcp` (callTool, isServerBusy, config)
     * @param {object} [deps]  test hooks: WebSocket, fetch, now, port, timers
     */
    constructor(agent, deps = {}) {
        this.agent = agent;
        this.WebSocket = deps.WebSocket || globalThis.WebSocket;
        this.fetch = deps.fetch || ((...a) => globalThis.fetch(...a));
        this.now = deps.now || (() => Date.now());
        this.timers = deps.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
        this.port = deps.port || debugPortFromConfig(path.join(__dirname, '..', '..', 'playwright-mcp.config.json'));
        this.host = deps.host || '127.0.0.1';

        this.watchers = new Map();      // watcherId -> last ping (ms)
        this.ws = null;
        this.connecting = false;
        this.nextId = 1;
        this.pending = new Map();       // CDP id -> { resolve, reject }
        this.lastFrameAt = 0;
        this.lastFrame = null;          // last broadcast frame, replayed to new watchers
        this.url = null;
        this.running = false;
        this.ownCalls = 0;              // our own mcp calls do not count as agentBusy
        this.lastStatusKey = null;
        this.stopTimer = null;
        this.reconnectTimer = null;
        this.keepaliveTimer = null;
        this.busyTimer = null;
    }

    // ---- public API (used by routes) --------------------------------------

    /** Records a watcher ping. Starts the screencast when the first one arrives. */
    async watch(watcherId) {
        const id = String(watcherId || 'anon');
        const first = this.watchers.size === 0;
        this.watchers.set(id, this.now());
        this._armStopTimer();
        if (first) this._startWatchTimers();
        if (!this.ws && !this.connecting) await this._connect();
        this._broadcastStatus();
        return { ...this.status(), frame: this.lastFrame };
    }

    /** Forwards one viewer input event to the page. */
    async input(event) {
        if (!this._isOpen()) return { error: 'Browser not connected' };
        const messages = inputToCdp(event);
        if (messages.length === 0) return { ignored: true };
        try {
            for (const m of messages) await this._send(m.method, m.params);
            return { ok: true };
        } catch (e) {
            return { error: e.message };
        }
    }

    /** URL bar: navigates the watched page. */
    async navigate(input) {
        const url = normalizeUrl(input);
        if (!url) return { error: 'Only http, https and about:blank URLs are allowed' };
        if (!this._isOpen()) return { error: 'Browser not connected' };
        try {
            await this._send('Page.navigate', { url });
            this.url = url;
            this._broadcastStatus();
            return { ok: true, url };
        } catch (e) {
            return { error: e.message };
        }
    }

    /** Launches Chromium through the MCP server, then attaches if watched. */
    async start() {
        if (!this.agent.mcp?.callTool) return { error: 'MCP not ready' };
        try {
            await this._ownCall(() => this.agent.mcp.callTool('browser_navigate', { url: 'about:blank' }));
        } catch (e) {
            return { error: e.message };
        }
        if (this.watchers.size > 0 && !this.ws) await this._connect();
        else await this._refreshRunning();
        this._broadcastStatus();
        return this.status();
    }

    status() {
        return {
            running: this.running,
            url: this.url,
            agentBusy: this._agentBusy(),
            watchers: this._liveWatcherCount()
        };
    }

    /** Stops timers and the socket. Used on shutdown and in tests. */
    close() {
        this.watchers.clear();
        this._stopWatchTimers();
        this._clearTimer('stopTimer');
        this._clearTimer('reconnectTimer');
        this._closeSocket();
    }

    // ---- connection -------------------------------------------------------

    async _listTargets() {
        try {
            const res = await this.fetch(`http://${this.host}:${this.port}/json/list`);
            if (!res || !res.ok) return null;
            return await res.json();
        } catch {
            return null;
        }
    }

    async _refreshRunning() {
        const targets = await this._listTargets();
        const target = pickPageTarget(targets);
        this.running = !!target;
        if (target) this.url = target.url || this.url;
        return target;
    }

    async _connect() {
        if (this.connecting || this.ws) return;
        this.connecting = true;
        try {
            const target = await this._refreshRunning();
            if (!target) {
                this._broadcastStatus();
                this._scheduleReconnect();
                return;
            }
            await this._open(target);
        } catch (e) {
            console.warn('[BrowserLive] connect failed:', e.message);
            this._closeSocket();
            this._scheduleReconnect();
        } finally {
            this.connecting = false;
        }
    }

    _open(target) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const ws = new this.WebSocket(target.webSocketDebuggerUrl);
            this.ws = ws;
            ws.onopen = async () => {
                try {
                    await this._send('Page.enable', {});
                    await this._send('Page.startScreencast', SCREENCAST_PARAMS);
                    this.running = true;
                    this._broadcastStatus();
                    settled = true;
                    resolve();
                } catch (e) {
                    if (!settled) { settled = true; reject(e); }
                }
            };
            ws.onmessage = (ev) => this._onMessage(ev.data);
            ws.onerror = () => { /* onclose follows */ };
            ws.onclose = () => {
                if (this.ws !== ws) return;
                this.ws = null;
                this._rejectPending(new Error('CDP socket closed'));
                this.running = false;
                this._broadcastStatus();
                this._scheduleReconnect();
                if (!settled) { settled = true; reject(new Error('CDP socket closed')); }
            };
        });
    }

    _onMessage(raw) {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
            else resolve(msg.result);
            return;
        }
        if (msg.method === 'Page.screencastFrame') return this._onFrame(msg.params || {});
        if (msg.method === 'Page.frameNavigated' && msg.params?.frame && !msg.params.frame.parentId) {
            this.url = msg.params.frame.url || this.url;
            this._broadcastStatus();
        }
    }

    _onFrame(params) {
        // Ack first so Chromium keeps sending, then apply the fps cap.
        if (params.sessionId !== undefined) {
            this._send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => { });
        }
        const now = this.now();
        if (now - this.lastFrameAt < MIN_FRAME_GAP_MS) return false;
        this.lastFrameAt = now;
        const meta = params.metadata || {};
        const frame = {
            data: params.data,
            w: Math.round(num(meta.deviceWidth, SCREENCAST_PARAMS.maxWidth)),
            h: Math.round(num(meta.deviceHeight, SCREENCAST_PARAMS.maxHeight)),
            url: this.url
        };
        this.lastFrame = frame;
        this._broadcast('browser:frame', frame);
        return true;
    }

    _send(method, params = {}) {
        if (!this._isOpen()) return Promise.reject(new Error('Browser not connected'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.ws.send(JSON.stringify({ id, method, params }));
            } catch (e) {
                this.pending.delete(id);
                reject(e);
            }
        });
    }

    _isOpen() {
        return !!this.ws && this.ws.readyState === 1;
    }

    _rejectPending(err) {
        for (const { reject } of this.pending.values()) reject(err);
        this.pending.clear();
    }

    _closeSocket() {
        const ws = this.ws;
        this.ws = null;
        this._rejectPending(new Error('CDP socket closed'));
        if (ws) {
            try {
                if (ws.readyState === 1) ws.send(JSON.stringify({ id: this.nextId++, method: 'Page.stopScreencast', params: {} }));
            } catch { /* closing anyway */ }
            try { ws.close(); } catch { /* ignore */ }
        }
    }

    _scheduleReconnect() {
        if (this.reconnectTimer || this.watchers.size === 0) return;
        this.reconnectTimer = this.timers.setTimeout(() => {
            this.reconnectTimer = null;
            if (this.watchers.size > 0 && !this.ws) this._connect();
        }, RECONNECT_MS);
        if (this.reconnectTimer.unref) this.reconnectTimer.unref();
    }

    // ---- watcher gating ---------------------------------------------------

    _liveWatcherCount() {
        const cutoff = this.now() - WATCH_TTL_MS;
        let n = 0;
        for (const t of this.watchers.values()) if (t >= cutoff) n++;
        return n;
    }

    _armStopTimer() {
        this._clearTimer('stopTimer');
        this.stopTimer = this.timers.setTimeout(() => this._stopIfIdle(), WATCH_TTL_MS + 50);
        if (this.stopTimer.unref) this.stopTimer.unref();
    }

    _stopIfIdle() {
        this.stopTimer = null;
        const cutoff = this.now() - WATCH_TTL_MS;
        for (const [id, t] of this.watchers) if (t < cutoff) this.watchers.delete(id);
        if (this.watchers.size > 0) return this._armStopTimer();
        this._stopWatchTimers();
        this._clearTimer('reconnectTimer');
        this._closeSocket();
        this._broadcastStatus();
    }

    _startWatchTimers() {
        if (!this.keepaliveTimer) {
            this.keepaliveTimer = this.timers.setInterval(() => this._keepalive(), KEEPALIVE_MS);
            if (this.keepaliveTimer.unref) this.keepaliveTimer.unref();
        }
        if (!this.busyTimer) {
            this.busyTimer = this.timers.setInterval(() => this._broadcastStatus(), BUSY_POLL_MS);
            if (this.busyTimer.unref) this.busyTimer.unref();
        }
    }

    _stopWatchTimers() {
        this._clearTimer('keepaliveTimer', true);
        this._clearTimer('busyTimer', true);
    }

    _clearTimer(name, interval = false) {
        if (!this[name]) return;
        (interval ? this.timers.clearInterval : this.timers.clearTimeout)(this[name]);
        this[name] = null;
    }

    /** Completed tool call, so the MCP server's idle timer starts over. */
    async _keepalive() {
        if (this.watchers.size === 0 || !this.agent.mcp?.callTool) return;
        try {
            await this._ownCall(() => this.agent.mcp.callTool('browser_tabs', { action: 'list' }));
        } catch (e) {
            console.warn('[BrowserLive] keepalive failed:', e.message);
        }
    }

    async _ownCall(fn) {
        this.ownCalls++;
        try { return await fn(); } finally { this.ownCalls--; }
    }

    _agentBusy() {
        const mcp = this.agent.mcp;
        if (!mcp?.isServerBusy) return false;
        return this.ownCalls === 0 && mcp.isServerBusy('browser');
    }

    // ---- broadcast --------------------------------------------------------

    _broadcast(event, data) {
        const iface = this.agent.interface;
        if (!iface?.broadcast) return;
        Promise.resolve(iface.broadcast(event, data)).catch(() => { });
    }

    /** Sends browser:status only when a field changed. */
    _broadcastStatus() {
        const status = this.status();
        const key = JSON.stringify(status);
        if (key === this.lastStatusKey) return;
        this.lastStatusKey = key;
        this._broadcast('browser:status', status);
    }
}

module.exports = {
    BrowserLive,
    inputToCdp,
    normalizeUrl,
    pickPageTarget,
    modifierBits,
    SCREENCAST_PARAMS,
    KEY_CODES,
    WATCH_TTL_MS,
    RECONNECT_MS,
    KEEPALIVE_MS,
    MIN_FRAME_GAP_MS
};
