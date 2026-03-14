'use client';

import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, Info, AlertCircle, CheckCheck, Trash2, Eye, X, ExternalLink, Bell } from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';
import {
    getNotifications,
    markNotificationRead,
    markAllNotificationsRead,
    dismissNotification,
    dismissAllNotifications,
    deleteNotification,
} from '@/app/actions';
import Link from 'next/link';
import { clsx } from 'clsx';

const SEVERITY_CONFIG = {
    info: { icon: Info, color: 'text-blue-400', bg: 'bg-blue-400/10', border: 'border-blue-400/20' },
    warning: { icon: AlertTriangle, color: 'text-amber-400', bg: 'bg-amber-400/10', border: 'border-amber-400/20' },
    error: { icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-400/10', border: 'border-red-400/20' },
};

const SEVERITY_OPTIONS = ['all', 'error', 'warning', 'info'];
const STATUS_OPTIONS = ['active', 'unread', 'dismissed'];

function timeAgo(dateStr) {
    if (!dateStr) return '';
    // Append 'Z' if the timestamp lacks timezone info (e.g. SQLite CURRENT_TIMESTAMP format)
    const normalized = typeof dateStr === 'string' && !dateStr.includes('T') && !dateStr.includes('Z') && !dateStr.includes('+')
        ? dateStr.replace(' ', 'T') + 'Z'
        : dateStr;
    const seconds = Math.floor((Date.now() - new Date(normalized).getTime()) / 1000);
    if (isNaN(seconds) || seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(normalized).toLocaleDateString();
}

export default function NotificationsClient({ initialNotifications, initialUnreadCount }) {
    const [notifications, setNotifications] = useState(initialNotifications);
    const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
    const [severityFilter, setSeverityFilter] = useState('all');
    const [statusFilter, setStatusFilter] = useState('active');
    const { socket } = useSocket();

    // Real-time updates
    useEffect(() => {
        if (!socket) return;
        const handler = (notification) => {
            setNotifications(prev => [notification, ...prev]);
            setUnreadCount(prev => prev + 1);
        };
        socket.on('notification:new', handler);
        return () => socket.off('notification:new', handler);
    }, [socket]);

    const refresh = useCallback(async () => {
        const data = await getNotifications(100, true, true);
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
    }, []);

    const handleMarkRead = async (id) => {
        await markNotificationRead(id);
        setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
        setUnreadCount(prev => Math.max(0, prev - 1));
    };

    const handleMarkAllRead = async () => {
        await markAllNotificationsRead();
        setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
        setUnreadCount(0);
    };

    const handleDismiss = async (id) => {
        await dismissNotification(id);
        setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_dismissed: true } : n));
    };

    const handleDismissAll = async () => {
        await dismissAllNotifications();
        setNotifications(prev => prev.map(n => ({ ...n, is_dismissed: true })));
    };

    const handleDelete = async (id) => {
        await deleteNotification(id);
        setNotifications(prev => prev.filter(n => n.id !== id));
    };

    // Filter notifications
    const filtered = notifications.filter(n => {
        if (severityFilter !== 'all' && n.severity !== severityFilter) return false;
        if (statusFilter === 'active' && n.is_dismissed) return false;
        if (statusFilter === 'unread' && (n.is_read || n.is_dismissed)) return false;
        if (statusFilter === 'dismissed' && !n.is_dismissed) return false;
        return true;
    });

    return (
        <div>
            {/* Toolbar */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
                {/* Filters */}
                <div className="flex flex-wrap gap-2">
                    {/* Severity Filter */}
                    <div className="flex bg-zinc-900/50 p-1 rounded-lg border border-zinc-800">
                        {SEVERITY_OPTIONS.map(opt => (
                            <button
                                key={opt}
                                onClick={() => setSeverityFilter(opt)}
                                className={clsx(
                                    "px-3 py-1 rounded-md text-xs font-medium transition-all capitalize",
                                    severityFilter === opt
                                        ? "bg-zinc-800 text-white shadow-sm"
                                        : "text-zinc-400 hover:text-white hover:bg-zinc-800/50"
                                )}
                            >
                                {opt}
                            </button>
                        ))}
                    </div>

                    {/* Status Filter */}
                    <div className="flex bg-zinc-900/50 p-1 rounded-lg border border-zinc-800">
                        {STATUS_OPTIONS.map(opt => (
                            <button
                                key={opt}
                                onClick={() => setStatusFilter(opt)}
                                className={clsx(
                                    "px-3 py-1 rounded-md text-xs font-medium transition-all capitalize",
                                    statusFilter === opt
                                        ? "bg-zinc-800 text-white shadow-sm"
                                        : "text-zinc-400 hover:text-white hover:bg-zinc-800/50"
                                )}
                            >
                                {opt}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Bulk Actions */}
                <div className="flex gap-2">
                    {unreadCount > 0 && (
                        <button
                            onClick={handleMarkAllRead}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-400 hover:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 rounded-lg border border-indigo-500/20 transition-colors"
                        >
                            <CheckCheck className="w-3.5 h-3.5" />
                            Mark all read
                        </button>
                    )}
                    <button
                        onClick={handleDismissAll}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg border border-zinc-700 transition-colors"
                    >
                        <X className="w-3.5 h-3.5" />
                        Dismiss all
                    </button>
                </div>
            </div>

            {/* Notification List */}
            {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
                    <Bell className="w-12 h-12 mb-3 opacity-30" />
                    <span className="text-sm">No notifications match your filters</span>
                    <button
                        onClick={() => { setSeverityFilter('all'); setStatusFilter('active'); }}
                        className="mt-2 text-xs text-indigo-400 hover:text-indigo-300"
                    >
                        Reset filters
                    </button>
                </div>
            ) : (
                <div className="space-y-2">
                    {filtered.map(notification => {
                        const config = SEVERITY_CONFIG[notification.severity] || SEVERITY_CONFIG.info;
                        const SeverityIcon = config.icon;
                        const link = notification.metadata?.link;

                        return (
                            <div
                                key={notification.id}
                                className={clsx(
                                    "flex gap-4 p-4 rounded-xl border transition-colors",
                                    notification.is_dismissed
                                        ? "bg-zinc-950/50 border-zinc-800/50 opacity-60"
                                        : notification.is_read
                                            ? "bg-zinc-900/30 border-zinc-800"
                                            : "bg-zinc-900/50 border-zinc-800",
                                )}
                            >
                                {/* Severity Icon */}
                                <div className={clsx("shrink-0 p-2 rounded-lg h-fit", config.bg)}>
                                    <SeverityIcon className={clsx("w-5 h-5", config.color)} />
                                </div>

                                {/* Content */}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="flex items-center gap-2">
                                            <h3 className={clsx(
                                                "text-sm",
                                                !notification.is_read && !notification.is_dismissed
                                                    ? "text-white font-semibold"
                                                    : "text-zinc-300 font-medium"
                                            )}>
                                                {notification.title}
                                            </h3>
                                            {!notification.is_read && !notification.is_dismissed && (
                                                <span className="w-2 h-2 rounded-full bg-indigo-400 shrink-0" />
                                            )}
                                        </div>
                                        <span className="text-[10px] text-zinc-600 whitespace-nowrap shrink-0">
                                            {timeAgo(notification.created_at)}
                                        </span>
                                    </div>

                                    <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                                        {notification.message}
                                    </p>

                                    {/* Metadata details */}
                                    {notification.metadata && (notification.metadata.toolName || notification.metadata.chatId) && (
                                        <div className="flex flex-wrap gap-2 mt-2">
                                            {notification.metadata.toolName && (
                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
                                                    {notification.metadata.toolName}
                                                </span>
                                            )}
                                            {notification.metadata.originalChars && (
                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
                                                    {notification.metadata.originalChars.toLocaleString()} chars
                                                </span>
                                            )}
                                            {notification.metadata.source && (
                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
                                                    {notification.metadata.source}
                                                </span>
                                            )}
                                        </div>
                                    )}

                                    {/* Actions */}
                                    <div className="flex items-center gap-3 mt-3">
                                        {link && (
                                            <Link
                                                href={link}
                                                className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                                            >
                                                <ExternalLink className="w-3 h-3" />
                                                View details
                                            </Link>
                                        )}
                                        {!notification.is_read && !notification.is_dismissed && (
                                            <button
                                                onClick={() => handleMarkRead(notification.id)}
                                                className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                                            >
                                                <Eye className="w-3 h-3" />
                                                Mark read
                                            </button>
                                        )}
                                        {!notification.is_dismissed && (
                                            <button
                                                onClick={() => handleDismiss(notification.id)}
                                                className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                                            >
                                                <X className="w-3 h-3" />
                                                Dismiss
                                            </button>
                                        )}
                                        <button
                                            onClick={() => handleDelete(notification.id)}
                                            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-red-400 transition-colors"
                                        >
                                            <Trash2 className="w-3 h-3" />
                                            Delete
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Summary */}
            <div className="mt-6 text-xs text-zinc-600 text-center">
                Showing {filtered.length} of {notifications.length} notifications
            </div>
        </div>
    );
}
