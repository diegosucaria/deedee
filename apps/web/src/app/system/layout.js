'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Clock, Terminal } from 'lucide-react';

export default function SystemLayout({ children }) {
    const pathname = usePathname();

    const tabs = [
        { name: 'Stats', href: '/system/stats', icon: Activity },
        { name: 'History', href: '/system/history', icon: Clock },
        { name: 'Logs', href: '/system/logs', icon: Terminal },
    ];

    return (
        <div className="flex h-screen flex-col bg-zinc-950 text-zinc-200 p-6 md:p-12 overflow-y-auto w-full">
            <header className="mb-8 max-w-6xl mx-auto w-full">
                <h1 className="text-3xl font-bold tracking-tight text-white mb-2 flex items-center gap-3">
                    System Internals
                </h1>
                <p className="text-zinc-400">Monitor and debug the agent's brain and operations.</p>

                <div className="flex space-x-1 mt-6 bg-zinc-900/50 p-1 rounded-lg border border-zinc-800 w-fit">
                    {tabs.map(tab => {
                        const isActive = pathname.startsWith(tab.href);
                        return (
                            <Link
                                key={tab.name}
                                href={tab.href}
                                className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${isActive
                                    ? 'bg-zinc-800 text-white shadow-sm'
                                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800/50'
                                    }`}
                            >
                                <tab.icon className="w-4 h-4" />
                                {tab.name}
                            </Link>
                        );
                    })}
                </div>
            </header>

            <div className="max-w-6xl mx-auto w-full pb-20">
                {children}
            </div>
        </div>
    );
}
