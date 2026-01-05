import { fetchAPI } from '@/lib/api';
import BrainTabs from '@/components/BrainTabs';

export const dynamic = 'force-dynamic';

export default async function BrainPage() {
    // Parallel data fetching
    const [goalsData, factsData, aliasesData] = await Promise.all([
        fetchAPI('/v1/goals').catch(e => ({ goals: [] })),
        fetchAPI('/v1/facts').catch(e => ({ facts: [] })),
        fetchAPI('/v1/aliases').catch(e => ({ aliases: [] }))
    ]);

    return (
        <main className="flex h-screen flex-col bg-zinc-950 text-zinc-200 p-6 md:p-12 overflow-y-auto w-full">
            <header className="mb-8 max-w-5xl mx-auto w-full">
                <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Agent Brain</h1>
                <p className="text-zinc-400">Manage internal state, memory, and objectives.</p>
            </header>

            <section className="max-w-5xl mx-auto w-full pb-20">
                <BrainTabs
                    goals={goalsData.goals || []}
                    facts={factsData.facts || []}
                    aliases={aliasesData.aliases || []}
                />
            </section>
        </main>
    );
}
