import { fetchAPI } from '@/lib/api';
import HistoryList from '@/components/HistoryList';
import SummaryList from '@/components/SummaryList';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function HistoryPage({ searchParams }) {
    const view = searchParams.view || 'messages'; // 'messages' or 'summaries'
    let history = [];
    let summaries = [];

    const limit = searchParams.limit || 100;
    const since = searchParams.since;
    const order = searchParams.order || 'desc';

    try {
        if (view === 'messages') {
            const query = new URLSearchParams({ limit, order });
            if (since) query.append('since', since);
            const data = await fetchAPI(`/v1/history?${query.toString()}`);
            history = data.history || [];
        } else {
            const data = await fetchAPI('/v1/summaries?limit=50');
            summaries = data.summaries || [];
        }
    } catch (e) {
        console.error('Failed to fetch data:', e);
    }

    return (
        <main className="flex h-screen flex-col bg-zinc-950 text-zinc-200 p-6 md:p-12 overflow-y-auto w-full">
            <header className="mb-8 max-w-5xl mx-auto w-full">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Message History</h1>
                        <p className="text-zinc-400">
                            {view === 'messages' ? `Raw log of database interactions (Last ${limit}).` : 'Compressed summaries of past conversations.'}
                        </p>
                    </div>
                </div>

                {/* Tabs */}
                <div className="flex gap-4 mt-6 border-b border-zinc-800">
                    <Link
                        href="/history?view=messages"
                        className={`pb-2 text-sm font-medium transition-colors ${view === 'messages' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                    >
                        Messages
                    </Link>
                    <Link
                        href="/history?view=summaries"
                        className={`pb-2 text-sm font-medium transition-colors ${view === 'summaries' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                    >
                        Summaries (Memory)
                    </Link>
                </div>
            </header>

            <section className="max-w-5xl mx-auto w-full pb-20">
                {view === 'messages' ? (
                    <HistoryList history={history} />
                ) : (
                    <SummaryList summaries={summaries} />
                )}
            </section>
        </main>
    );
}
