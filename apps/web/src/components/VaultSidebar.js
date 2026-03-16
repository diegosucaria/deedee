'use client';
import { useState } from 'react';
import FileExplorer from '@/components/FileExplorer';
import VaultUploader from '@/components/VaultUploader';
import VaultEmbeddings from '@/components/VaultEmbeddings';
import { Files, Database, FileText } from 'lucide-react';

export default function VaultSidebar({ vault, activePage, onPageSelect }) {
    const [tab, setTab] = useState('files');

    const pages = vault.pages || [];

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
                    onClick={() => setTab('pages')}
                    className={`flex-1 flex items-center justify-center gap-2 p-3 text-sm font-medium transition-colors ${tab === 'pages' ? 'text-white border-b-2 border-indigo-500' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
                        }`}
                >
                    <FileText className="w-4 h-4" />
                    Pages
                    {pages.length > 0 && (
                        <span className="bg-zinc-700 text-zinc-300 text-[10px] px-1.5 py-0.5 rounded-full">{pages.length}</span>
                    )}
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
            ) : tab === 'pages' ? (
                <>
                    <div className="p-4 border-b border-zinc-800 bg-zinc-900">
                        <h2 className="font-semibold text-zinc-300">Pages</h2>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        {/* Always show index.md */}
                        <button
                            onClick={() => onPageSelect?.('index.md')}
                            className={`w-full text-left px-4 py-3 text-sm border-b border-zinc-800/50 transition-colors flex items-center gap-2 ${activePage === 'index.md' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'}`}
                        >
                            <FileText className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                            index.md
                        </button>
                        {pages.length > 0 ? (
                            pages.map(page => (
                                <button
                                    key={page}
                                    onClick={() => onPageSelect?.(page)}
                                    className={`w-full text-left px-4 py-3 text-sm border-b border-zinc-800/50 transition-colors flex items-center gap-2 ${activePage === page ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'}`}
                                >
                                    <FileText className="w-4 h-4 text-zinc-500 flex-shrink-0" />
                                    {page}
                                </button>
                            ))
                        ) : (
                            <div className="p-6 text-center text-zinc-600 text-sm">
                                No pages yet. The agent can create pages using writeVaultPage.
                            </div>
                        )}
                    </div>
                    <div className="p-4 border-t border-zinc-800 bg-zinc-900 text-xs text-zinc-500">
                        <p>Markdown pages created by the agent (e.g. weekly reviews, notes).</p>
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
