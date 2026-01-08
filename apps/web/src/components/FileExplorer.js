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
                <div key={i} className="flex items-center justify-between p-2 bg-gray-50 hover:bg-gray-100 rounded border border-gray-200">
                    <div className="flex items-center gap-2 overflow-hidden">
                        <span className="text-gray-500">📄</span>
                        <span className="text-sm font-medium truncate" title={file}>{file}</span>
                    </div>
                    {/* Download Link Placeholder - Assumes a proxy route will exist */}
                    <a
                        href={`/api/proxy/vaults/${vaultId}/files/${file}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:underline"
                    >
                        Download
                    </a>
                </div>
            ))}
        </div>
    );
}
