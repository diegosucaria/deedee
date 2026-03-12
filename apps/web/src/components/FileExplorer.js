'use client';

import { deleteVaultFile } from '@/app/actions';
import { Eye, Download, Trash2, FileText, Image, Music, Video, FileType } from 'lucide-react';

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const AUDIO_EXTS = ['wav', 'mp3', 'ogg', 'opus'];
const VIDEO_EXTS = ['mp4', 'mov'];

function getFileIcon(filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (IMAGE_EXTS.includes(ext)) return <Image className="w-4 h-4 text-emerald-500 shrink-0" />;
    if (AUDIO_EXTS.includes(ext)) return <Music className="w-4 h-4 text-purple-500 shrink-0" />;
    if (VIDEO_EXTS.includes(ext)) return <Video className="w-4 h-4 text-blue-500 shrink-0" />;
    if (ext === 'pdf') return <FileType className="w-4 h-4 text-red-500 shrink-0" />;
    return <FileText className="w-4 h-4 text-zinc-500 shrink-0" />;
}

export default function FileExplorer({ files, vaultId, className }) {
    if (!files || files.length === 0) {
        return (
            <div className={`p-4 text-gray-500 text-sm italic ${className} flex flex-col items-center justify-center h-32 border border-zinc-800 rounded bg-zinc-900/50`}>
                <FileText className="w-8 h-8 text-zinc-700 mb-2" />
                No files uploaded yet.
            </div>
        );
    }

    return (
        <div className={`flex flex-col gap-2 ${className}`}>
            {files.map((file, i) => (
                <div key={i} className="flex items-center justify-between p-2 bg-zinc-900 hover:bg-zinc-800 rounded border border-zinc-800 group transition-colors">
                    <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0 mr-2">
                        {getFileIcon(file)}
                        <span className="text-sm font-medium text-zinc-300 truncate" title={file}>{file}</span>
                    </div>
                    <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                        {/* View Link */}
                        <a
                            href={`/files/vaults/${vaultId}/files/${encodeURIComponent(file)}?inline=true`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 text-zinc-400 hover:text-indigo-400 hover:bg-zinc-700 rounded transition-colors"
                            title="View File"
                        >
                            <Eye className="w-4 h-4" />
                        </a>

                        {/* Download Link */}
                        <a
                            href={`/files/vaults/${vaultId}/files/${encodeURIComponent(file)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 text-zinc-400 hover:text-indigo-400 hover:bg-zinc-700 rounded transition-colors"
                            title="Download File"
                        >
                            <Download className="w-4 h-4" />
                        </a>

                        <button
                            onClick={async () => {
                                if (confirm(`Delete ${file}?`)) {
                                    await deleteVaultFile(vaultId, file);
                                }
                            }}
                            className="p-1.5 text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 rounded transition-colors"
                            title="Delete File"
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            ))}
        </div>
    );
}
