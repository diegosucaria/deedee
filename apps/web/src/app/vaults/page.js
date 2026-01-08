import VaultList from '@/components/VaultList';
import { getVaults } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function VaultsPage() {
    const vaults = await getVaults();

    return (
        <div className="min-h-screen bg-zinc-950 p-8">
            <div className="max-w-6xl mx-auto">
                <header className="mb-8">
                    <h1 className="text-3xl font-bold text-white mb-2">Life Vaults</h1>
                    <p className="text-zinc-400">
                        Secure, topic-specific knowledge bases for your agent.
                    </p>
                </header>

                <VaultList vaults={vaults} />
            </div>
        </div>
    );
}
