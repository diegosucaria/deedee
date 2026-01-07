'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Plus, MessageSquare, Trash2, Pencil, Check, X } from 'lucide-react';
import { clsx } from 'clsx';
import { createSession, deleteSession, updateSession } from '@/app/actions';
import { useState } from 'react';

export default function ChatSidebar({ sessions = [] }) {
    const params = useParams();
    const router = useRouter();
    const activeId = params.id;
    const [isCreating, setIsCreating] = useState(false);
    const [editingSessionId, setEditingSessionId] = useState(null);
    const [editTitle, setEditTitle] = useState('');

    const startRename = (e, session) => {
        e.preventDefault();
        e.stopPropagation();
        setEditingSessionId(session.id);
        setEditTitle(session.title || 'New Chat');
    };

    const cancelRename = () => {
        setEditingSessionId(null);
        setEditTitle('');
    };

    const saveRename = async (id) => {
        if (!editTitle.trim()) return cancelRename();

        await updateSession(id, { title: editTitle });
        setEditingSessionId(null);
        router.refresh();
    };

    const handleNewChat = async () => {
        setIsCreating(true);
        try {
            const res = await createSession();
            if (res.success && res.session) {
                router.push(`/chat/${res.session.id}`);
                router.refresh(); // Refresh to update list
            }
        } catch (e) {
            console.error('Failed to create session:', e);
        } finally {
            setIsCreating(false);
        }
    };

    const handleDelete = async (e, id) => {
        e.preventDefault();
        e.stopPropagation();
        if (!confirm('Delete this chat?')) return;

        await deleteSession(id);
        router.refresh();
        if (activeId === id) {
            router.push('/');
        }
    };

    return (
        <div className="flex h-full w-64 flex-col border-r border-zinc-800 bg-zinc-900/50 hidden md:flex">
            <div className="p-4">
                <button
                    onClick={handleNewChat}
                    disabled={isCreating}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                >
                    <Plus className="h-4 w-4" />
                    {isCreating ? 'Creating...' : 'New Chat'}
                </button>
            </div>

            <div className="flex-1 overflow-y-auto px-2">
                <div className="space-y-1">
                    {sessions.map((session) => {
                        const isEditing = editingSessionId === session.id;

                        if (isEditing) {
                            return (
                                <div key={session.id} className="flex items-center gap-2 rounded-lg bg-zinc-800 px-3 py-2 text-sm">
                                    <input
                                        type="text"
                                        value={editTitle}
                                        onChange={(e) => setEditTitle(e.target.value)}
                                        className="w-full bg-transparent text-white outline-none"
                                        autoFocus
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') saveRename(session.id);
                                            if (e.key === 'Escape') cancelRename();
                                        }}
                                    />
                                    <button onClick={() => saveRename(session.id)} className="text-emerald-500 hover:text-emerald-400">
                                        <Check className="h-3.5 w-3.5" />
                                    </button>
                                    <button onClick={cancelRename} className="text-zinc-500 hover:text-zinc-400">
                                        <X className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            );
                        }

                        return (
                            <Link
                                key={session.id}
                                href={`/chat/${session.id}`}
                                className={clsx(
                                    "group flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors",
                                    activeId === session.id
                                        ? "bg-zinc-800 text-white"
                                        : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
                                )}
                            >
                                <div className="flex items-center gap-3 overflow-hidden">
                                    <MessageSquare className="h-4 w-4 shrink-0 opacity-50" />
                                    <span className="truncate">{session.title || 'New Chat'}</span>
                                </div>

                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-zinc-800/50 rounded-md backdrop-blur-sm">
                                    <button
                                        onClick={(e) => startRename(e, session)}
                                        className="p-1.5 hover:text-indigo-400 transition-colors"
                                        title="Rename"
                                    >
                                        <Pencil className="h-3 w-3" />
                                    </button>
                                    <button
                                        onClick={(e) => handleDelete(e, session.id)}
                                        className="p-1.5 hover:text-red-400 transition-colors"
                                        title="Delete"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            </Link>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
