'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Fingerprint, KeyRound, Loader2, ShieldAlert } from 'lucide-react';

export default function LoginForm({ next, passkeysEnabled, hasPasskeys, hasPassword }) {
    const router = useRouter();
    const [mode, setMode] = useState(hasPasskeys && passkeysEnabled ? 'passkey' : 'password');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [secureContext, setSecureContext] = useState(true);

    useEffect(() => {
        if (typeof window !== 'undefined') {
            setSecureContext(!!window.isSecureContext);
        }
    }, []);

    const passkeyAvailable = passkeysEnabled && secureContext;

    async function passwordSubmit(e) {
        e.preventDefault();
        if (!password || busy) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Login failed');
            }
            router.replace(next || '/');
            router.refresh();
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    async function passkeySubmit() {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const { startAuthentication } = await import('@simplewebauthn/browser');
            const optionsRes = await fetch('/api/auth/passkey/login/options', { method: 'POST' });
            if (!optionsRes.ok) {
                const data = await optionsRes.json().catch(() => ({}));
                throw new Error(data.error || 'Could not start passkey login');
            }
            const options = await optionsRes.json();
            const assertion = await startAuthentication({ optionsJSON: options });
            const verifyRes = await fetch('/api/auth/passkey/login/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(assertion),
            });
            if (!verifyRes.ok) {
                const data = await verifyRes.json().catch(() => ({}));
                throw new Error(data.error || 'Passkey verification failed');
            }
            router.replace(next || '/');
            router.refresh();
        } catch (err) {
            // Browser cancellations throw NotAllowedError — soften the message.
            if (err?.name === 'NotAllowedError') setError('Passkey prompt cancelled');
            else setError(err.message || String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="w-full max-w-sm">
            <div className="mb-8 text-center">
                <h1 className="text-3xl font-semibold tracking-tight text-white">DeeDee</h1>
                <p className="mt-2 text-sm text-zinc-500">Sign in to continue</p>
            </div>

            {!hasPassword && (
                <div className="mb-6 flex gap-3 rounded-lg border border-amber-700/40 bg-amber-950/40 p-3 text-sm text-amber-200">
                    <ShieldAlert size={18} className="mt-0.5 shrink-0" />
                    <div>
                        No password configured yet. Set <code className="font-mono">LOGIN_PASSWORD</code> on the web container, or run <code className="font-mono">npm run auth:init</code> inside it.
                    </div>
                </div>
            )}

            {error && (
                <div className="mb-4 rounded-lg border border-red-800/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">{error}</div>
            )}

            {mode === 'passkey' && passkeyAvailable && hasPasskeys && (
                <div className="space-y-3">
                    <button
                        type="button"
                        onClick={passkeySubmit}
                        disabled={busy}
                        className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
                    >
                        {busy ? <Loader2 className="animate-spin" size={18} /> : <Fingerprint size={18} />}
                        Sign in with passkey
                    </button>
                    {hasPassword && (
                        <button type="button" onClick={() => setMode('password')} className="block w-full text-center text-sm text-zinc-500 hover:text-zinc-300">
                            Use password instead
                        </button>
                    )}
                </div>
            )}

            {mode === 'password' && (
                <form onSubmit={passwordSubmit} className="space-y-3">
                    <input
                        type="password"
                        autoComplete="current-password"
                        autoFocus
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Password"
                        disabled={busy || !hasPassword}
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3 text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-600"
                    />
                    <button
                        type="submit"
                        disabled={busy || !hasPassword || !password}
                        className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
                    >
                        {busy ? <Loader2 className="animate-spin" size={18} /> : <KeyRound size={18} />}
                        Sign in
                    </button>
                    {passkeyAvailable && hasPasskeys && (
                        <button type="button" onClick={() => setMode('passkey')} className="block w-full text-center text-sm text-zinc-500 hover:text-zinc-300">
                            Use passkey instead
                        </button>
                    )}
                </form>
            )}

            {!passkeysEnabled && (
                <p className="mt-6 text-center text-xs text-zinc-600">
                    Passkeys disabled. Configure <code className="font-mono">WEBAUTHN_RP_ID</code> and an HTTPS <code className="font-mono">WEBAUTHN_ORIGIN</code> to enable.
                </p>
            )}
            {passkeysEnabled && !secureContext && (
                <p className="mt-6 text-center text-xs text-amber-400">
                    Passkeys require HTTPS. This page is loaded without a secure context.
                </p>
            )}
        </div>
    );
}
