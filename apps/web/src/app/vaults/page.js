import VaultList from '@/components/VaultList';
import { getVaults } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function VaultsPage() {
    const vaults = await getVaults();

    return (
        <div className="min-h-screen bg-gray-50 p-8">
            <div className="max-w-6xl mx-auto">
                <header className="mb-8">
                    <h1 className="text-3xl font-bold text-gray-900 mb-2">Life Vaults</h1>
                    <p className="text-gray-600">
                        Secure, topic-specific knowledge bases for your agent.
                    </p>
                </header>

                <VaultList vaults={vaults} />
            </div>
        </div>
    );
}
