import { fetchAPI } from '@/lib/api';
import GoalList from '@/components/GoalList';

export const dynamic = 'force-dynamic';

export default async function GoalsPage() {
    let goals = [];
    try {
        const data = await fetchAPI('/v1/goals');
        goals = data.goals || [];
    } catch (e) {
        console.error('Failed to fetch goals:', e);
    }

    return (
        <main className="flex h-screen flex-col bg-zinc-950 text-zinc-200 p-6 md:p-12 overflow-y-auto w-full">
            <header className="mb-8 max-w-4xl mx-auto w-full">
                <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Goals</h1>
                <p className="text-zinc-400">Track and manage long-term objectives.</p>
            </header>

            <section className="max-w-4xl mx-auto w-full">
                <GoalList goals={goals} />
            </section>
        </main>
    );
}
