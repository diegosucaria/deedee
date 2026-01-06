'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getWhatsAppStatus, disconnectWhatsApp } from '../actions';

export default function WhatsAppPage() {
    const [status, setStatus] = useState('loading'); // loading, disabled, disconnected, connecting, connected, scan_qr
    const [qr, setQr] = useState(null);
    const [allowed, setAllowed] = useState([]);
    const [error, setError] = useState(null);
    const router = useRouter();

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
            }
        } catch (e) {
            console.error(e);
            setStatus('error');
        }
    };

    useEffect(() => {
        // Initial Fetch
        fetchStatus();

        // Poll every 3 seconds
        const interval = setInterval(fetchStatus, 3000);
        return () => clearInterval(interval);
    }, []);

    const handleDisconnect = async () => {
        if (!confirm('Are you sure you want to disconnect?')) return;
        const res = await disconnectWhatsApp();
        if (res.success) {
            fetchStatus(); // Refresh immediately
        } else {
            alert('Failed to disconnect: ' + res.error);
        }
    };

    return (
        <div className="min-h-screen bg-black text-white p-8">
            <div className="max-w-4xl mx-auto">
                <div className="mb-8 flex items-center justify-between">
                    <div>
                        <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-green-400 to-emerald-600">
                            WhatsApp Integration
                        </h1>
                        <p className="text-zinc-400 mt-2">Connect your personal WhatsApp to Deedee.</p>
                    </div>
                </div>

                <StatusCard
                    status={status}
                    qr={qr}
                    allowed={allowed}
                    onDisconnect={handleDisconnect}
                />
            </div>
        </div>
    );
}

function StatusCard({ status, qr, allowed, onDisconnect }) {
    return (
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6">
            <div className="flex items-center space-x-4 mb-6">
                <div className={`w-3 h-3 rounded-full ${status === 'connected' ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]' :
                    status === 'scan_qr' ? 'bg-yellow-500 animate-pulse' :
                        'bg-red-500'
                    }`} />
                <span className="text-xl font-medium capitalize">{status.replace('_', ' ')}</span>
            </div>

            {status === 'scan_qr' && qr && (
                <div className="flex flex-col items-center justify-center space-y-4 py-8 bg-white/5 rounded-lg border border-zinc-800 border-dashed">
                    <img src={qr} alt="Scan QR Code" className="w-64 h-64 rounded-lg bg-white p-2" />
                    <p className="text-sm text-zinc-400">Open WhatsApp &gt; Linked Devices &gt; Link a Device</p>
                </div>
            )}

            {status === 'connected' && (
                <div className="space-y-4">
                    <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-lg text-green-400">
                        Authentication Successful. Agent is listening using your account.
                    </div>
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
                <div className="p-4 bg-zinc-800/50 rounded-lg text-zinc-400 text-center">
                    WhatsApp integration is currently disabled. Enable <code>ENABLE_WHATSAPP=true</code> in your environment variables.
                </div>
            )}
        </div>
    );
}
