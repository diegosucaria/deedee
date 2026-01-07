'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getWhatsAppStatus, disconnectWhatsApp } from '../actions';
import { MessageSquare, Send } from 'lucide-react';

export default function InterfacesPage() {
    const [activeTab, setActiveTab] = useState('whatsapp');

    return (
        <div className="min-h-screen bg-black text-white p-8">
            <div className="max-w-4xl mx-auto">
                <div className="mb-8">
                    <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-600">
                        Interfaces
                    </h1>
                    <p className="text-zinc-400 mt-2">Manage connection channels for Deedee.</p>
                </div>

                {/* Tabs */}
                <div className="flex space-x-1 bg-zinc-900/50 p-1 rounded-lg w-fit mb-8 border border-zinc-800">
                    <button
                        onClick={() => setActiveTab('whatsapp')}
                        className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'whatsapp'
                            ? 'bg-zinc-800 text-white shadow-sm'
                            : 'text-zinc-500 hover:text-zinc-300'
                            }`}
                    >
                        <div className="flex items-center space-x-2">
                            <MessageSquare size={16} />
                            <span>WhatsApp</span>
                        </div>
                    </button>
                    <button
                        onClick={() => setActiveTab('telegram')}
                        className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'telegram'
                            ? 'bg-zinc-800 text-white shadow-sm'
                            : 'text-zinc-500 hover:text-zinc-300'
                            }`}
                    >
                        <div className="flex items-center space-x-2">
                            <Send size={16} />
                            <span>Telegram</span>
                        </div>
                    </button>
                </div>

                {/* Content */}
                <div className="bg-zinc-900 rounded-xl border border-zinc-800 min-h-[400px]">
                    {activeTab === 'whatsapp' && <WhatsAppManager />}
                    {activeTab === 'telegram' && <TelegramInfo />}
                </div>
            </div>
        </div>
    );
}

function WhatsAppManager() {
    const [status, setStatus] = useState('loading');
    const [qr, setQr] = useState(null);
    const [allowed, setAllowed] = useState([]);
    const [me, setMe] = useState(null);
    const [error, setError] = useState(null);

    const fetchStatus = async () => {
        try {
            const data = await getWhatsAppStatus();
            if (data.error) {
                setError(data.error);
                setStatus('error');
            } else {
                setStatus(data.status || 'disconnected');
                setQr(data.qr);
                setAllowed(data.allowedNumbers || []);
                setMe(data.me || null);
            }
        } catch (e) {
            console.error(e);
            setStatus('error');
        }
    };

    useEffect(() => {
        fetchStatus();
        const interval = setInterval(fetchStatus, 3000);
        return () => clearInterval(interval);
    }, []);

    const handleDisconnect = async () => {
        if (!confirm('Are you sure you want to disconnect?')) return;
        const res = await disconnectWhatsApp();
        if (res.success) {
            fetchStatus();
        } else {
            alert('Failed to disconnect: ' + res.error);
        }
    };

    return (
        <div className="p-6">
            <h2 className="text-xl font-semibold mb-6 flex items-center space-x-2">
                <span className="text-green-500">●</span>
                <span>WhatsApp Connection</span>
            </h2>
            <StatusCard
                status={status}
                qr={qr}
                allowed={allowed}
                me={me}
                onDisconnect={handleDisconnect}
            />
        </div>
    );
}

function TelegramInfo() {
    return (
        <div className="p-6">
            <h2 className="text-xl font-semibold mb-6 flex items-center space-x-2">
                <span className="text-blue-500">●</span>
                <span>Telegram Bot</span>
            </h2>
            <div className="p-4 bg-zinc-800/50 rounded-lg text-zinc-400">
                <p>Telegram is configured via environment variables (<code>TELEGRAM_TOKEN</code>).</p>
                <p className="mt-2 text-sm">To manage access, check your <code>ALLOWED_TELEGRAM_IDS</code> setting.</p>
            </div>
        </div>
    );
}

function StatusCard({ status, qr, allowed, me, onDisconnect }) {
    return (
        <div className="space-y-6">
            <div className="flex items-center space-x-4">
                <div className={`w-3 h-3 rounded-full ${status === 'connected' ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]' :
                    status === 'scan_qr' ? 'bg-yellow-500 animate-pulse' :
                        'bg-red-500'
                    }`} />
                <span className="text-lg font-medium capitalize text-zinc-200">{status.replace('_', ' ')}</span>
            </div>

            {status === 'scan_qr' && qr && (
                <div className="flex flex-col items-center justify-center space-y-4 py-8 bg-black/20 rounded-lg border border-zinc-800 border-dashed">
                    <img src={qr} alt="Scan QR Code" className="w-64 h-64 rounded-lg bg-white p-2" />
                    <p className="text-sm text-zinc-400">Open WhatsApp &gt; Linked Devices &gt; Link a Device</p>
                </div>
            )}

            {status === 'connected' && (
                <div className="space-y-4">
                    <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-lg text-green-400">
                        Authentication Successful. Agent is listening using your account.
                    </div>

                    {/* Identity Display */}
                    {me && (
                        <div className="bg-zinc-800/50 p-4 rounded-lg flex items-center justify-between border border-zinc-700">
                            <div>
                                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">Linked Identity</h3>
                                <div className="flex items-center space-x-2">
                                    <span className="text-zinc-200 font-mono text-lg font-bold">{me.id}</span>
                                    {me.name && <span className="text-zinc-400 text-sm">({me.name})</span>}
                                </div>
                            </div>
                        </div>
                    )}

                    {allowed.length > 0 && (
                        <div className="mt-4">
                            <h3 className="text-sm font-medium text-zinc-500 mb-2 uppercase tracking-wider">Allowed Numbers</h3>
                            <div className="flex flex-wrap gap-2">
                                {allowed.map(num => (
                                    <span key={num} className="px-2 py-1 bg-zinc-800 rounded text-xs text-zinc-300 font-mono">
                                        {num}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                    <button
                        onClick={onDisconnect}
                        className="mt-4 px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/50 rounded-lg transition-colors text-sm font-medium"
                    >
                        Disconnect Session
                    </button>
                </div>
            )}

            {status === 'disabled' && (
                <div className="p-4 bg-zinc-800/50 rounded-lg text-zinc-400">
                    WhatsApp integration is disabled on the server.
                </div>
            )}
            {status === 'error' && (
                <div className="p-4 bg-red-900/20 border border-red-500/20 rounded-lg text-red-400">
                    Failed to fetch status. Agent might be offline.
                </div>
            )}
        </div>
    );
}
