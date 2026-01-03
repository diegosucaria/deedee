
import { fetchAPI } from '@/lib/api';
import ReactMarkdown from 'react-markdown';
import { Calendar } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function JournalDetailPage({ params }) {
    const { date } = params;
    let content = '';

    try {
        const data = await fetchAPI(`/v1/journal/${date}`);
        content = data.content || '';
    } catch (err) {
        console.error('Journal detail error:', err);
        content = 'Error loading journal entry.';
    }

    return (
        <div className="p-8 max-w-4xl mx-auto">
            <h1 className="text-3xl font-bold mb-2 flex items-center gap-3">
                <Calendar className="h-8 w-8 text-indigo-400" />
                {date}
            </h1>
            <div className="h-px w-full bg-zinc-800 mb-8" />

            <div className="markdown prose prose-invert max-w-none bg-zinc-900/50 p-8 rounded-2xl border border-zinc-800">
                <ReactMarkdown>{content}</ReactMarkdown>
            </div>
        </div>
    );
}
