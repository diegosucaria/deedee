import { fetchAPI } from '@/lib/api';
import MemoryList from '@/components/MemoryList';

export const dynamic = 'force-dynamic';

export default async function FactsPage() {
    let facts = [];
    try {
        const data = await fetchAPI('/v1/facts');
        facts = data.facts || [];
    } catch (e) {
        console.error('Failed to fetch facts:', e);
    }

    return (
        <main className="flex h-screen flex-col bg-zinc-950 text-zinc-200 p-6 md:p-12 overflow-y-auto w-full">
            <header className="mb-8 max-w-4xl mx-auto w-full">
                <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Memory Bank</h1>
                <p className="text-zinc-400">Key-Value store for long-term agent memory.</p>
            </header>

            <section className="max-w-4xl mx-auto w-full pb-20">
                <MemoryList facts={facts} />
            </section>
        </main>
    );
}
