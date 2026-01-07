'use client';

import { useState, useEffect } from 'react';
import { RefreshCw, Smartphone, LogOut, Loader2, AlertCircle, ScanLine } from 'lucide-react';
import { getWhatsAppStatus, connectWhatsApp, disconnectWhatsApp } from '../app/actions';

export default function WhatsAppSettings() {
    const [statusData, setStatusData] = useState(null);
    const [loading, setLoading] = useState(false); // Global loading state or per card?
    const [error, setError] = useState(null);

    const fetchStatus = async () => {
        try {
            const data = await getWhatsAppStatus();
            // Data format: { assistant: {...}, user: {...} } or { status: 'disabled' }
            setStatusData(data);
        } catch (err) {
            console.error('Failed to fetch WhatsApp status:', err);
            setError('Failed to fetch status');
        }
    };

    useEffect(() => {
        fetchStatus();
        const interval = setInterval(fetchStatus, 3000);
        return () => clearInterval(interval);
    }, []);

    if (!statusData) return <div className="p-8 text-center text-zinc-500">Loading WhatsApp status...</div>;
    if (statusData.status === 'disabled') return <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-400">WhatsApp is disabled.</div>;

    const sessions = [
        { key: 'assistant', title: 'Assistant Identity', description: 'Deedee answers as herself using this number.' },
        { key: 'user', title: 'User Identity (Impersonation)', description: 'Deedee acts on your behalf (e.g. sending messages as you).' }
    ];

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold flex items-center gap-2 text-white">
                    <Smartphone className="w-6 h-6 text-green-500" />
                    WhatsApp Sessions
                </h2>
                <button
                    onClick={fetchStatus}
                    className="p-2 hover:bg-zinc-800 rounded-lg transition-colors text-zinc-400"
                    title="Refresh Status"
                >
                    <RefreshCw className="w-4 h-4" />
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {sessions.map(session => (
                    <SessionCard
                        key={session.key}
                        sessionKey={session.key}
                        title={session.title}
                        description={session.description}
                        data={statusData[session.key] || { status: 'disconnected' }}
                        refresh={fetchStatus}
                    />
                ))}
            </div>

            {error && (
                <div className="bg-red-500/10 text-red-400 p-4 rounded-lg flex items-center gap-2">
                    <AlertCircle className="w-4 h-4" />
                    {error}
                </div>
            )}
        </div>
    );
}

function SessionCard({ sessionKey, title, description, data, refresh }) {
    const [busy, setBusy] = useState(false);
    const [cardError, setCardError] = useState(null);

    const isConnected = data.status === 'connected';
    const isScanning = data.status === 'scan_qr' || data.status === 'connecting';

    const handleConnect = async () => {
        setBusy(true);
        setCardError(null);
        const res = await connectWhatsApp(sessionKey);
        if (!res.success) setCardError(res.error || 'Connection failed');
        await refresh();
        setBusy(false);
    };

    const handleDisconnect = async () => {
        if (!confirm(`Disconnect ${title}?`)) return;
        setBusy(true);
        const res = await disconnectWhatsApp(sessionKey);
        if (!res.success) setCardError(res.error || 'Disconnect failed');
        await refresh();
        setBusy(false);
    };

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden flex flex-col">
            <div className="p-6 border-b border-zinc-800 bg-zinc-900/50 flex-grow-0">
                <div className="flex justify-between items-start mb-2">
                    <h3 className="font-semibold text-white">{title}</h3>
                    <Badge status={data.status} />
                </div>
                <p className="text-sm text-zinc-400 min-h-[40px]">{description}</p>
            </div>

            <div className="p-6 flex-grow flex flex-col justify-center min-h-[240px]">
                {cardError && (
                    <div className="mb-4 text-xs text-red-400 bg-red-500/10 p-2 rounded">
                        {cardError}
                    </div>
                )}

                {isConnected ? (
                    <div className="space-y-4">
                        <div className="flex items-center gap-3 bg-zinc-800/50 p-3 rounded-lg border border-zinc-700/50">
                            <div className="w-10 h-10 bg-green-500/20 text-green-500 rounded-full flex items-center justify-center font-bold">
                                WA
                            </div>
                            <div className="overflow-hidden">
                                <div className="text-sm font-medium text-white truncate">{data.me?.name || 'WhatsApp User'}</div>
                                <div className="text-xs text-zinc-500 font-mono truncate">{data.me?.id || 'Unknown ID'}</div>
                            </div>
                        </div>
                        <button
                            onClick={handleDisconnect}
                            disabled={busy}
                            className="w-full py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
                        >
                            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
                            Disconnect
                        </button>
                    </div>
                ) : isScanning ? (
                    <div className="text-center">
                        {data.qr ? (
                            <div className="space-y-4">
                                <div className="bg-white p-2 rounded-lg inline-block shadow-lg">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={data.qr} alt="QR Code" className="w-40 h-40" />
                                </div>
                                <p className="text-xs text-zinc-500">Scan with WhatsApp</p>
                            </div>
                        ) : (
                            <div className="py-8">
                                <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                                <span className="text-sm text-zinc-400">Initializing...</span>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="text-center py-4">
                        <div className="w-12 h-12 bg-zinc-800 rounded-full flex items-center justify-center mx-auto mb-3 text-zinc-600">
                            <ScanLine className="w-6 h-6" />
                        </div>
                        <button
                            onClick={handleConnect}
                            disabled={busy}
                            className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
                        >
                            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                            Start Session
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

function Badge({ status }) {
    const styles = {
        connected: 'bg-green-500/10 text-green-400 border-green-500/20',
        scan_qr: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
        connecting: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
        disconnected: 'bg-zinc-700/30 text-zinc-500 border-zinc-700/50',
        error: 'bg-red-500/10 text-red-400 border-red-500/20'
    };

    const style = styles[status] || styles.disconnected;
    const label = status === 'scan_qr' ? 'SCAN QR' : status.toUpperCase();

    return (
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${style}`}>
            {label}
        </span>
    );
}
