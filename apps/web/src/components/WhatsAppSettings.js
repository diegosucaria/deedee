'use client';

import { useState, useEffect } from 'react';
import { RefreshCw, Smartphone, LogOut, Loader2, AlertCircle } from 'lucide-react';
import { getWhatsAppStatus, connectWhatsApp, disconnectWhatsApp } from '../app/actions';

export default function WhatsAppSettings() {
    const [status, setStatus] = useState({ status: 'loading' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const fetchStatus = async () => {
        try {
            const data = await getWhatsAppStatus();
            setStatus(data);
            return data;
        } catch (err) {
            console.error('Failed to fetch WhatsApp status:', err);
            // setStatus({ status: 'error' });
        }
    };

    useEffect(() => {
        fetchStatus();
        const interval = setInterval(fetchStatus, 3000); // Poll status every 3s
        return () => clearInterval(interval);
    }, []);

    const handleConnect = async () => {
        setLoading(true);
        setError(null);
        const res = await connectWhatsApp();
        if (!res.success) {
            setError(res.error || 'Failed to connect');
        }
        setLoading(false);
        fetchStatus();
    };

    const handleDisconnect = async () => {
        if (!confirm('Are you sure you want to disconnect? You will need to re-scan the QR code.')) return;
        setLoading(true);
        const res = await disconnectWhatsApp();
        if (!res.success) {
            setError(res.error || 'Failed to disconnect');
        }
        setLoading(false);
        fetchStatus();
    };

    const isConnected = status.status === 'connected';
    const isScanning = status.status === 'scan_qr' || status.status === 'connecting';
    const qrCode = status.qr;

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="p-6 border-b border-zinc-800 flex justify-between items-center">
                <div>
                    <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                        <Smartphone className="w-5 h-5 text-green-500" />
                        WhatsApp Connection
                    </h2>
                    <p className="text-sm text-zinc-400 mt-1">
                        Connect a WhatsApp account to enable the agent to message you.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${isConnected ? 'bg-green-500/10 text-green-400' :
                            isScanning ? 'bg-yellow-500/10 text-yellow-400' :
                                'bg-zinc-700/50 text-zinc-400'
                        }`}>
                        {status.status === 'scan_qr' ? 'AWAITING SCAN' : status.status.toUpperCase()}
                    </span>
                </div>
            </div>

            <div className="p-6">
                {error && (
                    <div className="bg-red-500/10 text-red-400 p-3 rounded-lg text-sm mb-4 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4" />
                        {error}
                    </div>
                )}

                {isConnected ? (
                    <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                        <div className="flex items-center gap-4">
                            <div className="w-16 h-16 bg-zinc-800 rounded-full flex items-center justify-center text-2xl">
                                📱
                            </div>
                            <div>
                                <h3 className="font-medium text-white">Connected Device</h3>
                                <p className="text-zinc-400 text-sm">
                                    {status.me?.name || 'Unknown Device'} ({status.me?.id || '...'})
                                </p>
                                <p className="text-zinc-500 text-xs mt-1">
                                    Allowed Numbers: {status.allowedNumbers?.join(', ') || 'None'}
                                </p>
                            </div>
                        </div>
                        <button
                            onClick={handleDisconnect}
                            disabled={loading}
                            className="px-4 py-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                        >
                            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
                            Disconnect
                        </button>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-4">
                        {status.status === 'scan_qr' && qrCode ? (
                            <div className="text-center space-y-4 animate-in fade-in duration-500">
                                <div className="bg-white p-2 rounded-lg inline-block">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={qrCode} alt="WhatsApp QR Code" className="w-64 h-64" />
                                </div>
                                <p className="text-zinc-400 text-sm">
                                    Open WhatsApp on your phone,<br />go to <strong>Linked Devices</strong> and scan the code.
                                </p>
                            </div>
                        ) : isScanning ? (
                            <div className="text-center py-12">
                                <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-3" />
                                <p className="text-zinc-400">Initializing connection...</p>
                            </div>
                        ) : (
                            <div className="text-center py-8">
                                <div className="w-16 h-16 bg-zinc-800 rounded-full flex items-center justify-center text-zinc-600 mx-auto mb-4">
                                    <Smartphone className="w-8 h-8" />
                                </div>
                                <h3 className="text-white font-medium mb-2">No Active Session</h3>
                                <p className="text-zinc-400 text-sm max-w-sm mx-auto mb-6">
                                    The agent is currently disconnected from WhatsApp. Start a new session to pair your device.
                                </p>
                                <button
                                    onClick={handleConnect}
                                    disabled={loading}
                                    className="px-6 py-2.5 bg-green-600 hover:bg-green-500 text-white rounded-lg font-medium transition-colors flex items-center gap-2 mx-auto"
                                >
                                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                                    Start Session
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
