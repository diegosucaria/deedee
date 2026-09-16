'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Loader2, Unlock, ArrowRight } from 'lucide-react';
import clsx from 'clsx';
import { useSocket } from '@/hooks/useSocket';
import { startBrowser } from '@/app/actions';

const WATCH_INTERVAL_MS = 10_000;   // browser:watch ping while mounted
const MOVE_THROTTLE_MS = 40;        // 25 moves/s, under the 60/s cap in interfaces
const NAMED_KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Escape', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const BUTTONS = ['left', 'middle', 'right'];
const EMPTY_STATUS = { running: false, url: null, agentBusy: false, watchers: 0 };

function modifiers(e) {
    return { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey };
}

/**
 * Live view of the agent's browser. Frames arrive as browser:frame over the
 * socket; mouse and key events go back as browser:input, scaled from the
 * displayed image to the frame size (viewport pixels).
 */
export default function BrowserViewer({ initialStatus }) {
    const { socket, isConnected } = useSocket();
    const [frame, setFrame] = useState(null);
    const [status, setStatus] = useState({ ...EMPTY_STATUS, ...(initialStatus || {}) });
    const [urlInput, setUrlInput] = useState(initialStatus?.url || '');
    const [urlDirty, setUrlDirty] = useState(false);
    const [takenOver, setTakenOver] = useState(false);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState(initialStatus?.error || null);
    const [focused, setFocused] = useState(false);
    const imgRef = useRef(null);
    const stageRef = useRef(null);
    const lastMoveRef = useRef(0);
    const pressedRef = useRef(false);

    const locked = status.agentBusy && !takenOver;

    // Socket: frames, status and the watch ping.
    useEffect(() => {
        if (!socket) return;
        const onFrame = (f) => {
            if (f && f.data) setFrame({ src: `data:image/jpeg;base64,${f.data}`, w: f.w || 1280, h: f.h || 800, url: f.url });
        };
        const onStatus = (s) => { if (s) setStatus(prev => ({ ...prev, ...s })); };
        const onNavigated = (r) => setError(r && r.error ? r.error : null);
        const ping = () => socket.emit('browser:watch');

        socket.on('browser:frame', onFrame);
        socket.on('browser:status', onStatus);
        socket.on('browser:navigated', onNavigated);
        socket.on('connect', ping);
        if (socket.connected) ping();
        const timer = setInterval(ping, WATCH_INTERVAL_MS);

        return () => {
            clearInterval(timer);
            socket.off('browser:frame', onFrame);
            socket.off('browser:status', onStatus);
            socket.off('browser:navigated', onNavigated);
            socket.off('connect', ping);
        };
    }, [socket]);

    // The lock returns each time the agent starts a new browser call.
    useEffect(() => {
        if (!status.agentBusy) setTakenOver(false);
    }, [status.agentBusy]);

    // The URL bar follows the page unless Diego is typing in it.
    useEffect(() => {
        if (!urlDirty && status.url) setUrlInput(status.url);
    }, [status.url, urlDirty]);

    const send = useCallback((event) => {
        if (!socket || locked || !status.running) return;
        socket.emit('browser:input', event);
    }, [socket, locked, status.running]);

    /** Pointer position in frame (viewport) pixels, or null when outside the image. */
    const toFrame = useCallback((e) => {
        const img = imgRef.current;
        if (!img || !frame) return null;
        const rect = img.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const x = (e.clientX - rect.left) * (frame.w / rect.width);
        const y = (e.clientY - rect.top) * (frame.h / rect.height);
        if (x < 0 || y < 0 || x > frame.w || y > frame.h) return null;
        return { x, y };
    }, [frame]);

    const onMouseMove = (e) => {
        const now = Date.now();
        if (now - lastMoveRef.current < MOVE_THROTTLE_MS) return;
        const p = toFrame(e);
        if (!p) return;
        lastMoveRef.current = now;
        send({ type: 'mousemove', ...p, pressed: pressedRef.current, modifiers: modifiers(e) });
    };
    const onMouseDown = (e) => {
        const p = toFrame(e);
        if (!p) return;
        e.preventDefault();
        stageRef.current?.focus();
        pressedRef.current = true;
        send({ type: 'mousedown', ...p, button: BUTTONS[e.button] || 'left', clickCount: e.detail || 1, modifiers: modifiers(e) });
    };
    const onMouseUp = (e) => {
        const p = toFrame(e);
        pressedRef.current = false;
        if (!p) return;
        send({ type: 'mouseup', ...p, button: BUTTONS[e.button] || 'left', clickCount: e.detail || 1, modifiers: modifiers(e) });
    };

    // Wheel needs a non-passive listener so the page itself does not scroll.
    useEffect(() => {
        const el = stageRef.current;
        if (!el) return;
        const onWheel = (e) => {
            const p = toFrame(e);
            if (!p) return;
            e.preventDefault();
            send({ type: 'wheel', ...p, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiers(e) });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [toFrame, send]);

    const onKeyDown = (e) => {
        if (!focused) return;
        if (NAMED_KEYS.has(e.key)) {
            e.preventDefault();
            send({ type: 'key', key: e.key, modifiers: modifiers(e) });
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            send({ type: 'text', text: e.key });
        }
    };
    const onPaste = (e) => {
        const text = e.clipboardData?.getData('text');
        if (!text) return;
        e.preventDefault();
        send({ type: 'text', text });
    };

    const onStart = async () => {
        setStarting(true);
        setError(null);
        const result = await startBrowser();
        if (result?.error) setError(result.error);
        else setStatus(prev => ({ ...prev, ...result }));
        socket?.emit('browser:watch');
        setStarting(false);
    };

    const onNavigate = (e) => {
        e.preventDefault();
        const url = urlInput.trim();
        if (!url || !socket) return;
        setUrlDirty(false);
        setError(null);
        socket.emit('browser:navigate', { url });
        stageRef.current?.focus();
    };

    const pill = !isConnected
        ? { label: 'Socket offline', cls: 'bg-zinc-700 text-zinc-300' }
        : !status.running
            ? { label: 'Browser closed', cls: 'bg-zinc-700 text-zinc-300' }
            : status.agentBusy
                ? { label: 'Agent working', cls: 'bg-amber-500/20 text-amber-300 border border-amber-500/40' }
                : { label: 'Live', cls: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' };

    return (
        <div className="flex flex-col gap-3">
            {/* Toolbar */}
            <form onSubmit={onNavigate} className="flex items-center gap-2">
                <span className={clsx('px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap', pill.cls)} title={`${status.watchers || 0} watcher(s)`}>
                    {pill.label}
                </span>
                <input
                    type="text"
                    value={urlInput}
                    onChange={(e) => { setUrlInput(e.target.value); setUrlDirty(true); }}
                    onBlur={() => { if (!urlInput.trim()) setUrlDirty(false); }}
                    placeholder="Type a URL and press Enter"
                    disabled={!status.running || locked}
                    className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-zinc-200 font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                />
                <button
                    type="submit"
                    disabled={!status.running || locked || !urlInput.trim()}
                    className="p-2 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
                    title="Go"
                >
                    <ArrowRight className="w-4 h-4" />
                </button>
                {!status.running && (
                    <button
                        type="button"
                        onClick={onStart}
                        disabled={starting}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm hover:bg-indigo-500 disabled:opacity-50"
                    >
                        {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                        Start
                    </button>
                )}
            </form>

            {error && <div className="text-xs text-red-400">{error}</div>}

            {/* Stage */}
            <div
                ref={stageRef}
                tabIndex={0}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onMouseMove={onMouseMove}
                onMouseDown={onMouseDown}
                onMouseUp={onMouseUp}
                onContextMenu={(e) => e.preventDefault()}
                className={clsx(
                    'relative w-full rounded-xl overflow-hidden bg-black border outline-none select-none',
                    focused ? 'border-indigo-500' : 'border-zinc-800',
                    locked || !status.running ? 'cursor-default' : 'cursor-crosshair'
                )}
                style={{ aspectRatio: frame ? `${frame.w} / ${frame.h}` : '16 / 10' }}
            >
                {frame ? (
                    <img ref={imgRef} src={frame.src} alt="Live browser" draggable={false} className="block w-full h-full" />
                ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
                        {status.running ? 'Waiting for a frame' : 'Browser is closed'}
                    </div>
                )}

                {status.running && locked && (
                    <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-3 text-center p-4">
                        <p className="text-sm text-zinc-200">The agent is using the browser.</p>
                        <button
                            type="button"
                            onClick={() => setTakenOver(true)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 text-white text-sm hover:bg-amber-500"
                        >
                            <Unlock className="w-4 h-4" /> Take over
                        </button>
                    </div>
                )}
            </div>

            <p className="text-xs text-zinc-500">
                Click the view to type. Typing and clicks go to the page. Any signed-in user of this app can drive it.
            </p>
        </div>
    );
}
