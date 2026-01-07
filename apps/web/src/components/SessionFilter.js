'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

export default function SessionFilter({ sessions }) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const createQueryString = useCallback(
        (name, value) => {
            const params = new URLSearchParams(searchParams.toString());
            if (value) {
                params.set(name, value);
            } else {
                params.delete(name);
            }
            // Reset pagination if needed
            // params.delete('page');
            return params.toString();
        },
        [searchParams]
    );

    const currentChatId = searchParams.get('chatId') || '';

    const handleChange = (e) => {
        const chatId = e.target.value;
        router.push(pathname + '?' + createQueryString('chatId', chatId));
    };

    return (
        <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-400">Filter by Session:</span>
            <select
                value={currentChatId}
                onChange={handleChange}
                className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block p-2.5"
            >
                <option value="">All History</option>
                {sessions.map((session) => (
                    <option key={session.id} value={session.id}>
                        {session.title || session.id} ({new Date(session.updated_at).toLocaleDateString()})
                    </option>
                ))}
            </select>
        </div>
    );
}
