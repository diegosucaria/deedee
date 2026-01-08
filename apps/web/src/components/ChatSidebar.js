'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Plus, MessageSquare, Trash2, Pencil, Check, X, ChevronLeft, ChevronRight, Sidebar as SidebarIcon, Heart, Banknote } from 'lucide-react';
import { clsx } from 'clsx';
import { createSession, deleteSession, updateSession } from '@/app/actions';
import { useState } from 'react';
import { useChatSidebar } from './ChatSidebarProvider';

export default function ChatSidebar({ sessions = [] }) {
    const params = useParams();
    const router = useRouter();
    const activeId = params.id;
    const { isCollapsed, toggleSidebar } = useChatSidebar();
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

    const getSessionIcon = (title) => {
        const lower = (title || '').toLowerCase();
        if (lower.includes('health')) return { Icon: Heart, className: 'text-red-400' };
        if (lower.includes('finance')) return { Icon: Banknote, className: 'text-emerald-400' };
        return { Icon: MessageSquare, className: 'opacity-50' };
    };

    return (
        <div
            onClick={() => isCollapsed && toggleSidebar()}
            className={clsx(
                "flex h-full flex-col border-r border-zinc-800 bg-zinc-900/50 hidden md:flex transition-all duration-300 relative",
                isCollapsed ? "w-16 cursor-pointer" : "w-64"
            )}
        >
            <div className="p-4 flex items-center justify-center">
                <button
                    onClick={(e) => {
                        e.stopPropagation(); // Prevent double-toggle from container
                        handleNewChat();
                    }}
                    disabled={isCreating}
                    className={clsx(
                        "flex items-center justify-center rounded-lg bg-indigo-600 font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50",
                        isCollapsed ? "h-10 w-10 p-0" : "w-full gap-2 px-4 py-2.5 text-sm"
                    )}
                    title="New Chat"
                >
                    <Plus className="h-4 w-4" />
                    {!isCollapsed && (isCreating ? 'Creating...' : 'New Chat')}
                </button>
            </div>

            <div className="flex-1 overflow-y-auto px-2">
                <div className="space-y-1">
                    {sessions.map((session) => {
                        const isEditing = editingSessionId === session.id;
                        const { Icon, className: iconClass } = getSessionIcon(session.title);

                        if (isEditing && !isCollapsed) {
                            return (
                                <div key={session.id}
                                    onClick={(e) => e.stopPropagation()} // Input shouldn't trigger expansion if somehow collapsed (logic prevents this but safe)
                                    className="flex items-center gap-2 rounded-lg bg-zinc-800 px-3 py-2 text-sm"
                                >
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
                                    "group flex items-center rounded-lg py-2 text-sm transition-colors",
                                    activeId === session.id
                                        ? "bg-zinc-800 text-white"
                                        : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200",
                                    isCollapsed ? "justify-center px-0" : "justify-between px-3"
                                )}
                                title={session.title || 'New Chat'}
                            >
                                <div className={clsx("flex items-center overflow-hidden", isCollapsed ? "gap-0" : "gap-3")}>
                                    <Icon className={clsx("h-4 w-4 shrink-0", iconClass)} />
                                    {!isCollapsed && <span className="truncate">{session.title || 'New Chat'}</span>}
                                </div>

                                {!isCollapsed && (
                                    <div
                                        onClick={(e) => e.stopPropagation()}
                                        className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-zinc-800/50 rounded-md backdrop-blur-sm"
                                    >
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
                                )}
                            </Link>
                        );
                    })}
                </div>
            </div>

            {/* Toggle Button */}
            <div className="p-2 border-t border-zinc-800 flex justify-end">
                <button
                    onClick={(e) => {
                        e.stopPropagation(); // Independent toggle
                        toggleSidebar();
                    }}
                    className="p-2 text-zinc-500 hover:text-white transition-colors rounded-lg hover:bg-zinc-800"
                >
                    {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                </button>
            </div>
        </div>
    );
}
