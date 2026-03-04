'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Loader2, AlertCircle, Trash2, CheckCircle2, Hash, Eye, Search, Lock, MessageCircle } from 'lucide-react';
import { getSlackStatus, saveSlackCredentials, testSlackCredentials, deleteSlackCredentials, getSlackChannels, getSlackMonitoredChannels, setSlackMonitoredChannels } from '../app/actions';

export default function SlackSettings() {
    const [status, setStatus] = useState(null);
    const [xoxc, setXoxc] = useState('');
    const [xoxd, setXoxd] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [testResult, setTestResult] = useState(null);

    // Channel Picker State
    const [channels, setChannels] = useState([]);
    const [monitored, setMonitored] = useState([]); // [{id, name}]
    const [channelSearch, setChannelSearch] = useState('');
    const [loadingChannels, setLoadingChannels] = useState(false);
    const [channelPickerOpen, setChannelPickerOpen] = useState(false);
    const [savingChannels, setSavingChannels] = useState(false);

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

    // Load monitored channels when connected
    useEffect(() => {
        if (status?.connected) {
            getSlackMonitoredChannels().then(ch => setMonitored(ch || []));
        }
    }, [status?.connected]);

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

    const loadChannels = async () => {
        setLoadingChannels(true);
        setChannelPickerOpen(true);
        const chs = await getSlackChannels();
        setChannels(chs || []);
        setLoadingChannels(false);
    };

    const toggleChannel = (ch) => {
        setMonitored(prev => {
            const exists = prev.find(m => m.id === ch.id);
            if (exists) return prev.filter(m => m.id !== ch.id);
            return [...prev, { id: ch.id, name: ch.name, isPrivate: ch.isPrivate, isIm: ch.isIm }];
        });
    };

    const saveMonitored = async () => {
        setSavingChannels(true);
        const res = await setSlackMonitoredChannels(monitored);
        setSavingChannels(false);
        if (res.success) {
            setChannelPickerOpen(false);
        } else {
            setError(res.error || 'Failed to save monitored channels');
        }
    };

    const filteredChannels = channels.filter(ch =>
        ch.name.toLowerCase().includes(channelSearch.toLowerCase()) ||
        ch.purpose?.toLowerCase().includes(channelSearch.toLowerCase())
    );

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

                    {/* Monitored Channels Section */}
                    <div className="bg-zinc-800/50 p-4 rounded-lg border border-zinc-700/50 space-y-3">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                                <Eye className="w-4 h-4 text-purple-400" />
                                Monitored Channels
                            </h3>
                            <button
                                onClick={loadChannels}
                                disabled={loadingChannels}
                                className="text-xs px-3 py-1 bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 rounded-md transition-colors disabled:opacity-50"
                            >
                                {loadingChannels ? 'Loading...' : channelPickerOpen ? 'Refresh' : 'Configure'}
                            </button>
                        </div>

                        <p className="text-xs text-zinc-500">
                            These channels are scanned by scheduled tasks (morning briefings, proactive thought).
                        </p>

                        {/* Current Monitored List */}
                        {monitored.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                                {monitored.map(ch => (
                                    <span key={ch.id} className="inline-flex items-center gap-1 text-xs bg-purple-500/15 text-purple-300 px-2 py-0.5 rounded-full border border-purple-500/20">
                                        {ch.isIm ? <MessageCircle className="w-3 h-3" /> : ch.isPrivate ? <Lock className="w-3 h-3" /> : <Hash className="w-3 h-3" />}
                                        {ch.name}
                                    </span>
                                ))}
                            </div>
                        ) : (
                            <p className="text-xs text-zinc-600 italic">No channels monitored. Click Configure to select channels.</p>
                        )}

                        {/* Channel Picker */}
                        {channelPickerOpen && (
                            <div className="space-y-3 pt-2 border-t border-zinc-700/50">
                                {/* Search */}
                                <div className="relative">
                                    <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                                    <input
                                        type="text"
                                        value={channelSearch}
                                        onChange={e => setChannelSearch(e.target.value)}
                                        placeholder="Filter channels..."
                                        className="w-full bg-zinc-900 border border-zinc-700 rounded-md pl-8 pr-3 py-1.5 text-xs text-white placeholder-zinc-600 focus:border-purple-500/50 focus:outline-none"
                                    />
                                </div>

                                {/* Channel List */}
                                <div className="max-h-64 overflow-y-auto space-y-0.5 custom-scrollbar">
                                    {loadingChannels ? (
                                        <div className="text-center py-4 text-zinc-500 text-xs">
                                            <Loader2 className="w-4 h-4 animate-spin mx-auto mb-1" />
                                            Loading channels...
                                        </div>
                                    ) : filteredChannels.length === 0 ? (
                                        <div className="text-center py-4 text-zinc-600 text-xs">No channels found</div>
                                    ) : (
                                        filteredChannels.map(ch => {
                                            const isMonitored = monitored.some(m => m.id === ch.id);
                                            return (
                                                <button
                                                    key={ch.id}
                                                    onClick={() => toggleChannel(ch)}
                                                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors text-xs ${isMonitored
                                                        ? 'bg-purple-500/15 text-purple-300 border border-purple-500/20'
                                                        : 'hover:bg-zinc-800 text-zinc-400 border border-transparent'
                                                        }`}
                                                >
                                                    <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border ${isMonitored
                                                        ? 'bg-purple-600 border-purple-500'
                                                        : 'border-zinc-600'
                                                        }`}>
                                                        {isMonitored && <CheckCircle2 className="w-3 h-3 text-white" />}
                                                    </div>
                                                    <div className="flex items-center gap-1 min-w-0 flex-1">
                                                        {ch.isIm ? <MessageCircle className="w-3 h-3 flex-shrink-0 text-zinc-500" /> : ch.isPrivate ? <Lock className="w-3 h-3 flex-shrink-0 text-zinc-500" /> : <Hash className="w-3 h-3 flex-shrink-0 text-zinc-500" />}
                                                        <span className="font-medium truncate">{ch.name}</span>
                                                    </div>
                                                    {ch.purpose && (
                                                        <span className="text-[10px] text-zinc-600 truncate max-w-[120px] hidden sm:inline">{ch.purpose}</span>
                                                    )}
                                                    {!ch.isMember && (
                                                        <span className="text-[9px] text-zinc-600 bg-zinc-800 px-1 rounded flex-shrink-0">not joined</span>
                                                    )}
                                                </button>
                                            );
                                        })
                                    )}
                                </div>

                                {/* Save / Cancel */}
                                <div className="flex gap-2 pt-1">
                                    <button
                                        onClick={() => setChannelPickerOpen(false)}
                                        className="flex-1 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded-md text-xs font-medium transition-colors"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={saveMonitored}
                                        disabled={savingChannels}
                                        className="flex-1 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-md text-xs font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-1"
                                    >
                                        {savingChannels ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                                        Save ({monitored.length} channels)
                                    </button>
                                </div>
                            </div>
                        )}
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
