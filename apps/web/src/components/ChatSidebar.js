'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Plus, MessageSquare, Trash2, Pencil, Check, X, ChevronLeft, ChevronRight, ChevronDown, Sidebar as SidebarIcon, Heart, Banknote, Pin, PinOff } from 'lucide-react';
import { clsx } from 'clsx';
import { createSession, deleteSession, updateSession } from '@/app/actions';
import { useState, useMemo } from 'react';
import { useChatSidebar } from './ChatSidebarProvider';

export default function ChatSidebar({ sessions = [] }) {
    const params = useParams();
    const router = useRouter();
    const activeId = params.id;
    const { isCollapsed, toggleSidebar } = useChatSidebar();
    const [isCreating, setIsCreating] = useState(false);
    const [editingSessionId, setEditingSessionId] = useState(null);
    const [editTitle, setEditTitle] = useState('');

    // Default collapsed states per requirement: "last week should be collapsed by default"
    const [collapsedSections, setCollapsedSections] = useState({
        'Last Week': true,
        'Older': true
    });

    const toggleSection = (section) => {
        setCollapsedSections(prev => ({ ...prev, [section]: !prev[section] }));
    };

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

    const togglePin = async (e, session) => {
        e.preventDefault();
        e.stopPropagation();
        await updateSession(session.id, { isPinned: !session.is_pinned });
        router.refresh();
    };

    const handleNewChat = async () => {
        setIsCreating(true);
        try {
            const res = await createSession();
            if (res.success && res.session) {
                router.push(`/chat/${res.session.id}`);
                router.refresh();
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

    // Grouping Logic
    const groupedSessions = useMemo(() => {
        const groups = {
            'Pinned': [],
            'Today': [],
            'Yesterday': [],
            'Last Week': [],
            'Older': []
        };

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const lastWeek = new Date(today);
        lastWeek.setDate(lastWeek.getDate() - 7);

        sessions.forEach(session => {
            if (session.is_pinned) {
                groups['Pinned'].push(session);
                return;
            }

            // Parse Date correctly (Safari/safe)
            const date = new Date(session.updated_at || session.created_at);
            // Normalize to midnight for comparison
            const dateMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());

            if (dateMidnight.getTime() === today.getTime()) {
                groups['Today'].push(session);
            } else if (dateMidnight.getTime() === yesterday.getTime()) {
                groups['Yesterday'].push(session);
            } else if (dateMidnight > lastWeek) {
                groups['Last Week'].push(session);
            } else {
                groups['Older'].push(session);
            }
        });

        return groups;
    }, [sessions]);

    // Helper to render a group
    const renderGroup = (label, items) => {
        if (items.length === 0) return null;

        const isCollapsedSection = collapsedSections[label];
        // Pinned is never collapsible by requirement, but others are.
        // Actually user said "we should be putting them in separators ... last week should be collapsed".
        // Let's make all collapsible except maybe Pinned? Or Pinned too? 
        // Typically Pinned is always visible. Let's keep Pinned always open or user preference.
        // For now, Pinned is open.

        const canCollapse = label !== 'Pinned' && label !== 'Today'; // Maybe keep Today open too? 
        // User asked: "last week should be collapsed by default, and in older...". 
        // Implies Today/Yesterday usually open.
        // Let's allow toggling all for flexibility, but default state handled in useState.

        return (
            <div key={label} className="mb-4">
                <div
                    onClick={() => canCollapse && toggleSection(label)}
                    className={clsx(
                        "flex items-center gap-2 px-3 py-1 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1 select-none",
                        canCollapse ? "cursor-pointer hover:text-zinc-300" : ""
                    )}
                >
                    {canCollapse && (
                        isCollapsedSection ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                    )}
                    {!isCollapsed && <span>{label}</span>}
                    {isCollapsed && <span className="sr-only">{label}</span>} {/* Hide text if sidebar collapsed */}
                </div>

                {!isCollapsedSection && (
                    <div className="space-y-0.5">
                        {items.map(session => renderSessionItem(session))}
                    </div>
                )}
            </div>
        );
    };

    const renderSessionItem = (session) => {
        const isEditing = editingSessionId === session.id;
        const { Icon, className: iconClass } = getSessionIcon(session.title);

        if (isEditing && !isCollapsed) {
            return (
                <div key={session.id}
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-2 rounded-lg bg-zinc-800 px-3 py-2 text-sm mx-2"
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
                    "group flex items-center rounded-lg py-2 text-sm transition-colors relative mx-2",
                    activeId === session.id
                        ? "bg-zinc-800 text-white"
                        : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200",
                    isCollapsed ? "justify-center px-0 mx-0" : "justify-between px-3"
                )}
                title={session.title || 'New Chat'}
            >
                <div className={clsx("flex items-center overflow-hidden min-w-0 flex-1", isCollapsed ? "gap-0" : "gap-3")}>
                    <Icon className={clsx("h-4 w-4 shrink-0", iconClass)} />
                    {!isCollapsed && <span className="truncate">{session.title || 'New Chat'}</span>}
                </div>

                {!isCollapsed && (
                    <div
                        onClick={(e) => e.stopPropagation()}
                        className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-zinc-900/80 rounded-md backdrop-blur-sm absolute right-2 top-1/2 -translate-y-1/2 shadow-lg"
                    >
                        <button
                            onClick={(e) => togglePin(e, session)}
                            className={clsx("p-1.5 hover:text-amber-400 transition-colors", session.is_pinned ? "text-amber-500 opacity-100" : "")}
                            title={session.is_pinned ? "Unpin" : "Pin"}
                        >
                            {session.is_pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                        </button>
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

                {/* Always show pinned icon if collapsed and pinned */}
                {isCollapsed && session.is_pinned && (
                    <div className="absolute top-0 right-0 h-1.5 w-1.5 bg-amber-500 rounded-full animate-pulse" />
                )}
            </Link>
        );
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

            <div className="flex-1 overflow-y-auto px-0 scrollbar-thin scrollbar-thumb-zinc-800">
                {renderGroup('Pinned', groupedSessions['Pinned'])}
                {renderGroup('Today', groupedSessions['Today'])}
                {renderGroup('Yesterday', groupedSessions['Yesterday'])}
                {renderGroup('Last Week', groupedSessions['Last Week'])}
                {renderGroup('Older', groupedSessions['Older'])}

                {/* Fallback if no sessions */}
                {sessions.length === 0 && (
                    <div className="p-4 text-center text-xs text-zinc-500">
                        {!isCollapsed && "No chats yet."}
                    </div>
                )}
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
