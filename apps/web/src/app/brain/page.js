import { fetchAPI } from '@/lib/api';
import BrainTabs from '@/components/BrainTabs';
import { getTools, getMCPStatus } from '../actions';
import { Activity } from 'lucide-react';
import PageShell from '@/components/PageShell';

export const dynamic = 'force-dynamic';

export default async function BrainPage() {
    // Parallel data fetching
    const [goalsData, factsData, aliasesData, tools, servers] = await Promise.all([
        fetchAPI('/v1/goals').catch(e => ({ goals: [] })),
        fetchAPI('/v1/facts').catch(e => ({ facts: [] })),
        fetchAPI('/v1/aliases').catch(e => ({ aliases: [] })),
        getTools(),
        getMCPStatus()
    ]);

    return (
        <PageShell icon={Activity} title="Agent Brain" subtitle="Manage internal state, memory, and objectives.">
            <BrainTabs
                goals={goalsData.goals || []}
                facts={factsData.facts || []}
                aliases={aliasesData.aliases || []}
                tools={tools || []}
                servers={servers || []}
            />
        </PageShell>
    );
}
