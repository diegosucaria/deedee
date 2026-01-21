'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { getAutopilotDrafts, approveDraft, rejectDraft, editDraft, getAutopilotSettings, updateAutopilotStatus, toggleAutopilotPin, getStyleProfile, saveStyleProfile, analyzeStyle, getContactStyle, saveContactStyle, analyzeContactStyle } from '../actions';
import { Loader2, Check, X, Edit2, Save, User, Settings, MessageSquare, ShieldAlert, Sparkles, Brain, Search, Trash, Clock, RefreshCw, Pin } from 'lucide-react';
import clsx from 'clsx';
import { useChatSidebar } from '@/components/ChatSidebarProvider';
import { useSocket } from '../../hooks/useSocket';

// Wrapper to handle Suspense boundary for useSearchParams
export default function AutopilotPageWrapper() {
    return (
        <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader2 className="animate-spin h-8 w-8 text-gray-500" /></div>}>
            <AutopilotPage />
        </Suspense>
    );
}

function AutopilotPage() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    // Default to 'drafts' if no param
    const activeTab = searchParams.get('tab') || 'drafts';

    const setActiveTab = (tab) => {
        router.push(`${pathname}?tab=${tab}`);
    };

    const [drafts, setDrafts] = useState([]);
    const [settings, setSettings] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editingDraftId, setEditingDraftId] = useState(null);
    const [editContent, setEditContent] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedDuration, setSelectedDuration] = useState(0); // 0 = Forever, 15, 60, 180

    // Style State
    const [styleProfile, setStyleProfile] = useState('');
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [selectedContactStyleId, setSelectedContactStyleId] = useState('global'); // 'global' or contactId

    const { setCollapsed } = useChatSidebar();
    const { socket } = useSocket();

    useEffect(() => {
        setCollapsed(false);
        loadData();

        // Socket Listener for Real-time Updates
        if (activeTab === 'drafts' && socket) {
            const handleUpdate = (data) => {
                console.log('Received autopilot:update', data);
                loadData();
            };
            socket.on('autopilot:update', handleUpdate);

            return () => {
                socket.off('autopilot:update', handleUpdate);
            };
        }
    }, [activeTab, socket]);

    const loadData = async (isPolling = false) => {
        if (activeTab === 'drafts') {
            const data = await getAutopilotDrafts();
            setDrafts(data);
        } else if (activeTab === 'settings') {
            const data = await getAutopilotSettings();
            setSettings(data);
        } else if (activeTab === 'style' && !isPolling) {
            // Only fetch on initial load/tab switch, NOT during polling (prevents overwrite)

            // Should we re-fetch if we change contact in selector? 
            // handleContactSelect handles that manually.

            // Initial load (global)
            if (loading || selectedContactStyleId === 'global') {
                const profile = await getStyleProfile();
                if (profile !== null) setStyleProfile(profile || ''); // Only set if we got a response
            }

            // Also load people for the selector
            const people = await getAutopilotSettings();
            setSettings(people);
        }
        setLoading(false);
    };

    const handleApprove = async (id) => {
        setDrafts(prev => prev.filter(d => d.id !== id)); // Optimistic remove
        const res = await approveDraft(id);
        if (!res.success) {
            alert('Failed to approve: ' + res.error);
            loadData(); // Revert
        }
    };

    const handleReject = async (id) => {
        setDrafts(prev => prev.filter(d => d.id !== id));
        const res = await rejectDraft(id);
        if (!res.success) {
            alert('Failed to reject: ' + res.error);
            loadData();
        }
    };

    const startEdit = (draft) => {
        setEditingDraftId(draft.id);
        setEditContent(draft.content);
    };

    const saveEdit = async (id) => {
        const res = await editDraft(id, editContent);
        if (res.success) {
            setDrafts(prev => prev.map(d => d.id === id ? { ...d, content: editContent } : d));
            setEditingDraftId(null);
        } else {
            alert('Failed to save edit');
        }
    };

    const handleStatusChange = async (contactId, newStatus) => {
        // Optimistic update
        setSettings(prev => prev.map(p => p.id === contactId ? { ...p, autopilot_status: newStatus } : p));
        await updateAutopilotStatus(contactId, newStatus, selectedDuration);
    };

    const handlePin = async (contactId, currentPinStatus) => {
        const newStatus = !currentPinStatus;
        // Optimistic update
        setSettings(prev => {
            const updated = prev.map(p => p.id === contactId ? { ...p, is_pinned: newStatus } : p);
            // Re-sort locally to reflect jump immediately (optional, or wait for reload)
            // Let's just update state, the render sort will handle position?
            // Actually render sort is dynamic based on `settings` state.
            return updated;
        });
        await toggleAutopilotPin(contactId, newStatus);
        // loadData(); // Full refresh to confirm alignment
    };

    const handleContactSelect = async (e) => {
        const id = e.target.value;
        setSelectedContactStyleId(id);
        setLoading(true);

        let profile = '';
        if (id === 'global') {
            profile = await getStyleProfile();
        } else {
            profile = await getContactStyle(id);
        }

        setStyleProfile(profile || '');
        setLoading(false);
    };

    const handleSaveStyle = async () => {
        if (selectedContactStyleId === 'global') {
            await saveStyleProfile(styleProfile);
        } else {
            await saveContactStyle(selectedContactStyleId, styleProfile);
        }
        alert('Style profile saved!');
    };

    const handleAnalyze = async () => {
        const targetName = selectedContactStyleId === 'global' ? "Global History" : "Contact History";
        if (confirm(`This will analyze ${targetName} to build a style profile. It may take a moment. Continue?`)) {
            setIsAnalyzing(true);
            let res;
            if (selectedContactStyleId === 'global') {
                res = await analyzeStyle();
            } else {
                res = await analyzeContactStyle(selectedContactStyleId);
            }

            setIsAnalyzing(false);
            if (res.success) {
                setStyleProfile(res.profile);
            } else {
                alert('Analysis failed: ' + res.error);
            }
        }
    };

    return (
        <div className="flex flex-col h-screen bg-zinc-950 text-white p-6 overflow-hidden">
            <header className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-4">
                    <div>
                        <h1 className="text-2xl font-bold flex items-center gap-2">
                            <ShieldAlert className="w-8 h-8 text-blue-500" />
                            Autopilot Control
                        </h1>
                        <div className="flex items-center gap-3 mt-1">
                            <p className="text-zinc-400">Assisted conversation management</p>

                            {/* Socket Status */}
                            {socket && (
                                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-zinc-900 border border-zinc-800" title={socket.connected ? "Real-time updates active" : "Disconnected"}>
                                    <div className={clsx("w-1.5 h-1.5 rounded-full transition-colors", socket.connected ? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.4)]" : "bg-red-500")} />
                                    <span className="text-[10px] uppercase font-bold tracking-wider text-zinc-500">
                                        {socket.connected ? 'Live' : 'Offline'}
                                    </span>
                                </div>
                            )}

                            <button
                                onClick={() => loadData(false)}
                                disabled={loading}
                                className="p-1 text-zinc-500 hover:text-white hover:bg-zinc-800 rounded transition-colors disabled:opacity-50"
                                title="Refresh Data"
                            >
                                <RefreshCw className={clsx("w-4 h-4", loading && "animate-spin")} />
                            </button>
                        </div>
                    </div>
                </div>

                <div className="flex bg-zinc-900 p-1 rounded-lg">
                    <button
                        onClick={() => setActiveTab('drafts')}
                        className={clsx("px-4 py-2 rounded-md transition-colors flex items-center gap-2", activeTab === 'drafts' ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-300")}
                    >
                        <MessageSquare className="w-4 h-4" />
                        Drafts ({drafts.length})
                    </button>
                    <button
                        onClick={() => setActiveTab('settings')}
                        className={clsx("px-4 py-2 rounded-md transition-colors flex items-center gap-2", activeTab === 'settings' ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-300")}
                    >
                        <Settings className="w-4 h-4" />
                        Settings
                    </button>
                    <button
                        onClick={() => setActiveTab('style')}
                        className={clsx("px-4 py-2 rounded-md transition-colors flex items-center gap-2", activeTab === 'style' ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-300")}
                    >
                        <Brain className="w-4 h-4" />
                        Style
                    </button>
                </div>
            </header>

            <main className="flex-1 overflow-y-auto pr-2">
                {activeTab === 'drafts' && (
                    <div className="space-y-4">
                        {loading && drafts.length === 0 && <div className="text-center text-zinc-500 mt-10"><Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />Loading...</div>}
                        {!loading && drafts.length === 0 && (
                            <div className="text-center text-zinc-600 mt-20 p-10 border border-zinc-900 rounded-xl bg-zinc-900/20">
                                <Check className="w-12 h-12 mx-auto mb-4 text-green-500/20" />
                                <h3 className="text-xl font-medium text-zinc-300">All caught up!</h3>
                                <p>No pending drafts waiting for approval.</p>
                            </div>
                        )}

                        {drafts.map(draft => (
                            <div key={draft.id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 shadow-lg group hover:border-zinc-700 transition-colors">
                                <div className="flex justify-between items-start mb-4">
                                    <div>
                                        <h3 className="font-semibold text-lg text-blue-400">{draft.contact_name || draft.contact_id}</h3>
                                        <p className="text-xs text-zinc-500 font-mono mt-1">Chat ID: {draft.chat_id}</p>
                                    </div>
                                    <div className="flex flex-col items-end gap-1">
                                        <span className="text-xs bg-blue-500/10 text-blue-400 px-2 py-1 rounded-full border border-blue-500/20">
                                            Assisted
                                        </span>
                                        {(() => {
                                            try {
                                                const opts = draft.options ? JSON.parse(draft.options) : {};
                                                if (opts.cost) {
                                                    return (
                                                        <span className="text-[10px] text-zinc-600 font-mono">
                                                            ${Number(opts.cost).toFixed(5)}
                                                        </span>
                                                    );
                                                }
                                            } catch (e) { }
                                            return null;
                                        })()}
                                    </div>
                                </div>

                                {/* Context Message */}
                                {draft.context_message && (
                                    <div className="mb-3 p-3 rounded-lg bg-zinc-800/50 border border-zinc-800/50 text-sm text-zinc-400 italic">
                                        <span className="font-semibold text-zinc-500 not-italic text-xs block mb-1">Incoming:</span>
                                        "{draft.context_message}"
                                    </div>
                                )}

                                <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800 mb-4 relative">
                                    {editingDraftId === draft.id ? (
                                        <textarea
                                            value={editContent}
                                            onChange={e => setEditContent(e.target.value)}
                                            className="w-full bg-transparent text-zinc-200 outline-none resize-none h-24 font-mono text-sm"
                                        />
                                    ) : (
                                        <div className="space-y-2">
                                            {draft.content.split('[SPLIT]').map((segment, idx) => (
                                                <div key={idx} className={clsx("relative", idx > 0 && "pt-1")}>
                                                    {/* Visual connector for multi-part messages if desired, or just spacing */}
                                                    <p className={clsx("text-zinc-300 whitespace-pre-wrap font-mono text-sm bg-zinc-900/50 p-2 rounded", idx > 0 && "ml-4 border-l-2 border-zinc-800")}>
                                                        {segment.trim()}
                                                    </p>
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {editingDraftId !== draft.id && (
                                        <button
                                            onClick={() => startEdit(draft)}
                                            className="absolute top-2 right-2 p-1 text-zinc-600 hover:text-white bg-zinc-900/50 hover:bg-zinc-800 rounded opacity-0 group-hover:opacity-100 transition-all"
                                            title="Edit Draft"
                                        >
                                            <Edit2 className="w-3 h-3" />
                                        </button>
                                    )}
                                </div>

                                <div className="flex justify-end gap-3">
                                    {editingDraftId === draft.id ? (
                                        <button
                                            onClick={() => saveEdit(draft.id)}
                                            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm font-medium flex items-center gap-2"
                                        >
                                            <Save className="w-4 h-4" /> Save
                                        </button>
                                    ) : (
                                        <>
                                            <button
                                                onClick={() => handleReject(draft.id)}
                                                className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/20 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
                                            >
                                                <Trash className="w-4 h-4" /> Delete
                                            </button>
                                            <button
                                                onClick={() => handleApprove(draft.id)}
                                                className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg text-sm font-medium flex items-center gap-2 shadow-lg shadow-green-900/20 transition-all active:scale-95"
                                            >
                                                <Check className="w-4 h-4" /> Approve & Send
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {activeTab === 'settings' && (
                    <div className="space-y-4">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                            <input
                                type="text"
                                placeholder="Search contacts..."
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-10 pr-4 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-700 transition-colors"
                            />
                        </div>

                        {/* Duration Selector */}
                        <div className="flex items-center gap-2 mb-4 bg-zinc-900 p-2 rounded-lg w-fit border border-zinc-800">
                            <Clock className="w-4 h-4 text-zinc-500 ml-2" />
                            <span className="text-sm text-zinc-400">Apply Duration (on click):</span>
                            <div className="flex bg-zinc-950 rounded p-1">
                                {[
                                    { label: 'Forever', value: 0 },
                                    { label: '15m', value: 15 },
                                    { label: '1h', value: 60 },
                                    { label: '3h', value: 180 }
                                ].map(opt => (
                                    <button
                                        key={opt.value}
                                        onClick={() => setSelectedDuration(opt.value)}
                                        className={clsx(
                                            "px-3 py-1 rounded text-xs font-medium transition-colors",
                                            selectedDuration === opt.value ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"
                                        )}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="bg-zinc-900 rounded-xl overflow-hidden border border-zinc-800">
                            <table className="w-full text-left border-collapse">
                                <thead>
                                    <tr className="bg-zinc-950 border-b border-zinc-800 text-zinc-400 text-sm">
                                        <th className="p-4 font-medium">Contact</th>
                                        <th className="p-4 font-medium">Details</th>
                                        <th className="p-4 font-medium">Status</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-zinc-800">
                                    {settings
                                        .filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()) || (p.phone && p.phone.includes(searchQuery)))
                                        .sort((a, b) => {
                                            // Priority 0: Pinned
                                            if (a.is_pinned && !b.is_pinned) return -1;
                                            if (!a.is_pinned && b.is_pinned) return 1;

                                            // Primary Sort: Last Message (Newest First)
                                            // Ensure we prioritize those with recent messages
                                            const timeA = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
                                            const timeB = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
                                            if (timeA !== timeB) return timeB - timeA;

                                            // Secondary Sort: Active Status
                                            const aActive = a.autopilot_status === 'assisted' || a.autopilot_status === 'full';
                                            const bActive = b.autopilot_status === 'assisted' || b.autopilot_status === 'full';
                                            if (aActive && !bActive) return -1;
                                            if (!aActive && bActive) return 1;

                                            return 0;
                                        })
                                        .map(person => (
                                            <tr key={person.id} className="group hover:bg-zinc-800/50 transition-colors">
                                                <td className="p-4">
                                                    <div className="flex items-center gap-3">
                                                        <button
                                                            onClick={() => handlePin(person.id, person.is_pinned)}
                                                            className={clsx("p-2.5 rounded-full transition-colors", person.is_pinned ? "bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20" : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800")}
                                                            title={person.is_pinned ? "Unpin Contact" : "Pin to Top"}
                                                        >
                                                            <Pin className={clsx("w-5 h-5", person.is_pinned && "fill-current")} />
                                                        </button>
                                                        <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-400">
                                                            <User className="w-5 h-5" />
                                                        </div>
                                                        <span className="font-medium text-zinc-200">{person.name}</span>
                                                    </div>
                                                </td>
                                                <td className="p-4 text-sm text-zinc-500">
                                                    <div>{person.phone || 'No phone'}</div>
                                                    <div className="text-xs opacity-50 capitalize">{person.source}</div>
                                                    {person.autopilot_expires_at && new Date(person.autopilot_expires_at) > new Date() && (
                                                        <div className="text-xs text-orange-400 mt-1 flex items-center gap-1">
                                                            <Clock className="w-3 h-3" />
                                                            Until {new Date(person.autopilot_expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                        </div>
                                                    )}
                                                </td>
                                                <td className="p-4">
                                                    <div className="flex items-center gap-1 bg-zinc-950 rounded-lg p-1 w-fit border border-zinc-800">
                                                        <button
                                                            onClick={() => handleStatusChange(person.id, 'off')}
                                                            className={clsx("px-3 py-1 rounded text-xs font-medium transition-colors", person.autopilot_status === 'off' ? "bg-zinc-800 text-zinc-300" : "text-zinc-600 hover:text-zinc-400")}
                                                        >
                                                            Off
                                                        </button>
                                                        <button
                                                            onClick={() => handleStatusChange(person.id, 'assisted')}
                                                            className={clsx("px-3 py-1 rounded text-xs font-medium transition-colors", person.autopilot_status === 'assisted' ? "bg-blue-600 text-white shadow" : "text-zinc-600 hover:text-zinc-400")}
                                                        >
                                                            Assisted
                                                        </button>
                                                        <button
                                                            onClick={() => handleStatusChange(person.id, 'full')}
                                                            className={clsx("px-3 py-1 rounded text-xs font-medium transition-colors", person.autopilot_status === 'full' ? "bg-purple-600 text-white shadow" : "text-zinc-600 hover:text-zinc-400")}
                                                            title="Auto-reply without approval"
                                                        >
                                                            Full
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {activeTab === 'style' && (
                    <div className="space-y-6">
                        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                            <div className="flex items-start justify-between mb-4">
                                <div>
                                    <h3 className="text-lg font-medium text-zinc-200 flex items-center gap-2">
                                        <Sparkles className="w-5 h-5 text-purple-400" />
                                        {selectedContactStyleId === 'global' ? 'Global Style Profile' : 'Contact-Specific Style'}
                                    </h3>
                                    <p className="text-zinc-500 text-sm mt-1">
                                        {selectedContactStyleId === 'global'
                                            ? "DeeDee uses this profile as a baseline for all communications."
                                            : "This profile overrides the global style when talking to this specific contact."}
                                    </p>
                                </div>

                                <div className="flex items-center gap-3">
                                    <select
                                        value={selectedContactStyleId}
                                        onChange={handleContactSelect}
                                        className="bg-zinc-950 border border-zinc-700 text-zinc-300 text-sm rounded-lg focus:ring-purple-500 focus:border-purple-500 block p-2.5"
                                    >
                                        <option value="global">GLOBAL (Baseline)</option>
                                        <optgroup label="Contacts">
                                            {[...settings].sort((a, b) => {
                                                // Priority: Pinned
                                                if (a.is_pinned && !b.is_pinned) return -1;
                                                if (!a.is_pinned && b.is_pinned) return 1;
                                                // Priority: Has Style
                                                if (a.has_style && !b.has_style) return -1;
                                                if (!a.has_style && b.has_style) return 1;
                                                // Name Sort
                                                return (a.name || '').localeCompare(b.name || '');
                                            }).map(p => (
                                                <option key={p.id} value={p.id}>
                                                    {p.is_pinned ? '📌 ' : ''}{p.has_style ? '★ ' : ''}{p.name}
                                                </option>
                                            ))}
                                        </optgroup>
                                    </select>

                                    <button
                                        onClick={handleAnalyze}
                                        disabled={isAnalyzing}
                                        className="px-4 py-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white rounded-lg flex items-center gap-2 text-sm font-medium transition-all disabled:opacity-50"
                                    >
                                        {isAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Brain className="w-4 h-4" />}
                                        {isAnalyzing ? 'Analyzing...' : 'Analyze History'}
                                    </button>
                                </div>
                            </div>

                            <textarea
                                value={styleProfile}
                                onChange={e => setStyleProfile(e.target.value)}
                                placeholder="Your style rules will appear here..."
                                className="w-full h-96 bg-zinc-950 border border-zinc-800 rounded-lg p-4 font-mono text-sm text-zinc-300 outline-none focus:border-purple-500/50 transition-colors"
                            />

                            <div className="mt-4 flex justify-end">
                                <button
                                    onClick={handleSaveStyle}
                                    className="px-6 py-2 bg-zinc-100 text-zinc-900 hover:bg-white rounded-lg font-medium flex items-center gap-2 transition-colors"
                                >
                                    <Save className="w-4 h-4" />
                                    Save Profile
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
}
