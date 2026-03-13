'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

function labelForChatId(chatId) {
    if (!chatId) return null;
    if (chatId.startsWith('subagent-')) return `Subagent: ${chatId.replace('subagent-', '')}`;
    if (chatId.startsWith('scheduled_')) return `Scheduled: ${chatId.replace('scheduled_', '')}`;
    if (chatId.startsWith('system_')) return `System: ${chatId.replace('system_', '')}`;
    if (chatId.includes('@s.us') || chatId.includes('@g.us')) return `WhatsApp: ${chatId}`;
    return chatId;
}

export default function SessionFilter({ sessions, chatId: serverChatId }) {
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
            return params.toString();
        },
        [searchParams]
    );

    const currentChatId = searchParams.get('chatId') || '';

    const handleChange = (e) => {
        const chatId = e.target.value;
        router.push(pathname + '?' + createQueryString('chatId', chatId));
    };

    // Check if the current chatId is in the sessions list
    const chatIdInSessions = sessions.some(s => s.id === currentChatId);
    const showSpecialEntry = currentChatId && !chatIdInSessions;

    return (
        <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-400">Session:</span>
            <select
                value={currentChatId}
                onChange={handleChange}
                className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block p-2.5 max-w-[280px]"
            >
                <option value="">All History</option>
                {showSpecialEntry && (
                    <option value={currentChatId}>
                        {labelForChatId(currentChatId)}
                    </option>
                )}
                {sessions.map((session) => (
                    <option key={session.id} value={session.id}>
                        {session.title || session.id} ({new Date(session.updated_at).toLocaleDateString()})
                    </option>
                ))}
            </select>
        </div>
    );
}
