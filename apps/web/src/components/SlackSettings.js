'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Loader2, AlertCircle, Trash2, CheckCircle2, Hash, Eye, Search, Lock, MessageCircle, Volume2, VolumeX, Plus } from 'lucide-react';
import { getSlackStatus, saveSlackCredentials, testSlackCredentials, deleteSlackCredentials, getSlackChannels, getSlackMonitoredChannels, setSlackMonitoredChannels, setSlackListening } from '../app/actions';

function ConnectionCard({ conn, fetchStatus }) {
    const [monitored, setMonitored] = useState([]);
    const [channels, setChannels] = useState([]);
    const [globalSearch, setGlobalSearch] = useState('');
    const [loadingChannels, setLoadingChannels] = useState(false);
    const [channelPickerOpen, setChannelPickerOpen] = useState(false);
    const [savingChannels, setSavingChannels] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        getSlackMonitoredChannels(conn.teamId).then(ch => setMonitored(ch || []));
    }, [conn.teamId]);

    const toggleListening = async () => {
        setBusy(true);
        const res = await setSlackListening(conn.teamId, !conn.listening);
        if (!res.success) setError(res.error || 'Failed to toggle listening state');
        await fetchStatus();
        setBusy(false);
    };

    const handleDisconnect = async () => {
        if (!confirm(`Disconnect Slack workspace ${conn.teamName}?`)) return;
        setBusy(true);
        const res = await deleteSlackCredentials(conn.teamId);
        if (!res.success) setError(res.error || 'Failed to disconnect');
        await fetchStatus();
        setBusy(false);
    };

    const loadChannels = async () => {
        setLoadingChannels(true);
        setChannelPickerOpen(true);
        const chs = await getSlackChannels(conn.teamId);
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
        const res = await setSlackMonitoredChannels(conn.teamId, monitored);
        setSavingChannels(false);
        if (res.success) {
            setChannelPickerOpen(false);
            setError(null);
        } else {
            setError(res.error || 'Failed to save monitored channels');
        }
    };

    const filteredChannels = channels.filter(ch => {
        const query = globalSearch.toLowerCase();
        return ch.name?.toLowerCase().includes(query) || ch.purpose?.toLowerCase().includes(query);
    });

    return (
        <div className="bg-zinc-800/40 p-4 rounded-xl border border-zinc-700/50 space-y-4">
            <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-purple-500/20 text-purple-500 rounded-lg flex items-center justify-center font-bold">
                        <Hash className="w-5 h-5" />
                    </div>
                    <div>
                        <div className="text-sm font-medium text-white">{conn.teamName}</div>
                        <div className="text-xs text-zinc-400">as {conn.user}</div>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={toggleListening}
                        disabled={busy}
                        className={`p-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors ${conn.listening
                            ? 'bg-purple-500/10 text-purple-400 border-purple-500/20 hover:bg-purple-500/20'
                            : 'bg-zinc-800 text-zinc-500 border-zinc-700 hover:bg-zinc-700'
                            }`}
                        title={conn.listening ? "Agent is listening to messages" : "Agent is ignoring messages"}
                    >
                        {conn.listening ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                        {conn.listening ? 'Listening' : 'Muted'}
                    </button>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${conn.connected
                        ? 'bg-green-500/10 text-green-400 border-green-500/20'
                        : 'bg-zinc-700/30 text-zinc-500 border-zinc-700/50'
                        }`}>
                        {conn.connected ? conn.mode?.toUpperCase() || 'CONNECTED' : 'EXPIRED'}
                    </span>
                </div>
            </div>

            {error && (
                <div className="bg-red-500/10 text-red-400 p-2 text-xs rounded-lg flex items-center gap-2">
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                    {error}
                </div>
            )}

            {/* Monitored Channels Header */}
            <div className="pt-2 border-t border-zinc-700/30">
                <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-semibold text-white flex items-center gap-2">
                        <Eye className="w-3.5 h-3.5 text-purple-400" />
                        Monitored Channels
                    </h3>
                    <button
                        onClick={loadChannels}
                        disabled={loadingChannels || busy}
                        className="text-[10px] px-2.5 py-1 bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 rounded transition-colors disabled:opacity-50"
                    >
                        {loadingChannels ? 'Loading...' : channelPickerOpen ? 'Refresh' : 'Configure'}
                    </button>
                </div>

                {/* Display Current Monitored List */}
                {monitored.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                        {monitored.map(ch => (
                            <span key={ch.id} className="inline-flex items-center gap-1 text-[10px] bg-purple-500/15 text-purple-300 px-2 py-0.5 rounded border border-purple-500/20">
                                {ch.isIm || ch.isMpim ? <MessageCircle className="w-2.5 h-2.5" /> : ch.isPrivate ? <Lock className="w-2.5 h-2.5" /> : <Hash className="w-2.5 h-2.5" />}
                                {ch.name}
                            </span>
                        ))}
                    </div>
                ) : (
                    <p className="text-[10px] text-zinc-600 italic mt-1">No channels monitored.</p>
                )}
            </div>

            {/* Channel Picker Dropdown */}
            {channelPickerOpen && (
                <div className="mt-3 p-3 bg-zinc-900/50 rounded-lg border border-zinc-700/50 flex flex-col gap-3">
                    <div className="relative">
                        <Search className="w-4 h-4 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                        <input
                            type="text"
                            value={globalSearch}
                            onChange={e => setGlobalSearch(e.target.value)}
                            placeholder="Search channels, groups, and DMs..."
                            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-9 pr-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:border-purple-500/50 focus:outline-none"
                        />
                    </div>
                    <div className="max-h-60 overflow-y-auto space-y-4 custom-scrollbar pr-2">
                        {channels.length === 0 ? (
                            <div className="text-center py-4 text-zinc-600 text-[10px]">No channels found</div>
                        ) : filteredChannels.length === 0 ? (
                            <div className="text-center py-4 text-zinc-600 text-[10px]">No matches found</div>
                        ) : (
                            <>
                                {/* Channels */}
                                {filteredChannels.filter(ch => !ch.isIm && !ch.isMpim).length > 0 && (
                                    <div className="space-y-0.5 relative">
                                        <div className="sticky top-0 bg-zinc-900/90 backdrop-blur pb-1 pt-1 z-10">
                                            <div className="text-[10px] text-zinc-500 font-medium uppercase tracking-wider">Channels</div>
                                        </div>
                                        {filteredChannels.filter(ch => !ch.isIm && !ch.isMpim).map(ch => {
                                            const isMonitored = monitored.some(m => m.id === ch.id);
                                            return (
                                                <button
                                                    key={ch.id}
                                                    onClick={() => toggleChannel(ch)}
                                                    className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left transition-colors text-[10px] ${isMonitored ? 'bg-purple-500/15 text-purple-300 border border-purple-500/20' : 'hover:bg-zinc-800 text-zinc-400 border border-transparent'}`}
                                                >
                                                    <div className={`w-3.5 h-3.5 rounded flex items-center justify-center flex-shrink-0 border ${isMonitored ? 'bg-purple-600 border-purple-500' : 'border-zinc-600'}`}>
                                                        {isMonitored && <CheckCircle2 className="w-2.5 h-2.5 text-white" />}
                                                    </div>
                                                    <div className="flex items-center gap-1 min-w-0 flex-1">
                                                        {ch.isPrivate ? <Lock className="w-2.5 h-2.5 flex-shrink-0 text-zinc-500" /> : <Hash className="w-2.5 h-2.5 flex-shrink-0 text-zinc-500" />}
                                                        <span className="font-medium truncate">{ch.name}</span>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                                {/* Groups */}
                                {filteredChannels.filter(ch => ch.isMpim).length > 0 && (
                                    <div className="space-y-0.5 relative">
                                        <div className="sticky top-0 bg-zinc-900/90 backdrop-blur pb-1 pt-2 z-10 border-t border-zinc-700/50">
                                            <div className="text-[10px] text-zinc-500 font-medium uppercase tracking-wider">Group DMs</div>
                                        </div>
                                        {filteredChannels.filter(ch => ch.isMpim).map(ch => {
                                            const isMonitored = monitored.some(m => m.id === ch.id);
                                            return (
                                                <button
                                                    key={ch.id}
                                                    onClick={() => toggleChannel(ch)}
                                                    className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left transition-colors text-[10px] ${isMonitored ? 'bg-purple-500/15 text-purple-300' : 'hover:bg-zinc-800 text-zinc-400'}`}
                                                >
                                                    <div className={`w-3.5 h-3.5 rounded flex items-center justify-center flex-shrink-0 border ${isMonitored ? 'bg-purple-600 border-purple-500' : 'border-zinc-600'}`}>
                                                        {isMonitored && <CheckCircle2 className="w-2.5 h-2.5 text-white" />}
                                                    </div>
                                                    <div className="flex items-start gap-1 min-w-0 flex-1 pt-0.5">
                                                        <MessageCircle className="w-2.5 h-2.5 flex-shrink-0 text-zinc-500 mt-0.5" />
                                                        <span className="font-medium break-words whitespace-normal leading-tight">{ch.name}</span>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                                {/* DMs */}
                                {filteredChannels.filter(ch => ch.isIm).length > 0 && (
                                    <div className="space-y-0.5 relative">
                                        <div className="sticky top-0 bg-zinc-900/90 backdrop-blur pb-1 pt-2 z-10 border-t border-zinc-700/50">
                                            <div className="text-[10px] text-zinc-500 font-medium uppercase tracking-wider">DMs</div>
                                        </div>
                                        {filteredChannels.filter(ch => ch.isIm).map(ch => {
                                            const isMonitored = monitored.some(m => m.id === ch.id);
                                            return (
                                                <button
                                                    key={ch.id}
                                                    onClick={() => toggleChannel(ch)}
                                                    className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left transition-colors text-[10px] ${isMonitored ? 'bg-purple-500/15 text-purple-300' : 'hover:bg-zinc-800 text-zinc-400'}`}
                                                >
                                                    <div className={`w-3.5 h-3.5 rounded flex items-center justify-center flex-shrink-0 border ${isMonitored ? 'bg-purple-600 border-purple-500' : 'border-zinc-600'}`}>
                                                        {isMonitored && <CheckCircle2 className="w-2.5 h-2.5 text-white" />}
                                                    </div>
                                                    <div className="flex items-start gap-1 min-w-0 flex-1 pt-0.5">
                                                        <MessageCircle className="w-2.5 h-2.5 flex-shrink-0 text-zinc-500 mt-0.5" />
                                                        <span className="font-medium break-words whitespace-normal leading-tight">{ch.name}</span>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                    <div className="flex gap-2 pt-3 mt-1 border-t border-zinc-800">
                        <button
                            onClick={() => setChannelPickerOpen(false)}
                            className="flex-1 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded text-[10px] font-medium transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={saveMonitored}
                            disabled={savingChannels}
                            className="flex-1 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded text-[10px] font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-1"
                        >
                            {savingChannels && <Loader2 className="w-3 h-3 animate-spin" />}
                            Save
                        </button>
                    </div>
                </div>
            )}

            <div className="pt-3 border-t border-zinc-700/30 flex justify-end">
                <button
                    onClick={handleDisconnect}
                    disabled={busy}
                    className="text-[10px] px-2 py-1 text-red-400/80 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors flex items-center gap-1"
                >
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                    Disconnect
                </button>
            </div>
        </div>
    );
}

export default function SlackSettings() {
    const [status, setStatus] = useState(null);
    const [xoxc, setXoxc] = useState('');
    const [xoxd, setXoxd] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [testResult, setTestResult] = useState(null);
    const [showAdd, setShowAdd] = useState(false);

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
        const interval = setInterval(fetchStatus, 30000);
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
            setShowAdd(false);
            await fetchStatus();
        } else {
            setError(res.error || 'Failed to save credentials');
        }
        setBusy(false);
    };

    if (!status) return <div className="p-8 text-center text-zinc-500">Loading Slack status...</div>;

    const connections = status.connections || [];
    const hasConnections = connections.length > 0;

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold flex items-center gap-2 text-white">
                    <Hash className="w-6 h-6 text-purple-500" />
                    Slack Workspaces
                </h2>
                <div className="flex items-center gap-2">
                    <button
                        onClick={fetchStatus}
                        className="p-2 hover:bg-zinc-800 rounded-lg transition-colors text-zinc-400"
                        title="Refresh Status"
                    >
                        <RefreshCw className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setShowAdd(!showAdd)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                        <Plus className="w-4 h-4" />
                        Add Workspace
                    </button>
                </div>
            </div>

            {hasConnections && (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {connections.map(conn => (
                        <ConnectionCard key={conn.teamId} conn={conn} fetchStatus={fetchStatus} />
                    ))}
                </div>
            )}

            {(!hasConnections || showAdd) && (
                <div className="space-y-4 max-w-xl">
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

                    {testResult && (
                        <div className="p-3 bg-green-500/10 text-green-400 rounded-lg flex items-center gap-2 text-sm">
                            <CheckCircle2 className="w-4 h-4" />
                            Valid! Workspace: <strong>{testResult.team}</strong> as <strong>{testResult.user}</strong>
                        </div>
                    )}

                    {error && (
                        <div className="bg-red-500/10 text-red-400 p-3 rounded-lg flex items-center gap-2 text-sm">
                            <AlertCircle className="w-4 h-4 flex-shrink-0" />
                            {error}
                        </div>
                    )}

                    <div className="flex gap-2">
                        <button
                            onClick={handleTest}
                            disabled={busy || !xoxc || !xoxd}
                            className="flex-1 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                            Test
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={busy || !xoxc || !xoxd}
                            className="flex-1 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                            Connect
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
