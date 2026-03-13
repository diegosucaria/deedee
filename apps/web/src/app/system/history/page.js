import { fetchAPI } from '@/lib/api';
import HistoryList from '@/components/HistoryList';
import SummaryList from '@/components/SummaryList';
import SessionFilter from '@/components/SessionFilter';
import { getSessions } from '../../actions';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function HistoryPage({ searchParams }) {
    const view = searchParams.view || 'messages'; // 'messages' or 'summaries'
    let history = [];
    let summaries = [];
    let sessions = [];
    let subagent = null;

    const limit = searchParams.limit || 100;
    const since = searchParams.since;
    const order = searchParams.order || 'desc';
    const chatId = searchParams.chatId;
    const source = searchParams.source || '';

    try {
        if (view === 'messages') {
            const query = new URLSearchParams({ limit, order });
            if (since) query.append('since', since);
            if (chatId) query.append('chatId', chatId);
            if (source) query.append('source', source);

            const [historyData, sessionsData] = await Promise.all([
                fetchAPI(`/v1/history?${query.toString()}`),
                getSessions(100)
            ]);

            history = historyData.history || [];
            sessions = sessionsData || [];
            subagent = historyData.subagent || null;
        } else {
            const data = await fetchAPI('/v1/summaries?limit=50');
            summaries = data.summaries || [];
        }
    } catch (e) {
        console.error('Failed to fetch data:', e);
    }

    return (
        <div className="flex flex-col text-zinc-200 w-full">
            <header className="mb-8 w-full">
                <div className="flex items-center justify-between flex-wrap gap-4">
                    <div>
                        <h2 className="text-xl font-semibold text-white mb-1">Message History</h2>
                        <p className="text-zinc-400 text-sm">
                            {view === 'messages' ? `Raw log of database interactions (Last ${limit}).` : 'Compressed summaries of past conversations.'}
                        </p>
                    </div>
                    {view === 'messages' && (
                        <SessionFilter sessions={sessions} chatId={chatId} />
                    )}
                </div>

                {/* Sub-tabs */}
                <div className="flex gap-1 mt-6 border-b border-zinc-800">
                    <Link
                        href="/system/history?view=messages"
                        className={`px-4 py-3 text-sm font-medium transition-all rounded-t-lg relative bottom-[-1px] ${view === 'messages' ? 'text-indigo-400 border-b-2 border-indigo-500 bg-zinc-900/50' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/30'}`}
                    >
                        Messages
                    </Link>
                    <Link
                        href="/system/history?view=summaries"
                        className={`px-4 py-3 text-sm font-medium transition-all rounded-t-lg relative bottom-[-1px] ${view === 'summaries' ? 'text-indigo-400 border-b-2 border-indigo-500 bg-zinc-900/50' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/30'}`}
                    >
                        Summaries (Memory)
                    </Link>
                </div>
            </header>

            <section className="w-full pb-20">
                {view === 'messages' ? (
                    <HistoryList history={history} subagent={subagent} />
                ) : (
                    <SummaryList summaries={summaries} />
                )}
            </section>
        </div>
    );
}
