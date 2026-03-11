'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Bell, AlertTriangle, Info, AlertCircle, CheckCheck, ExternalLink } from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';
import { getNotifications, markNotificationRead, markAllNotificationsRead } from '@/app/actions';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { clsx } from 'clsx';

const SEVERITY_CONFIG = {
    info: { icon: Info, color: 'text-blue-400', bg: 'bg-blue-400/10' },
    warning: { icon: AlertTriangle, color: 'text-amber-400', bg: 'bg-amber-400/10' },
    error: { icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-400/10' },
};

function timeAgo(dateStr) {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

export default function NotificationBell() {
    const [isOpen, setIsOpen] = useState(false);
    const [notifications, setNotifications] = useState([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [pulse, setPulse] = useState(false);
    const { socket } = useSocket();
    const dropdownRef = useRef(null);
    const bellRef = useRef(null);

    const fetchNotifications = useCallback(async () => {
        const data = await getNotifications(10);
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
    }, []);

    // Fetch initial data
    useEffect(() => {
        fetchNotifications();
    }, [fetchNotifications]);

    // Real-time updates via Socket.io
    useEffect(() => {
        if (!socket) return;
        const handler = (notification) => {
            setNotifications(prev => [notification, ...prev].slice(0, 10));
            setUnreadCount(prev => prev + 1);
            setPulse(true);
            setTimeout(() => setPulse(false), 3000);
        };
        socket.on('notification:new', handler);
        return () => socket.off('notification:new', handler);
    }, [socket]);

    // Click outside to close
    useEffect(() => {
        if (!isOpen) return;
        const handler = (e) => {
            if (
                dropdownRef.current && !dropdownRef.current.contains(e.target) &&
                bellRef.current && !bellRef.current.contains(e.target)
            ) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [isOpen]);

    const handleMarkAllRead = async () => {
        await markAllNotificationsRead();
        setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
        setUnreadCount(0);
    };

    const handleNotificationClick = async (notification) => {
        if (!notification.is_read) {
            await markNotificationRead(notification.id);
            setNotifications(prev =>
                prev.map(n => n.id === notification.id ? { ...n, is_read: true } : n)
            );
            setUnreadCount(prev => Math.max(0, prev - 1));
        }
        setIsOpen(false);
    };

    return (
        <div className="relative">
            {/* Bell Button */}
            <button
                ref={bellRef}
                onClick={() => {
                    setIsOpen(!isOpen);
                    if (!isOpen) fetchNotifications();
                }}
                className={clsx(
                    "relative p-2 rounded-lg transition-colors",
                    "text-zinc-500 hover:text-white hover:bg-zinc-900",
                    isOpen && "text-white bg-zinc-900"
                )}
                title="Notifications"
            >
                <Bell className={clsx("w-5 h-5", pulse && "animate-[ring_0.5s_ease-in-out_2]")} />

                {/* Unread Badge */}
                {unreadCount > 0 && (
                    <span className={clsx(
                        "absolute -top-0.5 -right-0.5 flex items-center justify-center",
                        "min-w-[18px] h-[18px] px-1 rounded-full",
                        "bg-red-500 text-white text-[10px] font-bold leading-none",
                        pulse && "animate-pulse"
                    )}>
                        {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                )}
            </button>

            {/* Dropdown */}
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        ref={dropdownRef}
                        initial={{ opacity: 0, y: -4, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -4, scale: 0.95 }}
                        transition={{ duration: 0.15 }}
                        className={clsx(
                            "fixed md:absolute z-50",
                            // Mobile: centered overlay
                            "inset-x-4 top-16 md:inset-x-auto md:top-auto",
                            // Desktop: positioned to the right of the bell
                            "md:left-full md:ml-2 md:mt-0",
                            "w-auto md:w-96",
                            "bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl",
                            "max-h-[70vh] md:max-h-[480px] flex flex-col overflow-hidden"
                        )}
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
                            <span className="text-sm font-semibold text-white">Notifications</span>
                            {unreadCount > 0 && (
                                <button
                                    onClick={handleMarkAllRead}
                                    className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                                >
                                    <CheckCheck className="w-3.5 h-3.5" />
                                    Mark all read
                                </button>
                            )}
                        </div>

                        {/* Notification List */}
                        <div className="overflow-y-auto flex-1">
                            {notifications.length === 0 ? (
                                <div className="flex flex-col items-center justify-center py-10 text-zinc-500">
                                    <Bell className="w-8 h-8 mb-2 opacity-40" />
                                    <span className="text-sm">No notifications</span>
                                </div>
                            ) : (
                                notifications.map(notification => {
                                    const config = SEVERITY_CONFIG[notification.severity] || SEVERITY_CONFIG.info;
                                    const SeverityIcon = config.icon;
                                    const link = notification.metadata?.link;

                                    const content = (
                                        <div
                                            className={clsx(
                                                "flex gap-3 px-4 py-3 transition-colors cursor-pointer",
                                                "hover:bg-zinc-800/50",
                                                !notification.is_read && "bg-zinc-800/30"
                                            )}
                                            onClick={() => handleNotificationClick(notification)}
                                        >
                                            <div className={clsx("mt-0.5 shrink-0 p-1.5 rounded-lg", config.bg)}>
                                                <SeverityIcon className={clsx("w-4 h-4", config.color)} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-start justify-between gap-2">
                                                    <p className={clsx(
                                                        "text-sm leading-tight",
                                                        notification.is_read ? "text-zinc-400" : "text-zinc-200 font-medium"
                                                    )}>
                                                        {notification.title}
                                                    </p>
                                                    {!notification.is_read && (
                                                        <span className="shrink-0 w-2 h-2 mt-1.5 rounded-full bg-indigo-400" />
                                                    )}
                                                </div>
                                                <p className="text-xs text-zinc-500 mt-0.5 line-clamp-2">
                                                    {notification.message}
                                                </p>
                                                <div className="flex items-center gap-2 mt-1">
                                                    <span className="text-[10px] text-zinc-600">{timeAgo(notification.created_at)}</span>
                                                    {link && (
                                                        <ExternalLink className="w-3 h-3 text-zinc-600" />
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    );

                                    return link ? (
                                        <Link key={notification.id} href={link}>
                                            {content}
                                        </Link>
                                    ) : (
                                        <div key={notification.id}>{content}</div>
                                    );
                                })
                            )}
                        </div>

                        {/* Footer */}
                        <div className="border-t border-zinc-800 px-4 py-2">
                            <Link
                                href="/system/notifications"
                                onClick={() => setIsOpen(false)}
                                className="block text-center text-xs text-indigo-400 hover:text-indigo-300 transition-colors py-1"
                            >
                                View all notifications
                            </Link>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
