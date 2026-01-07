'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { MessageSquare, Book, ClipboardList, Database, Activity, Target, Clock, Tags, Terminal, PieChart, ChevronLeft, ChevronRight, Share2, Settings } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

const navItems = [
    { name: 'Chat', href: '/', icon: MessageSquare },
    { name: 'Journal', href: '/journal', icon: Book },
    { name: 'Tasks', href: '/tasks', icon: ClipboardList },
    { name: 'Brain', href: '/brain', icon: Activity },
    { name: 'Logs', href: '/logs', icon: Terminal },
    { name: 'History', href: '/history', icon: Clock },
    { name: 'Interfaces', href: '/interfaces', icon: Share2 },
    { name: 'Stats', href: '/stats', icon: PieChart },
    { name: 'Settings', href: '/settings', icon: Settings },
];


import { useState } from 'react';

export function Sidebar() {
    const pathname = usePathname();
    const [isCollapsed, setIsCollapsed] = useState(false);

    return (
        <div className={clsx(
            "flex h-screen flex-col border-r border-zinc-800 bg-zinc-950 py-4 transition-all duration-300 ease-in-out shrink-0",
            isCollapsed ? "w-16 items-center" : "w-16 md:w-64"
        )}>
            {/* Header */}
            <div className={clsx("flex items-center mb-8 px-4", isCollapsed ? "justify-center" : "justify-between")}>
                <div className="flex items-center">
                    <div className="relative h-8 w-8 shrink-0">
                        <Image
                            src="/logo-square.svg"
                            alt="DeeDee Logo"
                            fill
                            className="object-contain"
                        />
                    </div>
                    <span className={clsx("ml-3 text-lg font-bold tracking-tight text-white overflow-hidden transition-all", isCollapsed ? "w-0 opacity-0 hidden" : "w-auto opacity-100 block")}>
                        DeeDee
                    </span>
                </div>
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
                                "ml-3 text-sm font-medium transition-all overflow-hidden",
                                isCollapsed ? "w-0 opacity-0 hidden" : "w-auto opacity-100 block"
                            )}>
                                {item.name}
                            </span>
                        </Link>
                    );
                })}
            </nav>

            <div className={clsx("mt-auto flex items-center gap-4 border-t border-zinc-800 pt-4 w-full", isCollapsed ? "flex-col px-0" : "flex-col px-4 items-start")}>
                {!isCollapsed && (
                    <div className="w-full space-y-2 mb-2">
                        <div className="flex items-center justify-between text-[10px] text-zinc-500">
                            <span>Agent</span>
                            <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-zinc-500">
                            <span>Brain</span>
                            <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-zinc-500">
                            <span>Supervisor</span>
                            <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                        </div>
                    </div>
                )}

                <div className="flex w-full items-center justify-between">
                    <div className="text-[10px] text-zinc-600 text-center whitespace-nowrap overflow-hidden">
                        {isCollapsed ? 'v0.1' : 'v0.1.0-alpha'}
                    </div>

                    <button
                        onClick={() => setIsCollapsed(!isCollapsed)}
                        className="text-zinc-500 hover:text-white hidden md:block"
                    >
                        {isCollapsed ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
                    </button>
                </div>
            </div>
        </div>
    );
}

