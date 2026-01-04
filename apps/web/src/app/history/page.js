import { fetchAPI } from '@/lib/api';
import HistoryList from '@/components/HistoryList';

export const dynamic = 'force-dynamic';

export default async function HistoryPage({ searchParams }) {
    let history = [];
    const limit = searchParams.limit || 100;
    const since = searchParams.since;
    const order = searchParams.order || 'desc';

    try {
        const query = new URLSearchParams({ limit, order });
        if (since) query.append('since', since);

        const data = await fetchAPI(`/v1/history?${query.toString()}`);
        history = data.history || [];
    } catch (e) {
        console.error('Failed to fetch history:', e);
    }

    return (
        <main className="flex h-screen flex-col bg-zinc-950 text-zinc-200 p-6 md:p-12 overflow-y-auto w-full">
            <header className="mb-8 max-w-5xl mx-auto w-full">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Message History</h1>
                        <p className="text-zinc-400">Raw log of database interactions (Last {limit}).</p>
                    </div>
                </div>
            </header>

            <section className="max-w-5xl mx-auto w-full pb-20">
                <HistoryList history={history} />
            </section>
        </main>
    );
}
