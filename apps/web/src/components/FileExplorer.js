'use client';

import { deleteVaultFile } from '@/app/actions';

export default function FileExplorer({ files, vaultId, className }) {
    if (!files || files.length === 0) {
        return (
            <div className={`p-4 text-gray-500 text-sm italic ${className}`}>
                No files uploaded yet.
            </div>
        );
    }

    // Helper to get download URL
    // We can't use simple links because files are protected by API Token?
    // Wait, if /v1/vaults/:id/files/:filename is behind Auth, then generic <a> href won't work for User unless we proxy or use a transient token.
    // OR we assume the User (browser) session is same? No, API token is server-side.
    // Solution: Create a Server Action that streams the file, or a Route Handler in Next.js app that proxies the request.
    // A Route Handler `/api/vaults/[id]/files/[filename]` acting as proxy is best.
    // For now, I'll render the list. The download feature might need a follow-up task "Proxy files".
    // Or I can use a "Download" button that triggers a Server Action which returns base64? (Bad for large files).
    // I will assume for now I need a simple proxy.

    return (
        <div className={`flex flex-col gap-2 ${className}`}>
            {files.map((file, i) => (
                <div key={i} className="flex items-center justify-between p-2 bg-zinc-900 hover:bg-zinc-800 rounded border border-zinc-800 group transition-colors">
                    <div className="flex items-center gap-2 overflow-hidden">
                        <span className="text-zinc-500">📄</span>
                        <span className="text-sm font-medium text-zinc-300 truncate" title={file}>{file}</span>
                    </div>
                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        {/* Proxy Download Link */}
                        <a
                            href={`/api/proxy/vaults/${vaultId}/files/${file}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-indigo-400 hover:text-indigo-300"
                        >
                            Download
                        </a>
                        <button
                            onClick={async () => {
                                if (confirm(`Delete ${file}?`)) {
                                    await deleteVaultFile(vaultId, file);
                                }
                            }}
                            className="text-xs text-rose-500 hover:text-rose-400 p-1 hover:bg-rose-500/10 rounded"
                            title="Delete File"
                        >
                            Delete
                        </button>
                    </div>
                </div>
            ))}
        </div>
    );
}
