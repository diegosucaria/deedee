'use client';

import { useEffect, useState } from 'react';
import { Check, Fingerprint, KeyRound, Loader2, LogOut, Pencil, Plus, ShieldOff, Trash2, X } from 'lucide-react';

export default function SecurityClient({ passkeysEnabled }) {
    const [passkeys, setPasskeys] = useState([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [secureContext, setSecureContext] = useState(true);
    const [renamingId, setRenamingId] = useState(null);
    const [renameValue, setRenameValue] = useState('');

    const [pwCurrent, setPwCurrent] = useState('');
    const [pwNew, setPwNew] = useState('');
    const [pwConfirm, setPwConfirm] = useState('');
    const [pwBusy, setPwBusy] = useState(false);
    const [pwError, setPwError] = useState(null);
    const [pwSuccess, setPwSuccess] = useState(false);

    useEffect(() => {
        if (typeof window !== 'undefined') setSecureContext(!!window.isSecureContext);
        refresh();
    }, []);

    async function refresh() {
        setLoading(true);
        try {
            const res = await fetch('/api/auth/passkeys', { cache: 'no-store' });
            if (res.ok) {
                const data = await res.json();
                setPasskeys(data.passkeys || []);
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }

    async function enrollPasskey() {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const { startRegistration } = await import('@simplewebauthn/browser');
            const optionsRes = await fetch('/api/auth/passkey/register/options', { method: 'POST' });
            if (!optionsRes.ok) {
                const data = await optionsRes.json().catch(() => ({}));
                throw new Error(data.error || 'Could not start enrollment');
            }
            const options = await optionsRes.json();
            const attestation = await startRegistration({ optionsJSON: options });
            const name = window.prompt('Name this passkey (e.g. iPhone, MacBook):', defaultName()) || 'Passkey';
            const verifyRes = await fetch('/api/auth/passkey/register/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ attestation, name }),
            });
            if (!verifyRes.ok) {
                const data = await verifyRes.json().catch(() => ({}));
                throw new Error(data.error || 'Enrollment failed');
            }
            await refresh();
        } catch (err) {
            if (err?.name === 'NotAllowedError') setError('Enrollment cancelled');
            else setError(err.message || String(err));
        } finally {
            setBusy(false);
        }
    }

    async function deletePasskey(id) {
        if (!window.confirm('Remove this passkey? You will no longer be able to sign in with it.')) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Delete failed');
            }
            await refresh();
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    function startRename(pk) {
        setRenamingId(pk.id);
        setRenameValue(pk.name || '');
    }

    function cancelRename() {
        setRenamingId(null);
        setRenameValue('');
    }

    async function commitRename(id) {
        const name = renameValue.trim();
        if (!name) { cancelRename(); return; }
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/auth/passkeys/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Rename failed');
            }
            cancelRename();
            await refresh();
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    async function changePassword(e) {
        e.preventDefault();
        if (pwBusy) return;
        setPwError(null);
        setPwSuccess(false);
        if (pwNew.length < 8) { setPwError('New password must be at least 8 characters'); return; }
        if (pwNew !== pwConfirm) { setPwError('New passwords do not match'); return; }
        if (pwNew === pwCurrent) { setPwError('New password must differ from the current one'); return; }
        setPwBusy(true);
        try {
            const res = await fetch('/api/auth/password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword: pwCurrent, newPassword: pwNew }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Could not change password');
            }
            setPwCurrent('');
            setPwNew('');
            setPwConfirm('');
            setPwSuccess(true);
        } catch (err) {
            setPwError(err.message);
        } finally {
            setPwBusy(false);
        }
    }

    async function logout() {
        await fetch('/api/auth/logout', { method: 'POST' });
        window.location.href = '/login';
    }

    const passkeyAvailable = passkeysEnabled && secureContext;

    return (
        <div className="space-y-8">
            {error && (
                <div className="rounded-lg border border-red-800/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">{error}</div>
            )}

            <section className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-5">
                <header className="mb-3 flex items-center gap-2">
                    <Fingerprint className="h-5 w-5 text-indigo-400" />
                    <h2 className="text-lg font-semibold text-white">Passkeys</h2>
                </header>
                <p className="mb-4 text-sm text-zinc-400">
                    Sign in with Face ID, Touch ID, or a hardware key. Each device you sign in from can have its own passkey.
                </p>

                {!passkeysEnabled && (
                    <div className="mb-4 flex gap-2 rounded-md border border-amber-800/40 bg-amber-950/30 p-3 text-sm text-amber-200">
                        <ShieldOff size={16} className="mt-0.5 shrink-0" />
                        <span>Passkeys are disabled. Configure <code className="font-mono">WEBAUTHN_RP_ID</code> and an HTTPS <code className="font-mono">WEBAUTHN_ORIGIN</code>.</span>
                    </div>
                )}
                {passkeysEnabled && !secureContext && (
                    <div className="mb-4 flex gap-2 rounded-md border border-amber-800/40 bg-amber-950/30 p-3 text-sm text-amber-200">
                        <ShieldOff size={16} className="mt-0.5 shrink-0" />
                        <span>This page isn&apos;t loaded over HTTPS, so the browser will refuse passkey ceremonies.</span>
                    </div>
                )}

                {loading ? (
                    <div className="text-sm text-zinc-500">Loading…</div>
                ) : passkeys.length === 0 ? (
                    <div className="rounded-md border border-dashed border-zinc-800 p-4 text-sm text-zinc-500">
                        No passkeys yet.
                    </div>
                ) : (
                    <ul className="space-y-2">
                        {passkeys.map((pk) => (
                            <li key={pk.id} className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-900/40 px-4 py-3">
                                <div className="min-w-0 flex-1">
                                    {renamingId === pk.id ? (
                                        <input
                                            type="text"
                                            autoFocus
                                            value={renameValue}
                                            onChange={(e) => setRenameValue(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') commitRename(pk.id);
                                                else if (e.key === 'Escape') cancelRename();
                                            }}
                                            maxLength={64}
                                            className="w-full rounded border border-indigo-700/40 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-indigo-500"
                                        />
                                    ) : (
                                        <div className="truncate text-sm font-medium text-zinc-100">{pk.name}</div>
                                    )}
                                    <div className="mt-0.5 text-xs text-zinc-500">
                                        {pk.deviceType === 'multiDevice' ? 'Synced passkey' : 'Device-bound'} · enrolled {formatDate(pk.created)}
                                        {pk.lastUsed && ` · last used ${formatDate(pk.lastUsed)}`}
                                    </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                    {renamingId === pk.id ? (
                                        <>
                                            <button
                                                type="button"
                                                onClick={() => commitRename(pk.id)}
                                                disabled={busy}
                                                className="rounded-md border border-zinc-800 px-2 py-1 text-zinc-400 hover:border-indigo-700/40 hover:text-indigo-300 disabled:opacity-50"
                                                title="Save name"
                                            >
                                                <Check size={16} />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={cancelRename}
                                                disabled={busy}
                                                className="rounded-md border border-zinc-800 px-2 py-1 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 disabled:opacity-50"
                                                title="Cancel"
                                            >
                                                <X size={16} />
                                            </button>
                                        </>
                                    ) : (
                                        <>
                                            <button
                                                type="button"
                                                onClick={() => startRename(pk)}
                                                disabled={busy}
                                                className="rounded-md border border-zinc-800 px-2 py-1 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 disabled:opacity-50"
                                                title="Rename"
                                            >
                                                <Pencil size={16} />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => deletePasskey(pk.id)}
                                                disabled={busy}
                                                className="rounded-md border border-zinc-800 px-2 py-1 text-zinc-400 hover:border-red-700/40 hover:text-red-300 disabled:opacity-50"
                                                title="Remove passkey"
                                            >
                                                <Trash2 size={16} />
                                            </button>
                                        </>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}

                <button
                    type="button"
                    onClick={enrollPasskey}
                    disabled={busy || !passkeyAvailable}
                    className="mt-4 inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                    {busy ? <Loader2 className="animate-spin" size={16} /> : <Plus size={16} />}
                    Add passkey
                </button>
            </section>

            <section className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-5">
                <header className="mb-3 flex items-center gap-2">
                    <KeyRound className="h-5 w-5 text-indigo-400" />
                    <h2 className="text-lg font-semibold text-white">Change password</h2>
                </header>
                <p className="mb-4 text-sm text-zinc-400">
                    Updates the hash stored in <code className="font-mono">auth.json</code>. If <code className="font-mono">LOGIN_PASSWORD</code> is set in the web container&apos;s env, your change is overwritten on the next restart — clear the env var first.
                </p>
                {pwError && <div className="mb-3 rounded-md border border-red-800/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">{pwError}</div>}
                {pwSuccess && <div className="mb-3 rounded-md border border-emerald-800/60 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-200">Password updated.</div>}
                <form onSubmit={changePassword} className="grid max-w-md gap-3" autoComplete="off">
                    <input
                        type="password"
                        autoComplete="current-password"
                        placeholder="Current password"
                        value={pwCurrent}
                        onChange={(e) => setPwCurrent(e.target.value)}
                        disabled={pwBusy}
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2 text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-600"
                    />
                    <input
                        type="password"
                        autoComplete="new-password"
                        placeholder="New password (min 8 characters)"
                        value={pwNew}
                        onChange={(e) => setPwNew(e.target.value)}
                        disabled={pwBusy}
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2 text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-600"
                    />
                    <input
                        type="password"
                        autoComplete="new-password"
                        placeholder="Confirm new password"
                        value={pwConfirm}
                        onChange={(e) => setPwConfirm(e.target.value)}
                        disabled={pwBusy}
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2 text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-600"
                    />
                    <button
                        type="submit"
                        disabled={pwBusy || !pwCurrent || !pwNew || !pwConfirm}
                        className="inline-flex w-fit items-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                        {pwBusy ? <Loader2 className="animate-spin" size={16} /> : <KeyRound size={16} />}
                        Update password
                    </button>
                </form>
            </section>

            <section className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-5">
                <header className="mb-3 flex items-center gap-2">
                    <LogOut className="h-5 w-5 text-indigo-400" />
                    <h2 className="text-lg font-semibold text-white">Sign out</h2>
                </header>
                <p className="mb-4 text-sm text-zinc-400">
                    Sign out of this browser. To sign out everywhere, rotate <code className="font-mono">SESSION_SECRET</code> on the web container.
                </p>
                <button
                    type="button"
                    onClick={logout}
                    className="inline-flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-700 hover:bg-zinc-800"
                >
                    <LogOut size={16} /> Sign out
                </button>
            </section>
        </div>
    );
}

function defaultName() {
    if (typeof navigator === 'undefined') return 'Passkey';
    const ua = navigator.userAgent || '';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Linux/.test(ua)) return 'Linux';
    return 'Passkey';
}

function formatDate(iso) {
    if (!iso) return 'never';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
