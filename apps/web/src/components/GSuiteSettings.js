'use client';

import { useState, useEffect } from 'react';
import { Calendar, RefreshCw, LogOut, CheckCircle2, AlertCircle, Plus, ExternalLink } from 'lucide-react';
import { getGSuiteAccounts, getGSuiteAuthUrl, authenticateGSuite, disconnectGSuite } from '../app/actions';

export default function GSuiteSettings() {
    const [accounts, setAccounts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [authUrl, setAuthUrl] = useState('');
    const [authCode, setAuthCode] = useState('');
    const [isAuthenticating, setIsAuthenticating] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        setLoading(true);
        try {
            const accs = await getGSuiteAccounts();
            setAccounts(accs);
        } catch (e) {
            console.error('Failed to load GSuite accounts', e);
        }
        setLoading(false);
    };

    const handleGenerateUrl = async () => {
        setError(null);
        try {
            const res = await getGSuiteAuthUrl();
            if (res.error) {
                setError(res.error);
            } else if (res.url) {
                setAuthUrl(res.url);
            }
        } catch (e) {
            setError(e.message);
        }
    };

    const handleAuthenticate = async (e) => {
        e.preventDefault();
        if (!authCode.trim()) return;

        setIsAuthenticating(true);
        setError(null);
        try {
            const res = await authenticateGSuite(authCode.trim());
            if (res.success) {
                setAuthCode('');
                setAuthUrl('');
                await loadData();
            } else {
                setError(res.error || 'Authentication failed');
            }
        } catch (e) {
            setError(e.message);
        }
        setIsAuthenticating(false);
    };

    const handleDisconnect = async (email) => {
        if (!confirm(`Are you sure you want to disconnect ${email}?`)) return;

        setLoading(true);
        try {
            await disconnectGSuite(email);
            await loadData();
        } catch (e) {
            setError(e.message);
        }
        setLoading(false);
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                        <Calendar className="w-5 h-5 text-indigo-400" />
                        Google Workspace
                    </h2>
                    <p className="text-sm text-zinc-400 mt-1">Connect your Google accounts to allow Deedee to manage calendars and emails.</p>
                </div>
                <button
                    onClick={loadData}
                    disabled={loading}
                    className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                    title="Refresh Status"
                >
                    <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            {error && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-lg flex items-start gap-3 text-sm">
                    <AlertCircle className="w-5 h-5 shrink-0" />
                    <p>{error}</p>
                </div>
            )}

            <div className="space-y-4">
                {accounts.length > 0 ? (
                    accounts.map((acc, idx) => (
                        <div key={idx} className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-4 flex items-center justify-between">
                            <div className="flex items-center gap-4">
                                <div className="h-10 w-10 bg-indigo-500/20 rounded-full flex items-center justify-center text-indigo-400 font-bold">
                                    {acc.email.charAt(0).toUpperCase()}
                                </div>
                                <div>
                                    <h3 className="font-medium text-zinc-200">{acc.email}</h3>
                                    <div className="flex items-center gap-2 mt-1">
                                        {acc.hasRefreshToken ? (
                                            <span className="flex items-center gap-1 text-xs text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full border border-green-400/20">
                                                <CheckCircle2 className="w-3 h-3" /> Connected
                                            </span>
                                        ) : (
                                            <span className="flex items-center gap-1 text-xs text-yellow-400 bg-yellow-400/10 px-2 py-0.5 rounded-full border border-yellow-400/20" title="Missing refresh token. Connection may drop after an hour or restart.">
                                                <AlertCircle className="w-3 h-3" /> Temporary Session
                                            </span>
                                        )}
                                        {acc.label && (
                                            <span className="text-xs text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded border border-zinc-700">
                                                Label: {acc.label}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                            <button
                                onClick={() => handleDisconnect(acc.email)}
                                className="p-2 text-red-400 hover:text-red-300 hover:bg-red-400/10 rounded-lg transition-colors"
                                title="Disconnect Account"
                            >
                                <LogOut className="w-5 h-5" />
                            </button>
                        </div>
                    ))
                ) : (
                    !loading && (
                        <div className="text-center py-8 text-zinc-500 border border-dashed border-zinc-800 rounded-lg bg-zinc-900/30">
                            No Google accounts connected yet.
                        </div>
                    )
                )}
            </div>

            {!authUrl && (
                <button
                    onClick={handleGenerateUrl}
                    className="flex items-center gap-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg transition-colors font-medium border border-indigo-500"
                >
                    <Plus className="w-4 h-4" />
                    Connect New Account
                </button>
            )}

            {authUrl && (
                <div className="bg-zinc-800/80 border border-zinc-700 p-5 rounded-lg space-y-4 animate-in fade-in slide-in-from-top-2">
                    <h3 className="font-medium text-white">Authentication Required</h3>
                    <p className="text-sm text-zinc-400">
                        1. Open the secure Google sign-in window<br />
                        2. Grant the requested permissions<br />
                        3. Copy the authorization code and paste it below
                    </p>

                    <a
                        href={authUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-indigo-400 hover:text-indigo-300 text-sm font-medium"
                    >
                        Sign in with Google <ExternalLink className="w-4 h-4" />
                    </a>

                    <form onSubmit={handleAuthenticate} className="flex gap-2">
                        <input
                            type="text"
                            value={authCode}
                            onChange={(e) => setAuthCode(e.target.value)}
                            placeholder="Paste authorization code here..."
                            required
                            className="flex-1 bg-zinc-950 border border-zinc-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                        />
                        <button
                            type="submit"
                            disabled={isAuthenticating || !authCode.trim()}
                            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2 rounded-lg font-medium transition-colors"
                        >
                            {isAuthenticating ? 'Connecting...' : 'Connect'}
                        </button>
                    </form>

                    <button
                        onClick={() => setAuthUrl('')}
                        className="text-xs text-zinc-500 hover:text-zinc-300"
                    >
                        Cancel
                    </button>
                </div>
            )}
        </div>
    );
}
