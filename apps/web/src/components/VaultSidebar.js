'use client';
import { useState } from 'react';
import FileExplorer from '@/components/FileExplorer';
import VaultUploader from '@/components/VaultUploader';
import VaultEmbeddings from '@/components/VaultEmbeddings';
import { Files, Database } from 'lucide-react';

export default function VaultSidebar({ vault }) {
    const [tab, setTab] = useState('files'); // 'files' or 'index'

    return (
        <div className="w-1/3 min-w-[300px] max-w-md border-r border-zinc-800 bg-zinc-900 flex flex-col">
            {/* Tabs */}
            <div className="flex border-b border-zinc-800">
                <button
                    onClick={() => setTab('files')}
                    className={`flex-1 flex items-center justify-center gap-2 p-3 text-sm font-medium transition-colors ${tab === 'files' ? 'text-white border-b-2 border-indigo-500' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
                        }`}
                >
                    <Files className="w-4 h-4" />
                    Files
                </button>
                <button
                    onClick={() => setTab('index')}
                    className={`flex-1 flex items-center justify-center gap-2 p-3 text-sm font-medium transition-colors ${tab === 'index' ? 'text-white border-b-2 border-indigo-500' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
                        }`}
                >
                    <Database className="w-4 h-4" />
                    Index
                </button>
            </div>

            {/* Content */}
            {tab === 'files' ? (
                <>
                    <div className="p-4 border-b border-zinc-800 flex justify-between items-center bg-zinc-900">
                        <h2 className="font-semibold text-zinc-300">Files</h2>
                        <VaultUploader vaultId={vault.id} />
                    </div>

                    <div className="flex-1 overflow-y-auto p-4">
                        <FileExplorer files={vault.files} vaultId={vault.id} />
                    </div>

                    <div className="p-4 border-t border-zinc-800 bg-zinc-900 text-xs text-zinc-500">
                        <p>Upload files to add context. The Agent will read 'index.md' to understand this topic.</p>
                    </div>
                </>
            ) : (
                <div className="flex-1 overflow-hidden">
                    <VaultEmbeddings vaultId={vault.id} />
                </div>
            )}
        </div>
    );
}
