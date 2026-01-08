import { getVault } from '@/app/actions';
import Link from 'next/link';
import WikiEditor from '@/components/WikiEditor';
import FileExplorer from '@/components/FileExplorer';
import VaultUploader from '@/components/VaultUploader';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function VaultDetailPage({ params }) {
    const { id } = params;
    const vault = await getVault(id);

    if (!vault) {
        notFound();
    }

    return (
        <div className="h-screen flex flex-col bg-gray-50 overflow-hidden">
            {/* Header */}
            <header className="flex-shrink-0 bg-white border-b px-6 py-4 flex items-center justify-between z-10">
                <div className="flex items-center gap-4">
                    <Link href="/vaults" className="text-gray-400 hover:text-gray-600">
                        ← Back
                    </Link>
                    <h1 className="text-xl font-bold text-gray-800 capitalize flex items-center gap-2">
                        <span className="text-2xl">🔐</span> {vault.id}
                    </h1>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Knowledge Base</span>
                </div>
            </header>

            {/* Main Content - Split View */}
            <div className="flex-1 flex overflow-hidden">
                {/* Left: Files & Meta */}
                <div className="w-1/3 min-w-[300px] max-w-md border-r bg-white flex flex-col">
                    <div className="p-4 border-b flex justify-between items-center bg-gray-50">
                        <h2 className="font-semibold text-gray-700">Files</h2>
                        <VaultUploader vaultId={vault.id} />
                    </div>

                    <div className="flex-1 overflow-y-auto p-4">
                        <FileExplorer files={vault.files} vaultId={vault.id} />
                    </div>

                    <div className="p-4 border-t bg-gray-50 text-xs text-gray-500">
                        <p>Upload files to add context. The Agent will read 'index.md' to understand this topic.</p>
                    </div>
                </div>

                {/* Right: Wiki Editor */}
                <div className="flex-1 flex flex-col bg-gray-100 p-4">
                    <WikiEditor
                        vaultId={vault.id}
                        initialContent={vault.wiki}
                        pageName="index.md"
                    />
                </div>
            </div>
        </div>
    );
}
