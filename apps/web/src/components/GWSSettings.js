'use client';

import { useState, useEffect, useRef } from 'react';
import { Calendar, Upload, CheckCircle2, AlertCircle, Plus, X, Server } from 'lucide-react';
import { uploadGWSCredentials, getMCPStatus, deleteMCPServer } from '../app/actions';

export default function GWSSettings() {
    const [accounts, setAccounts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [isUploading, setIsUploading] = useState(false);

    // Upload Form State
    const [showUploadForm, setShowUploadForm] = useState(false);
    const [label, setLabel] = useState('');
    const [accountEmail, setAccountEmail] = useState('');
    const [fileContent, setFileContent] = useState('');
    const [fileName, setFileName] = useState('');
    const fileInputRef = useRef(null);

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        setLoading(true);
        try {
            const mcpServers = await getMCPStatus();
            const gwsServers = mcpServers
                .filter(s => s.name.startsWith('gws_'))
                .map(s => ({
                    name: s.name,
                    label: s.name.replace('gws_', ''),
                    status: s.status
                }));
            setAccounts(gwsServers);
        } catch (e) {
            console.error('Failed to load GWS accounts', e);
        }
        setLoading(false);
    };

    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        setFileName(file.name);

        const reader = new FileReader();
        reader.onload = (event) => {
            setFileContent(event.target.result);
        };
        reader.readAsText(file);
    };

    const handleUploadSubmit = async (e) => {
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
                setShowUploadForm(false);
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

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                        <Calendar className="w-5 h-5 text-indigo-400" />
                        Google Workspace
                    </h2>
                    <p className="text-sm text-zinc-400 mt-1">
                        Connect Google accounts to allow Deedee to manage calendars, emails, and Drive.
                        Authenticate locally with <code className="bg-zinc-800 px-1 rounded mx-1">gws auth login</code> and upload the generated credentials.json.
                    </p>
                </div>
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
                                    {acc.label.charAt(0).toUpperCase()}
                                </div>
                                <div>
                                    <h3 className="font-medium text-zinc-200 capitalize">{acc.label} Workspace</h3>
                                    <div className="flex items-center gap-2 mt-1">
                                        {acc.status === 'enabled' ? (
                                            <span className="flex items-center gap-1 text-xs text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full border border-green-400/20">
                                                <CheckCircle2 className="w-3 h-3" /> Enabled
                                            </span>
                                        ) : (
                                            <span className="flex items-center gap-1 text-xs text-red-400 bg-red-400/10 px-2 py-0.5 rounded-full border border-red-400/20">
                                                <AlertCircle className="w-3 h-3" /> Disabled
                                            </span>
                                        )}
                                        <span className="flex items-center gap-1 text-xs text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded border border-zinc-700">
                                            <Server className="w-3 h-3" /> MCP: {acc.name}
                                        </span>
                                    </div>
                                </div>
                            </div>
                            <button
                                onClick={() => handleDelete(acc.name)}
                                className="p-2 text-red-400 hover:text-red-300 hover:bg-red-400/10 rounded-lg transition-colors text-sm font-medium"
                                title="Delete Server"
                            >
                                Disconnect
                            </button>
                        </div>
                    ))
                ) : (
                    !loading && (
                        <div className="text-center py-8 text-zinc-500 border border-dashed border-zinc-800 rounded-lg bg-zinc-900/30">
                            No Google Workspace accounts connected.
                        </div>
                    )
                )}
            </div>

            {!showUploadForm && (
                <button
                    onClick={() => setShowUploadForm(true)}
                    className="flex items-center gap-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg transition-colors font-medium border border-indigo-500"
                >
                    <Plus className="w-4 h-4" />
                    Connect Workspace Account
                </button>
            )}

            {showUploadForm && (
                <div className="bg-zinc-800/80 border border-zinc-700 p-5 rounded-lg space-y-4 animate-in fade-in slide-in-from-top-2">
                    <div className="flex items-center justify-between">
                        <h3 className="font-medium text-white">Upload Credentials</h3>
                        <button onClick={() => setShowUploadForm(false)} className="text-zinc-500 hover:text-zinc-300">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    <form onSubmit={handleUploadSubmit} className="space-y-4">
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

                        <div>
                            <label className="block text-sm font-medium text-zinc-400 mb-1">credentials.json File</label>
                            <div className="flex items-center gap-3">
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 border border-zinc-600 rounded-lg text-sm text-white flex items-center gap-2 transition-colors"
                                >
                                    <Upload className="w-4 h-4" />
                                    Choose File
                                </button>
                                <span className="text-sm text-zinc-500">
                                    {fileName || 'No file selected'}
                                </span>
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
                </div>
            )}
        </div>
    );
}
