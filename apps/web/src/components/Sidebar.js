'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { MessageSquare, ClipboardList, Database, Activity, Target, Clock, Tags, Terminal, PieChart, ChevronLeft, ChevronRight, Share2, Settings, Mic, Lock, Users, Disc, ShieldAlert } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useState } from 'react';
import NotificationBell from './NotificationBell';
import { useHealthStatus } from '@/hooks/useHealthStatus';

const navItems = [
    { name: 'Chat', href: '/', icon: MessageSquare },
    { name: 'Live', href: '/live', icon: Mic },
    { name: 'Tasks', href: '/tasks', icon: ClipboardList },
    { name: 'Brain', href: '/brain', icon: Activity },
    { name: 'DJ Crate', href: '/dj', icon: Disc },
    { name: 'Life Vaults', href: '/vaults', icon: Database },
    { name: 'People', href: '/people', icon: Users },
    { name: 'Autopilot', href: '/autopilot', icon: ShieldAlert },
    { name: 'Settings', href: '/settings', icon: Settings },
    { name: 'System', href: '/system', icon: Terminal },
];

const STATUS_CONFIG = {
    ok:       { color: 'bg-emerald-500', shadow: 'shadow-[0_0_8px_rgba(16,185,129,0.5)]', label: 'Healthy' },
    degraded: { color: 'bg-amber-500',   shadow: 'shadow-[0_0_8px_rgba(245,158,11,0.5)]', label: 'Degraded' },
    error:    { color: 'bg-red-500',      shadow: 'shadow-[0_0_8px_rgba(239,68,68,0.5)]',  label: 'Down' },
    unknown:  { color: 'bg-zinc-600',     shadow: '',                                       label: 'Unknown' },
};

function StatusDot({ status, detail }) {
    const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.unknown;
    const tooltip = detail ? `${cfg.label}: ${detail}` : cfg.label;

    return (
        <span
            title={tooltip}
            className={clsx('w-2 h-2 rounded-full shrink-0', cfg.color, cfg.shadow)}
        />
    );
}

export function Sidebar() {
    const pathname = usePathname();
    const [isCollapsed, setIsCollapsed] = useState(false);
    const health = useHealthStatus();

    return (
        <div className={clsx(
            "flex h-screen flex-col border-r border-zinc-800 bg-zinc-950 py-4 transition-all duration-300 ease-in-out shrink-0",
            isCollapsed ? "w-16 items-center" : "w-16 md:w-52"
        )}>
            {/* Header */}
            <div className={clsx(
                "flex items-center mb-4 px-4",
                isCollapsed ? "justify-center flex-col gap-3" : "justify-between flex-col md:flex-row gap-3 md:gap-0"
            )}>
                <div className="flex items-center">
                    <div className="relative h-8 w-8 shrink-0">
                        <Image
                            src="/logo-square.svg"
                            alt="DeeDee Logo"
                            fill
                            className="object-contain"
                        />
                    </div>
                    <span className={clsx("ml-3 text-lg font-bold tracking-tight text-white overflow-hidden transition-all hidden md:block", isCollapsed ? "w-0 opacity-0" : "w-auto opacity-100")}>
                        DeeDee
                    </span>
                </div>
                <NotificationBell />
            </div>

            <nav className="flex flex-1 flex-col gap-2 px-2 w-full">
                {navItems.map((item) => {
                    const isActive = pathname === item.href;
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            title={isCollapsed ? item.name : ''}
                            className={twMerge(
                                clsx(
                                    'group flex h-10 items-center rounded-xl transition-all',
                                    isCollapsed ? 'justify-center w-full' : 'w-full justify-start px-4',
                                    isActive
                                        ? 'bg-zinc-800 text-white shadow-sm'
                                        : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200'
                                )
                            )}
                        >
                            <item.icon
                                className={clsx(
                                    'h-5 w-5 transition-colors shrink-0',
                                    isActive ? 'text-indigo-400' : 'group-hover:text-zinc-200'
                                )}
                            />
                            <span className={clsx(
                                "ml-3 text-sm font-medium transition-all overflow-hidden hidden md:block",
                                isCollapsed ? "w-0 opacity-0" : "w-auto opacity-100"
                            )}>
                                {item.name}
                            </span>
                        </Link>
                    );
                })}
            </nav>

            <div className={clsx("mt-auto flex items-center gap-4 border-t border-zinc-800 pt-4 w-full", isCollapsed ? "flex-col px-0" : "flex-col px-4 items-start")}>
                {!isCollapsed && (
                    <div className="w-full space-y-2 mb-2 hidden md:block">
                        <div className="flex items-center justify-between text-[10px] text-zinc-500">
                            <span>Agent</span>
                            <StatusDot status={health.agent.status} detail={health.agent.detail} />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-zinc-500">
                            <span>API</span>
                            <StatusDot status={health.api.status} detail={health.api.detail} />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-zinc-500">
                            <span>Supervisor</span>
                            <StatusDot status={health.supervisor.status} detail={health.supervisor.detail} />
                        </div>
                    </div>
                )}

                <div className="flex w-full items-center justify-between">
                    <div className="text-[10px] text-zinc-600 text-center whitespace-nowrap overflow-hidden hidden md:block">
                        {isCollapsed ? 'v0.1' : 'v0.1.0-alpha'}
                    </div>

                    <button
                        onClick={() => setIsCollapsed(!isCollapsed)}
                        className="text-zinc-500 hover:text-white hidden md:flex items-center justify-center p-2 rounded-lg hover:bg-zinc-900 transition-colors"
                        title={isCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
                    >
                        {isCollapsed ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
                    </button>
                </div>
            </div>
        </div>
    );
}
