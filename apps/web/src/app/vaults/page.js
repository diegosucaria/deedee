import VaultList from '@/components/VaultList';
import { getVaults } from '@/app/actions';
import { Database } from 'lucide-react';
import PageShell from '@/components/PageShell';

export const dynamic = 'force-dynamic';

export default async function VaultsPage() {
    const vaults = await getVaults();

    return (
        <PageShell icon={Database} title="Life Vaults" subtitle="Secure, topic-specific knowledge bases for your agent.">
            <VaultList vaults={vaults} />
        </PageShell>
    );
}
