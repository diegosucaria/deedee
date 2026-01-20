import { getVault } from '@/app/actions';
import Link from 'next/link';
import WikiEditor from '@/components/WikiEditor';
import FileExplorer from '@/components/FileExplorer';
import VaultUploader from '@/components/VaultUploader';
import VaultChat from '@/components/VaultChat';
import VaultSidebar from '@/components/VaultSidebar';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function VaultDetailPage({ params }) {
    const { id } = params;
    const vault = await getVault(id);

    if (!vault) {
        notFound();
    }

    return (
        <div className="h-screen flex flex-col bg-zinc-950 overflow-hidden text-zinc-200">
            {/* Header */}
            <header className="flex-shrink-0 bg-zinc-900 border-b border-zinc-800 px-6 py-4 flex items-center justify-between z-10">
                <div className="flex items-center gap-4">
                    <Link href="/vaults" className="text-zinc-400 hover:text-white transition-colors">
                        ← Back
                    </Link>
                    <h1 className="text-xl font-bold text-white capitalize flex items-center gap-2">
                        <span className="text-2xl">🔐</span> {vault.id}
                    </h1>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Knowledge Base</span>
                </div>
            </header>

            {/* Main Content - Split View */}
            <div className="flex-1 flex overflow-hidden">
                {/* Left: Files & Meta */}
                <VaultSidebar vault={vault} />

                {/* Right: Wiki Editor */}
                <div className="flex-1 flex flex-col bg-zinc-950 p-4">
                    <WikiEditor
                        vaultId={vault.id}
                        initialContent={vault.wiki}
                        pageName="index.md"
                    />
                </div>

                {/* Far Right: Contextual Chat */}
                <div className="w-[400px] flex flex-col bg-zinc-900 border-l border-zinc-800">
                    <div className="p-4 border-b border-zinc-800 font-semibold text-zinc-300">
                        Vault Assistant
                    </div>
                    <div className="flex-1 overflow-hidden">
                        <VaultChat vaultId={vault.id} />
                    </div>
                </div>
            </div>
        </div>
    );
}
