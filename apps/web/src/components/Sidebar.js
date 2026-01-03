'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MessageSquare, Book, ClipboardList, Database, Activity, Target, Clock, Tags } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

const navItems = [
    { name: 'Chat', href: '/', icon: MessageSquare },
    { name: 'Journal', href: '/journal', icon: Book },
    { name: 'Tasks', href: '/tasks', icon: ClipboardList },
    { name: 'Goals', href: '/goals', icon: Target },
    { name: 'Memory', href: '/facts', icon: Database },
    { name: 'History', href: '/history', icon: Clock },
    { name: 'Aliases', href: '/aliases', icon: Tags },
    { name: 'Stats', href: '/stats', icon: Activity },
];

export function Sidebar() {
    const pathname = usePathname();

    return (
        <div className="flex h-screen w-16 flex-col items-center border-r border-zinc-800 bg-zinc-950 py-4 transition-all md:w-64 md:items-stretch md:px-4">
            <div className="flex items-center justify-center md:justify-start md:px-2 mb-8">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg shadow-indigo-500/20">
                    <Activity className="h-5 w-5 text-white" />
                </div>
                <span className="hidden ml-3 text-lg font-bold tracking-tight text-white md:block">
                    DeeDee
                </span>
            </div>

            <nav className="flex flex-1 flex-col gap-2">
                {navItems.map((item) => {
                    const isActive = pathname === item.href;
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={twMerge(
                                clsx(
                                    'group flex h-10 w-10 items-center justify-center rounded-xl transition-all md:h-12 md:w-full md:justify-start md:px-4',
                                    isActive
                                        ? 'bg-zinc-800 text-white shadow-sm'
                                        : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200'
                                )
                            )}
                        >
                            <item.icon
                                className={clsx(
                                    'h-5 w-5 transition-colors',
                                    isActive ? 'text-indigo-400' : 'group-hover:text-zinc-200'
                                )}
                            />
                            <span className="hidden ml-3 text-sm font-medium md:block">
                                {item.name}
                            </span>
                        </Link>
                    );
                })}
            </nav>

            <div className="mt-auto flex flex-col items-center gap-4 border-t border-zinc-800 pt-4 md:items-start">
                <div className="text-[10px] text-zinc-600 text-center w-full">
                    v0.1.0-alpha
                </div>
            </div>
        </div>
    );
}
