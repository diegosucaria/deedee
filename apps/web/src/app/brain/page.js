import { fetchAPI } from '@/lib/api';
import BrainTabs from '@/components/BrainTabs';
import { getTools, getMCPStatus } from '../actions';
import { Activity } from 'lucide-react';
import PageShell from '@/components/PageShell';

export const dynamic = 'force-dynamic';

// Which tabs need which data. Approvals, the guardian, the journal, skills
// and browser secrets load their own, so opening one of those from the
// sidebar does not wait for goals, facts, aliases and the tool list.
const NEEDS = {
    goals: ['goals'],
    memory: ['facts'],
    aliases: ['aliases'],
    tools: ['tools'],
};

export default async function BrainPage({ searchParams }) {
    const params = await searchParams;
    const tab = typeof params?.tab === 'string' ? params.tab : 'journal';
    const needs = new Set(NEEDS[tab] || []);
    const [goalsData, factsData, aliasesData, tools, servers] = await Promise.all([
        needs.has('goals') ? fetchAPI('/v1/goals').catch(e => ({ goals: [] })) : Promise.resolve({ goals: [] }),
        needs.has('facts') ? fetchAPI('/v1/facts').catch(e => ({ facts: [] })) : Promise.resolve({ facts: [] }),
        needs.has('aliases') ? fetchAPI('/v1/aliases').catch(e => ({ aliases: [] })) : Promise.resolve({ aliases: [] }),
        needs.has('tools') ? getTools() : Promise.resolve([]),
        needs.has('tools') ? getMCPStatus() : Promise.resolve([])
    ]);

    return (
        <PageShell icon={Activity} title="Agent Brain" subtitle="What it knows, what it is working on, and what it may do without asking.">
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
