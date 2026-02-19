'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Loader2, AlertCircle, Trash2, CheckCircle2, Hash } from 'lucide-react';
import { getSlackStatus, saveSlackCredentials, testSlackCredentials, deleteSlackCredentials } from '../app/actions';

export default function SlackSettings() {
    const [status, setStatus] = useState(null);
    const [xoxc, setXoxc] = useState('');
    const [xoxd, setXoxd] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [testResult, setTestResult] = useState(null);

    const fetchStatus = useCallback(async () => {
        try {
            const data = await getSlackStatus();
            setStatus(data);
        } catch (err) {
            console.error('Failed to fetch Slack status:', err);
        }
    }, []);

    useEffect(() => {
        fetchStatus();
        const interval = setInterval(fetchStatus, 5000);
        return () => clearInterval(interval);
    }, [fetchStatus]);

    const handleTest = async () => {
        if (!xoxc || !xoxd) return setError('Both tokens are required');
        setBusy(true);
        setError(null);
        setTestResult(null);

        const res = await testSlackCredentials(xoxc, xoxd);
        if (res.success) {
            setTestResult({ team: res.team, user: res.user });
        } else {
            setError(res.error || 'Token validation failed');
        }
        setBusy(false);
    };

    const handleSave = async () => {
        if (!xoxc || !xoxd) return setError('Both tokens are required');
        setBusy(true);
        setError(null);

        const res = await saveSlackCredentials(xoxc, xoxd);
        if (res.success) {
            setXoxc('');
            setXoxd('');
            setTestResult(null);
            await fetchStatus();
        } else {
            setError(res.error || 'Failed to save credentials');
        }
        setBusy(false);
    };

    const handleDisconnect = async () => {
        if (!confirm('Disconnect Slack? This will delete saved tokens.')) return;
        setBusy(true);
        const res = await deleteSlackCredentials();
        if (!res.success) setError(res.error);
        setTestResult(null);
        await fetchStatus();
        setBusy(false);
    };

    if (!status) return <div className="p-8 text-center text-zinc-500">Loading Slack status...</div>;

    const isConnected = status.connected;

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold flex items-center gap-2 text-white">
                    <Hash className="w-6 h-6 text-purple-500" />
                    Slack
                </h2>
                <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${isConnected
                            ? 'bg-green-500/10 text-green-400 border-green-500/20'
                            : 'bg-zinc-700/30 text-zinc-500 border-zinc-700/50'
                        }`}>
                        {isConnected ? status.mode?.toUpperCase() || 'CONNECTED' : 'DISCONNECTED'}
                    </span>
                    <button
                        onClick={fetchStatus}
                        className="p-2 hover:bg-zinc-800 rounded-lg transition-colors text-zinc-400"
                        title="Refresh Status"
                    >
                        <RefreshCw className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {isConnected ? (
                <div className="space-y-4">
                    {/* Connected Card */}
                    <div className="bg-zinc-800/50 p-4 rounded-lg border border-zinc-700/50 space-y-3">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-purple-500/20 text-purple-500 rounded-full flex items-center justify-center font-bold text-sm">
                                #
                            </div>
                            <div>
                                <div className="text-sm font-medium text-white">{status.workspace}</div>
                                <div className="text-xs text-zinc-500">as {status.user}</div>
                            </div>
                        </div>
                        <div className="text-[10px] text-zinc-500 font-mono space-y-1 bg-zinc-950/30 p-2 rounded border border-zinc-800/50">
                            <div className="flex justify-between">
                                <span>Mode</span>
                                <span className="text-zinc-400">{status.mode}</span>
                            </div>
                            {status.tokenAge && (
                                <div className="flex justify-between">
                                    <span>Token Age</span>
                                    <span className="text-zinc-400">{status.tokenAge}</span>
                                </div>
                            )}
                        </div>
                    </div>

                    <button
                        onClick={handleDisconnect}
                        disabled={busy}
                        className="w-full py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
                    >
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        Disconnect Slack
                    </button>

                    <div className="p-3 bg-zinc-800/30 rounded-lg border border-zinc-800/50">
                        <p className="text-xs text-zinc-500">
                            <strong className="text-zinc-400">Security:</strong> Incoming Slack messages are <strong className="text-yellow-500/80">passive</strong>.
                            They won&apos;t trigger the agent unless you set up a watcher.
                        </p>
                    </div>
                </div>
            ) : (
                <div className="space-y-4">
                    {/* Setup Instructions */}
                    <div className="p-4 bg-zinc-800/50 rounded-lg border border-zinc-700/50">
                        <h3 className="text-sm font-semibold text-white mb-2">How to get tokens</h3>
                        <ol className="text-xs text-zinc-400 space-y-1.5 list-decimal list-inside">
                            <li>Open Slack in your browser (not the app)</li>
                            <li>Open DevTools → Application → Cookies</li>
                            <li>Find and copy the <code className="text-purple-400">d</code> cookie (starts with <code className="text-purple-400">xoxd-</code>)</li>
                            <li>Open DevTools → Console, run: <code className="text-purple-400 break-all">JSON.parse(localStorage.localConfig_v2).teams[Object.keys(JSON.parse(localStorage.localConfig_v2).teams)[0]].token</code></li>
                            <li>Copy the token that starts with <code className="text-purple-400">xoxc-</code></li>
                        </ol>
                    </div>

                    {/* Token Inputs */}
                    <div className="space-y-3">
                        <div>
                            <label className="text-xs font-medium text-zinc-400 block mb-1">API Token (xoxc-)</label>
                            <input
                                type="password"
                                value={xoxc}
                                onChange={e => setXoxc(e.target.value)}
                                placeholder="xoxc-..."
                                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-purple-500/50 focus:outline-none"
                            />
                        </div>
                        <div>
                            <label className="text-xs font-medium text-zinc-400 block mb-1">Cookie Token (xoxd-)</label>
                            <input
                                type="password"
                                value={xoxd}
                                onChange={e => setXoxd(e.target.value)}
                                placeholder="xoxd-..."
                                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-purple-500/50 focus:outline-none"
                            />
                        </div>
                    </div>

                    {/* Test Result */}
                    {testResult && (
                        <div className="p-3 bg-green-500/10 text-green-400 rounded-lg flex items-center gap-2 text-sm">
                            <CheckCircle2 className="w-4 h-4" />
                            Valid! Workspace: <strong>{testResult.team}</strong> as <strong>{testResult.user}</strong>
                        </div>
                    )}

                    {/* Buttons */}
                    <div className="flex gap-2">
                        <button
                            onClick={handleTest}
                            disabled={busy || !xoxc || !xoxd}
                            className="flex-1 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                        >
                            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                            Test
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={busy || !xoxc || !xoxd}
                            className="flex-1 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                        >
                            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                            Connect
                        </button>
                    </div>
                </div>
            )}

            {error && (
                <div className="bg-red-500/10 text-red-400 p-3 rounded-lg flex items-center gap-2 text-sm">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    {error}
                </div>
            )}
        </div>
    );
}
