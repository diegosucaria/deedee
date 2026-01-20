'use client';
import { useState, useEffect } from 'react';
import { getVaultEmbeddings, deleteVaultEmbedding } from '@/app/actions';
import { Trash2, RefreshCw, Database } from 'lucide-react';

export default function VaultEmbeddings({ vaultId }) {
    const [docs, setDocs] = useState([]);
    const [loading, setLoading] = useState(true);

    const loadData = async () => {
        setLoading(true);
        try {
            const data = await getVaultEmbeddings(vaultId);
            setDocs(data || []);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadData();
    }, [vaultId]);

    const handleDelete = async (filename) => {
        if (!confirm(`Remove "${filename}" from the search index? (File remains on disk)`)) return;

        const res = await deleteVaultEmbedding(vaultId, filename);
        if (res.success) {
            loadData();
        } else {
            alert('Failed to delete index: ' + res.error);
        }
    };

    if (loading) return <div className="p-4 text-zinc-500 text-sm">Loading index...</div>;

    return (
        <div className="flex flex-col h-full bg-zinc-900 border-l border-zinc-800">
            <div className="p-4 border-b border-zinc-800 flex justify-between items-center">
                <div className="flex items-center gap-2 font-semibold text-zinc-300">
                    <Database className="w-4 h-4" />
                    <span>Search Index</span>
                </div>
                <button onClick={loadData} className="p-1 hover:bg-zinc-800 rounded text-zinc-400">
                    <RefreshCw className="w-4 h-4" />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {docs.length === 0 && (
                    <div className="text-zinc-500 text-sm text-center py-4">
                        No documents indexed.
                    </div>
                )}
                {docs.map(doc => (
                    <div key={doc.id} className="flex items-center justify-between p-3 bg-zinc-950 rounded-lg border border-zinc-800 hover:border-zinc-700">
                        <div className="overflow-hidden">
                            <h4 className="text-sm font-medium text-zinc-200 truncate" title={doc.filename}>{doc.filename}</h4>
                            <div className="flex items-center gap-2 text-xs text-zinc-500 mt-1">
                                <span>{doc.chunk_count} chunks</span>
                                <span>•</span>
                                <span>{new Date(doc.indexed_at).toLocaleDateString()}</span>
                            </div>
                        </div>
                        <button
                            onClick={() => handleDelete(doc.filename)}
                            className="p-2 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-full transition-colors"
                            title="Remove from Index"
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                    </div>
                ))}
            </div>

            <div className="p-4 border-t border-zinc-800 bg-zinc-900 text-xs text-zinc-500">
                <p>These files have been processed for RAG search. Deleting here removes them from AI memory only.</p>
            </div>
        </div>
    );
}
