'use client';

import { useState, useEffect } from 'react';
import { getAutopilotDrafts, approveDraft, rejectDraft, editDraft, getAutopilotSettings, updateAutopilotStatus } from '../actions';
import { Loader2, Check, X, Edit2, Save, User, Settings, MessageSquare, ShieldAlert } from 'lucide-react';
import clsx from 'clsx';
import { useChatSidebar } from '@/components/ChatSidebarProvider';

export default function AutopilotPage() {
    const [activeTab, setActiveTab] = useState('drafts'); // drafts | settings
    const [drafts, setDrafts] = useState([]);
    const [settings, setSettings] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editingDraftId, setEditingDraftId] = useState(null);
    const [editContent, setEditContent] = useState('');
    const { setCollapsed } = useChatSidebar();

    useEffect(() => {
        setCollapsed(false);
        loadData();
        const interval = setInterval(loadData, 5000); // Poll for new drafts
        return () => clearInterval(interval);
    }, [activeTab]);

    const loadData = async () => {
        if (activeTab === 'drafts') {
            const data = await getAutopilotDrafts();
            setDrafts(data);
        } else {
            const data = await getAutopilotSettings();
            setSettings(data);
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
        await updateAutopilotStatus(contactId, newStatus);
    };

    return (
        <div className="flex flex-col h-screen bg-zinc-950 text-white p-6 overflow-hidden">
            <header className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <ShieldAlert className="w-8 h-8 text-blue-500" />
                        Autopilot Control
                    </h1>
                    <p className="text-zinc-400">Assisted conversation management</p>
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
                                    <span className="text-xs bg-blue-500/10 text-blue-400 px-2 py-1 rounded-full border border-blue-500/20">
                                        Assisted
                                    </span>
                                </div>

                                <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800 mb-4 relative">
                                    {editingDraftId === draft.id ? (
                                        <textarea
                                            value={editContent}
                                            onChange={e => setEditContent(e.target.value)}
                                            className="w-full bg-transparent text-zinc-200 outline-none resize-none h-24 font-mono text-sm"
                                        />
                                    ) : (
                                        <p className="text-zinc-300 whitespace-pre-wrap font-mono text-sm">"{draft.content}"</p>
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
                                                <X className="w-4 h-4" /> Reject
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
                                {settings.map(person => (
                                    <tr key={person.id} className="group hover:bg-zinc-800/50 transition-colors">
                                        <td className="p-4">
                                            <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-400">
                                                    <User className="w-5 h-5" />
                                                </div>
                                                <span className="font-medium text-zinc-200">{person.name}</span>
                                            </div>
                                        </td>
                                        <td className="p-4 text-sm text-zinc-500">
                                            <div>{person.phone || 'No phone'}</div>
                                            <div className="text-xs opacity-50 capitalize">{person.source}</div>
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
                )}
            </main>
        </div>
    );
}
