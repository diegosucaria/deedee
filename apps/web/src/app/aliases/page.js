import { fetchAPI } from '@/lib/api';
import AliasList from '@/components/AliasList';

export const dynamic = 'force-dynamic';

export default async function AliasesPage() {
    let aliases = [];
    try {
        const data = await fetchAPI('/v1/aliases');
        aliases = data.aliases || [];
    } catch (e) {
        console.error('Failed to fetch aliases:', e);
    }

    return (
        <main className="flex h-screen flex-col bg-zinc-950 text-zinc-200 p-6 md:p-12 overflow-y-auto w-full">
            <header className="mb-8 max-w-6xl mx-auto w-full">
                <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Entity Aliases</h1>
                <p className="text-zinc-400">Map natural language names to Smart Home entity IDs.</p>
            </header>

            <section className="max-w-6xl mx-auto w-full">
                <AliasList aliases={aliases} />
            </section>
        </main>
    );
}
