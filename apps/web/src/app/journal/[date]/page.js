import { fetchAPI } from '@/lib/api';
import JournalEditor from '@/components/JournalEditor';
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
        return <div className="p-8 text-red-400">Error loading journal: {err.message}</div>;
    }

    return (
        <div className="p-8 max-w-4xl mx-auto">
            <h1 className="text-3xl font-bold mb-2 flex items-center gap-3">
                <Calendar className="h-8 w-8 text-indigo-400" />
                {date}
            </h1>
            <div className="h-px w-full bg-zinc-800 mb-8" />

            <JournalEditor date={date} initialContent={content} />
        </div>
    );
}
