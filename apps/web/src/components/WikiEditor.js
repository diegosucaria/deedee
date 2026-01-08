'use client';
import { useState, useRef, useEffect } from 'react';
import { updateVaultPage } from '@/app/actions';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function WikiEditor({ vaultId, initialContent, pageName }) {
    const [content, setContent] = useState(initialContent || '');
    const [isSaving, setIsSaving] = useState(false);
    const [isDirty, setIsDirty] = useState(false);
    const [isPreview, setIsPreview] = useState(false); // Default to edit mode

    // Auto-save logic or Manual save? 
    // Manual save button for safety + Cmd+S

    useEffect(() => {
        setContent(initialContent || '');
        setIsDirty(false);
    }, [initialContent]);

    const handleSave = async () => {
        setIsSaving(true);
        const res = await updateVaultPage(vaultId, content, pageName);
        setIsSaving(false);
        if (res.success) {
            setIsDirty(false);
            // Optional toast here
        } else {
            alert('Failed to save: ' + res.error);
        }
    };

    const handleKeyDown = (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            handleSave();
        }
    };

    return (
        <div className="flex flex-col h-full border border-zinc-800 rounded-lg bg-zinc-950 shadow-sm overflow-hidden text-zinc-300">
            <div className="bg-zinc-900 px-4 py-2 border-b border-zinc-800 flex justify-between items-center z-10">
                <div className="flex items-center gap-4">
                    <span className="font-semibold text-zinc-400 text-sm flex items-center gap-2">
                        {pageName || 'index.md'}
                        {isDirty && <span className="text-amber-500 text-[10px] uppercase font-bold tracking-wider">● Unsaved</span>}
                    </span>

                    {/* Mode Toggle */}
                    <div className="flex bg-black/40 rounded-lg p-0.5 border border-zinc-800">
                        <button
                            onClick={() => setIsPreview(false)}
                            className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${!isPreview ? 'bg-zinc-800 text-zinc-200 shadow-sm' : 'text-zinc-500 hover:text-zinc-400'}`}
                        >
                            Edit
                        </button>
                        <button
                            onClick={() => setIsPreview(true)}
                            className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${isPreview ? 'bg-indigo-900/50 text-indigo-300 shadow-sm border border-indigo-500/30' : 'text-zinc-500 hover:text-zinc-400'}`}
                        >
                            Preview
                        </button>
                    </div>
                </div>

                <button
                    onClick={handleSave}
                    disabled={isSaving || !isDirty}
                    className={`px-4 py-1.5 rounded text-xs font-bold uppercase tracking-wide transition-all ${isDirty
                        ? 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-lg shadow-indigo-900/20'
                        : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                        }`}
                >
                    {isSaving ? 'Saving...' : 'Save Changes'}
                </button>
            </div>

            <div className="flex-1 overflow-hidden relative">
                {isPreview ? (
                    <div className="h-full overflow-y-auto p-6 bg-zinc-950/50">
                        <article className="prose prose-invert prose-sm max-w-none">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {content}
                            </ReactMarkdown>
                        </article>
                    </div>
                ) : (
                    <textarea
                        className="w-full h-full p-6 resize-none focus:outline-none font-mono text-sm leading-relaxed bg-zinc-950 text-zinc-300 placeholder-zinc-700"
                        value={content}
                        onChange={(e) => { setContent(e.target.value); setIsDirty(true); }}
                        onKeyDown={handleKeyDown}
                        placeholder="# Vault Context\nStart writing..."
                    />
                )}
            </div>
        </div>
    );
}
