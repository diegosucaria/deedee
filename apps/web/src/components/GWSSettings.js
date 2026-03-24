'use client';

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { Calendar, Upload, CheckCircle2, AlertCircle, Plus, X, Server, RefreshCw, KeyRound, ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react';
import { uploadGWSCredentials, getMCPStatus, deleteMCPServer, saveGWSAuthClient, getGWSAuthClient, getGWSAuthURL, validateGWSAuth, getGWSCalendars, getGWSCalendarFilter, saveGWSCalendarFilter } from '../app/actions';

export default function GWSSettings() {
    const searchParams = useSearchParams();
    const [accounts, setAccounts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [successMessage, setSuccessMessage] = useState(null);
    const [isUploading, setIsUploading] = useState(false);

    // OAuth Client State
    const [oauthClient, setOauthClient] = useState({ configured: false });
    const [showOAuthSetup, setShowOAuthSetup] = useState(false);
    const [oauthFileContent, setOauthFileContent] = useState('');
    const [oauthFileName, setOauthFileName] = useState('');
    const oauthFileRef = useRef(null);

    // Connect Account State
    const [showConnectForm, setShowConnectForm] = useState(false);
    const [connectMode, setConnectMode] = useState('oauth'); // 'oauth' or 'manual'
    const [label, setLabel] = useState('');
    const [accountEmail, setAccountEmail] = useState('');
    const [isAuthenticating, setIsAuthenticating] = useState(false);

    // Manual Upload State (fallback)
    const [fileContent, setFileContent] = useState('');
    const [fileName, setFileName] = useState('');
    const fileInputRef = useRef(null);

    // Calendar Filter State — keyed by account label
    const [calConfig, setCalConfig] = useState({}); // { [label]: { expanded, loading, saving, calendars, selectedIds } }

    useEffect(() => {
        loadData();
    }, []);

    // Check for OAuth callback result in URL params
    useEffect(() => {
        const gwsAuth = searchParams.get('gws_auth');
        const authLabel = searchParams.get('label');
        const message = searchParams.get('message');

        if (gwsAuth === 'success') {
            setSuccessMessage(`Successfully authenticated${authLabel ? ` "${authLabel}"` : ''}. MCP server reloading...`);
            loadData();
            // Clean URL params after showing message
            setTimeout(() => {
                window.history.replaceState({}, '', '/settings?tab=interfaces');
            }, 500);
        } else if (gwsAuth === 'error') {
            setError(message ? decodeURIComponent(message) : 'Authentication failed');
            setTimeout(() => {
                window.history.replaceState({}, '', '/settings?tab=interfaces');
            }, 500);
        }
    }, [searchParams]);

    // Auto-dismiss success message
    useEffect(() => {
        if (successMessage) {
            const timer = setTimeout(() => setSuccessMessage(null), 6000);
            return () => clearTimeout(timer);
        }
    }, [successMessage]);

    const loadData = async () => {
        setLoading(true);
        try {
            const [mcpServers, clientStatus] = await Promise.all([
                getMCPStatus(),
                getGWSAuthClient(),
            ]);

            const gwsServers = mcpServers
                .filter(s => s.name.startsWith('gws_'))
                .map(s => ({
                    name: s.name,
                    label: s.name.replace('gws_', ''),
                    status: s.status,
                    email: s.email || null,
                    authValid: null, // unknown until validated
                }));
            setAccounts(gwsServers);
            setOauthClient(clientStatus);

            // Validate auth for each enabled account (in parallel, non-blocking)
            const enabledServers = gwsServers.filter(s => s.status !== 'disabled');
            if (enabledServers.length > 0) {
                const validations = await Promise.all(
                    enabledServers.map(s => validateGWSAuth(s.label))
                );
                setAccounts(prev => prev.map(acc => {
                    const idx = enabledServers.findIndex(s => s.label === acc.label);
                    if (idx === -1) return acc;
                    return { ...acc, authValid: validations[idx].valid };
                }));
            }
        } catch (e) {
            console.error('Failed to load GWS data', e);
        }
        setLoading(false);
    };

    // ─── OAuth Client Setup ───────────────────────────────────────────

    const handleOAuthFileChange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        setOauthFileName(file.name);
        const reader = new FileReader();
        reader.onload = (event) => setOauthFileContent(event.target.result);
        reader.readAsText(file);
    };

    const handleOAuthClientSave = async () => {
        if (!oauthFileContent) return;
        setIsUploading(true);
        setError(null);

        try {
            const parsed = JSON.parse(oauthFileContent);

            // Support Google's client_secret JSON format: { web: { client_id, client_secret, redirect_uris } }
            const webConfig = parsed.web;
            if (!webConfig) {
                setError('Invalid client_secret.json. Must be a "Web application" OAuth client (should contain a "web" key).');
                setIsUploading(false);
                return;
            }

            const clientId = webConfig.client_id;
            const clientSecret = webConfig.client_secret;
            const redirectUri = webConfig.redirect_uris?.[0];

            if (!clientId || !clientSecret || !redirectUri) {
                setError('Missing client_id, client_secret, or redirect_uris in the JSON file.');
                setIsUploading(false);
                return;
            }

            const res = await saveGWSAuthClient({ clientId, clientSecret, redirectUri });
            if (res.success) {
                setOauthFileContent('');
                setOauthFileName('');
                setShowOAuthSetup(false);
                await loadData();
                setSuccessMessage('OAuth client configured successfully.');
            } else {
                setError(res.error || 'Failed to save OAuth client');
            }
        } catch (e) {
            setError('Invalid JSON file: ' + e.message);
        }
        setIsUploading(false);
    };

    // ─── OAuth Re-Auth / Connect ──────────────────────────────────────

    const handleOAuthConnect = async () => {
        if (!label.trim() || !accountEmail.trim()) return;
        setIsAuthenticating(true);
        setError(null);

        try {
            const res = await getGWSAuthURL(label.trim(), accountEmail.trim());
            if (res.error) {
                setError(res.error);
                setIsAuthenticating(false);
                return;
            }
            // Redirect to Google OAuth
            window.location.href = res.url;
        } catch (e) {
            setError(e.message);
            setIsAuthenticating(false);
        }
    };

    const handleReAuth = async (acc) => {
        setError(null);
        if (!acc.email) {
            setError(`No email found for "${acc.label}". Disconnect and re-add the account.`);
            return;
        }
        try {
            const res = await getGWSAuthURL(acc.label, acc.email);
            if (res.error) {
                setError(res.error);
                return;
            }
            window.location.href = res.url;
        } catch (e) {
            setError(e.message);
        }
    };

    // ─── Manual Upload (fallback) ─────────────────────────────────────

    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        setFileName(file.name);
        const reader = new FileReader();
        reader.onload = (event) => setFileContent(event.target.result);
        reader.readAsText(file);
    };

    const handleManualUpload = async (e) => {
        e.preventDefault();
        if (!label.trim() || !fileContent) return;
        setIsUploading(true);
        setError(null);

        try {
            const res = await uploadGWSCredentials(label.trim(), accountEmail.trim(), fileContent);
            if (res.success) {
                setLabel('');
                setAccountEmail('');
                setFileContent('');
                setFileName('');
                setShowConnectForm(false);
                await loadData();
            } else {
                setError(res.error || 'Upload failed');
            }
        } catch (e) {
            setError(e.message);
        }
        setIsUploading(false);
    };

    const handleDelete = async (serverName) => {
        if (!confirm(`Are you sure you want to disconnect ${serverName}?`)) return;
        setLoading(true);
        try {
            await deleteMCPServer(serverName);
            await loadData();
        } catch (e) {
            setError(e.message);
        }
        setLoading(false);
    };

    // ─── Calendar Filter Handlers ─────────────────────────────────────

    const toggleCalendarConfig = async (label) => {
        const current = calConfig[label];
        if (current?.expanded) {
            // Collapse
            setCalConfig(prev => ({ ...prev, [label]: { ...prev[label], expanded: false } }));
            return;
        }

        // Expand & load data
        setCalConfig(prev => ({
            ...prev,
            [label]: { expanded: true, loading: true, saving: false, calendars: [], selectedIds: new Set() }
        }));

        try {
            const [calResult, filterResult] = await Promise.all([
                getGWSCalendars(label),
                getGWSCalendarFilter(label),
            ]);

            // Check if the calendar discovery returned an error
            if (calResult.error) {
                setCalConfig(prev => ({
                    ...prev,
                    [label]: { expanded: true, loading: false, saving: false, calendars: [], selectedIds: new Set(), error: calResult.error }
                }));
                return;
            }

            const calendars = calResult.calendars || [];
            const selectedIds = new Set(
                filterResult.calendarIds?.length > 0
                    ? filterResult.calendarIds
                    : calendars.filter(c => c.primary).map(c => c.id) // Default: primary checked
            );

            setCalConfig(prev => ({
                ...prev,
                [label]: { expanded: true, loading: false, saving: false, calendars, selectedIds, pristine: true }
            }));
        } catch (e) {
            console.error('Failed to load calendar config:', e);
            setCalConfig(prev => ({
                ...prev,
                [label]: { expanded: true, loading: false, saving: false, calendars: [], selectedIds: new Set(), error: e.message }
            }));
        }
    };

    const toggleCalendar = (label, calId) => {
        setCalConfig(prev => {
            const current = prev[label];
            if (!current) return prev;
            const newIds = new Set(current.selectedIds);
            if (newIds.has(calId)) {
                newIds.delete(calId);
            } else {
                newIds.add(calId);
            }
            return { ...prev, [label]: { ...current, selectedIds: newIds, pristine: false } };
        });
    };

    const saveCalendarSelection = async (label) => {
        const current = calConfig[label];
        if (!current) return;

        setCalConfig(prev => ({ ...prev, [label]: { ...prev[label], saving: true } }));

        try {
            const ids = [...current.selectedIds];
            const res = await saveGWSCalendarFilter(label, ids);
            if (res.success) {
                setSuccessMessage(`Calendar filter saved for "${label}" (${ids.length} calendars)`);
                setCalConfig(prev => ({ ...prev, [label]: { ...prev[label], saving: false, pristine: true } }));
            } else {
                setError(res.error || 'Failed to save calendar filter');
                setCalConfig(prev => ({ ...prev, [label]: { ...prev[label], saving: false } }));
            }
        } catch (e) {
            setError(e.message);
            setCalConfig(prev => ({ ...prev, [label]: { ...prev[label], saving: false } }));
        }
    };

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-indigo-400" />
                    Google Workspace
                </h2>
                <p className="text-sm text-zinc-400 mt-1">
                    Connect Google accounts to allow Deedee to manage calendars, emails, and Drive.
                </p>
            </div>

            {/* Success Message */}
            {successMessage && (
                <div className="bg-green-500/10 border border-green-500/20 text-green-400 p-4 rounded-lg flex items-start gap-3 text-sm animate-in fade-in slide-in-from-top-2">
                    <CheckCircle2 className="w-5 h-5 shrink-0" />
                    <p>{successMessage}</p>
                </div>
            )}

            {/* Error Message */}
            {error && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-lg flex items-start gap-3 text-sm">
                    <AlertCircle className="w-5 h-5 shrink-0" />
                    <div className="flex-1">
                        <p>{error}</p>
                        <button onClick={() => setError(null)} className="text-xs text-red-500 hover:text-red-300 mt-1 underline">Dismiss</button>
                    </div>
                </div>
            )}

            {/* OAuth Client Setup Section */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg overflow-hidden">
                <button
                    onClick={() => setShowOAuthSetup(!showOAuthSetup)}
                    className="w-full flex items-center justify-between p-4 text-left hover:bg-zinc-800/30 transition-colors"
                >
                    <div className="flex items-center gap-3">
                        <KeyRound className="w-4 h-4 text-zinc-400" />
                        <span className="text-sm font-medium text-zinc-300">OAuth Client</span>
                        {oauthClient.configured ? (
                            <span className="flex items-center gap-1 text-xs text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full border border-green-400/20">
                                <CheckCircle2 className="w-3 h-3" /> Configured
                            </span>
                        ) : (
                            <span className="flex items-center gap-1 text-xs text-yellow-400 bg-yellow-400/10 px-2 py-0.5 rounded-full border border-yellow-400/20">
                                <AlertCircle className="w-3 h-3" /> Not configured
                            </span>
                        )}
                    </div>
                    {showOAuthSetup ? <ChevronUp className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-500" />}
                </button>

                {showOAuthSetup && (
                    <div className="border-t border-zinc-800 p-4 space-y-4">
                        {oauthClient.configured ? (
                            <div className="space-y-2">
                                <p className="text-sm text-zinc-400">
                                    Client ID: <code className="bg-zinc-800 px-1 rounded text-zinc-300">{oauthClient.clientId}</code>
                                </p>
                                <p className="text-sm text-zinc-400">
                                    Redirect: <code className="bg-zinc-800 px-1 rounded text-zinc-300 text-xs">{oauthClient.redirectUri}</code>
                                </p>
                                <p className="text-xs text-zinc-500 mt-2">Upload a new client_secret.json to replace.</p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <p className="text-sm text-zinc-400">
                                    To enable one-click authentication, upload a <strong className="text-zinc-300">Web application</strong> OAuth client_secret.json
                                    from <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener" className="text-indigo-400 hover:underline">Google Cloud Console</a>.
                                </p>
                                <p className="text-xs text-zinc-500">
                                    Set the redirect URI to: <code className="bg-zinc-800 px-1 rounded">https://&lt;your-deedee-domain&gt;/api/auth/google/callback</code>
                                </p>
                            </div>
                        )}

                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                onClick={() => oauthFileRef.current?.click()}
                                className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 border border-zinc-600 rounded-lg text-sm text-white flex items-center gap-2 transition-colors"
                            >
                                <Upload className="w-4 h-4" />
                                {oauthClient.configured ? 'Replace' : 'Upload'} client_secret.json
                            </button>
                            <span className="text-sm text-zinc-500">{oauthFileName || ''}</span>
                            <input
                                type="file"
                                accept=".json"
                                ref={oauthFileRef}
                                onChange={handleOAuthFileChange}
                                className="hidden"
                            />
                        </div>

                        {oauthFileContent && (
                            <button
                                onClick={handleOAuthClientSave}
                                disabled={isUploading}
                                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                            >
                                {isUploading ? 'Saving...' : 'Save OAuth Client'}
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* Account Cards */}
            <div className="space-y-4">
                {accounts.length > 0 ? (
                    accounts.map((acc, idx) => {
                        const isExpired = acc.authValid === false;
                        const isChecking = acc.authValid === null && acc.status !== 'disabled';

                        return (
                            <div key={idx} className={`bg-zinc-800/50 border rounded-lg p-4 ${isExpired ? 'border-amber-500/50' : 'border-zinc-700/50'}`}>
                                {/* Expired Banner */}
                                {isExpired && oauthClient.configured && (
                                    <div className="flex items-center justify-between bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-2.5 mb-3 -mt-0.5">
                                        <div className="flex items-center gap-2 text-amber-400 text-sm">
                                            <AlertCircle className="w-4 h-4 shrink-0" />
                                            <span>Authentication expired. Re-connect to restore access.</span>
                                        </div>
                                        <button
                                            onClick={() => handleReAuth(acc)}
                                            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-amber-500 hover:bg-amber-400 text-black rounded-lg transition-colors font-medium shrink-0"
                                        >
                                            <RefreshCw className="w-3.5 h-3.5" />
                                            Re-connect
                                        </button>
                                    </div>
                                )}

                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-4">
                                        <div className={`h-10 w-10 rounded-full flex items-center justify-center font-bold ${isExpired ? 'bg-amber-500/20 text-amber-400' : 'bg-indigo-500/20 text-indigo-400'}`}>
                                            {acc.label.charAt(0).toUpperCase()}
                                        </div>
                                        <div>
                                            <h3 className="font-medium text-zinc-200 capitalize">{acc.label} Workspace</h3>
                                            {acc.email && <p className="text-xs text-zinc-500">{acc.email}</p>}
                                            <div className="flex items-center gap-2 mt-1">
                                                {acc.status === 'disabled' ? (
                                                    <span className="flex items-center gap-1 text-xs text-red-400 bg-red-400/10 px-2 py-0.5 rounded-full border border-red-400/20">
                                                        <AlertCircle className="w-3 h-3" /> Disabled
                                                    </span>
                                                ) : isExpired ? (
                                                    <span className="flex items-center gap-1 text-xs text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-full border border-amber-400/20">
                                                        <AlertCircle className="w-3 h-3" /> Auth Expired
                                                    </span>
                                                ) : isChecking ? (
                                                    <span className="flex items-center gap-1 text-xs text-zinc-400 bg-zinc-700/50 px-2 py-0.5 rounded-full border border-zinc-600/30">
                                                        <RefreshCw className="w-3 h-3 animate-spin" /> Checking...
                                                    </span>
                                                ) : (
                                                    <span className="flex items-center gap-1 text-xs text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full border border-green-400/20">
                                                        <CheckCircle2 className="w-3 h-3" /> Connected
                                                    </span>
                                                )}
                                                <span className="flex items-center gap-1 text-xs text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded border border-zinc-700">
                                                    <Server className="w-3 h-3" /> MCP: {acc.name}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {oauthClient.configured && !isExpired && (
                                            <button
                                                onClick={() => handleReAuth(acc)}
                                                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-indigo-400 hover:text-indigo-300 hover:bg-indigo-400/10 rounded-lg transition-colors font-medium border border-indigo-500/30"
                                                title="Re-authenticate with Google"
                                            >
                                                <RefreshCw className="w-3.5 h-3.5" />
                                                Re-auth
                                            </button>
                                        )}
                                        <button
                                            onClick={() => handleDelete(acc.name)}
                                            className="p-2 text-red-400 hover:text-red-300 hover:bg-red-400/10 rounded-lg transition-colors text-sm font-medium"
                                            title="Disconnect"
                                        >
                                            Disconnect
                                        </button>
                                    </div>
                                </div>

                                {/* Calendar Access Section */}
                                {acc.status !== 'disabled' && !isExpired && (
                                    <div className="mt-3 border-t border-zinc-700/50 pt-3">
                                        <button
                                            onClick={() => toggleCalendarConfig(acc.label)}
                                            className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors w-full"
                                        >
                                            <SlidersHorizontal className="w-3.5 h-3.5" />
                                            <span className="font-medium">Calendar Access</span>
                                            {calConfig[acc.label]?.expanded
                                                ? <ChevronUp className="w-3.5 h-3.5 ml-auto" />
                                                : <ChevronDown className="w-3.5 h-3.5 ml-auto" />
                                            }
                                        </button>

                                        {calConfig[acc.label]?.expanded && (
                                            <div className="mt-3 space-y-3">
                                                {calConfig[acc.label]?.loading ? (
                                                    <div className="flex items-center gap-2 text-sm text-zinc-500 py-2">
                                                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                                        Loading calendars...
                                                    </div>
                                                ) : calConfig[acc.label]?.error ? (
                                                    <div className="space-y-2">
                                                        <p className="text-sm text-red-400">{calConfig[acc.label].error}</p>
                                                        <button
                                                            onClick={() => { setCalConfig(prev => ({ ...prev, [acc.label]: undefined })); toggleCalendarConfig(acc.label); }}
                                                            className="text-xs text-indigo-400 hover:text-indigo-300 underline"
                                                        >
                                                            Retry
                                                        </button>
                                                    </div>
                                                ) : calConfig[acc.label]?.calendars.length === 0 ? (
                                                    <p className="text-sm text-zinc-500">No calendars found. Is the MCP server connected?</p>
                                                ) : (
                                                    <>
                                                        <p className="text-xs text-zinc-500">
                                                            Select which calendars the agent can access. Unselected calendars are hidden from all tools.
                                                        </p>
                                                        <div className="space-y-1.5 max-h-48 overflow-y-auto">
                                                            {calConfig[acc.label].calendars.map(cal => (
                                                                <label
                                                                    key={cal.id}
                                                                    className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-zinc-700/30 cursor-pointer transition-colors"
                                                                >
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={calConfig[acc.label].selectedIds.has(cal.id)}
                                                                        onChange={() => toggleCalendar(acc.label, cal.id)}
                                                                        className="rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500/30 focus:ring-offset-0"
                                                                    />
                                                                    {cal.backgroundColor && (
                                                                        <span
                                                                            className="w-2.5 h-2.5 rounded-full shrink-0"
                                                                            style={{ backgroundColor: cal.backgroundColor }}
                                                                        />
                                                                    )}
                                                                    <span className="text-sm text-zinc-300 truncate">{cal.summary}</span>
                                                                    {cal.primary && (
                                                                        <span className="text-[10px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700 shrink-0">
                                                                            Primary
                                                                        </span>
                                                                    )}
                                                                </label>
                                                            ))}
                                                        </div>
                                                        <div className="flex items-center gap-3 pt-1">
                                                            <button
                                                                onClick={() => saveCalendarSelection(acc.label)}
                                                                disabled={calConfig[acc.label]?.saving || calConfig[acc.label]?.pristine}
                                                                className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg transition-colors font-medium"
                                                            >
                                                                {calConfig[acc.label]?.saving ? 'Saving...' : 'Save'}
                                                            </button>
                                                            {calConfig[acc.label]?.selectedIds.size === 0 && (
                                                                <span className="text-xs text-amber-400">
                                                                    No calendars selected — defaults to primary only
                                                                </span>
                                                            )}
                                                        </div>
                                                    </>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })
                ) : (
                    !loading && (
                        <div className="text-center py-8 text-zinc-500 border border-dashed border-zinc-800 rounded-lg bg-zinc-900/30">
                            No Google Workspace accounts connected.
                        </div>
                    )
                )}
            </div>

            {/* Connect Account Button */}
            {!showConnectForm && (
                <button
                    onClick={() => setShowConnectForm(true)}
                    className="flex items-center gap-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg transition-colors font-medium border border-indigo-500"
                >
                    <Plus className="w-4 h-4" />
                    Connect Workspace Account
                </button>
            )}

            {/* Connect Account Form */}
            {showConnectForm && (
                <div className="bg-zinc-800/80 border border-zinc-700 p-5 rounded-lg space-y-4 animate-in fade-in slide-in-from-top-2">
                    <div className="flex items-center justify-between">
                        <h3 className="font-medium text-white">Connect Account</h3>
                        <button onClick={() => { setShowConnectForm(false); setConnectMode('oauth'); }} className="text-zinc-500 hover:text-zinc-300">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Mode Toggle */}
                    {oauthClient.configured && (
                        <div className="flex gap-1 bg-zinc-900/50 p-1 rounded-lg border border-zinc-800 w-fit">
                            <button
                                onClick={() => setConnectMode('oauth')}
                                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${connectMode === 'oauth' ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-white'}`}
                            >
                                Sign in with Google
                            </button>
                            <button
                                onClick={() => setConnectMode('manual')}
                                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${connectMode === 'manual' ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-white'}`}
                            >
                                Upload manually
                            </button>
                        </div>
                    )}

                    {/* Common Fields */}
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-zinc-400 mb-1">Account Label</label>
                            <input
                                type="text"
                                value={label}
                                onChange={(e) => setLabel(e.target.value)}
                                placeholder="e.g. personal, work"
                                required
                                className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-4 py-2 text-white outline-none focus:border-indigo-500/50"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-zinc-400 mb-1">Account Email</label>
                            <input
                                type="email"
                                value={accountEmail}
                                onChange={(e) => setAccountEmail(e.target.value)}
                                placeholder="e.g. user@acme.corp"
                                required
                                className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-4 py-2 text-white outline-none focus:border-indigo-500/50"
                            />
                        </div>
                    </div>

                    {/* OAuth Connect */}
                    {(connectMode === 'oauth' && oauthClient.configured) && (
                        <button
                            onClick={handleOAuthConnect}
                            disabled={isAuthenticating || !label.trim() || !accountEmail.trim()}
                            className="w-full bg-white hover:bg-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-900 px-4 py-2.5 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
                        >
                            {isAuthenticating ? (
                                <>
                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                    Redirecting to Google...
                                </>
                            ) : (
                                <>
                                    <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
                                    Sign in with Google
                                </>
                            )}
                        </button>
                    )}

                    {/* Manual Upload (fallback or when no OAuth client) */}
                    {(connectMode === 'manual' || !oauthClient.configured) && (
                        <form onSubmit={handleManualUpload} className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-zinc-400 mb-1">credentials.json File</label>
                                <p className="text-xs text-zinc-500 mb-2">
                                    Run <code className="bg-zinc-800 px-1 rounded">gws auth login</code> then <code className="bg-zinc-800 px-1 rounded">gws auth export --unmasked &gt; credentials.json</code>
                                </p>
                                <div className="flex items-center gap-3">
                                    <button
                                        type="button"
                                        onClick={() => fileInputRef.current?.click()}
                                        className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 border border-zinc-600 rounded-lg text-sm text-white flex items-center gap-2 transition-colors"
                                    >
                                        <Upload className="w-4 h-4" />
                                        Choose File
                                    </button>
                                    <span className="text-sm text-zinc-500">{fileName || 'No file selected'}</span>
                                </div>
                                <input
                                    type="file"
                                    accept=".json"
                                    ref={fileInputRef}
                                    onChange={handleFileChange}
                                    className="hidden"
                                    required
                                />
                            </div>
                            <button
                                type="submit"
                                disabled={isUploading || !label.trim() || !fileContent}
                                className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg font-medium transition-colors"
                            >
                                {isUploading ? 'Configuring Server...' : 'Upload & Connect'}
                            </button>
                        </form>
                    )}
                </div>
            )}
        </div>
    );
}
