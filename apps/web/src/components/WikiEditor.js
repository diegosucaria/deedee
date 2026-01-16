'use client';
import { useState, useRef, useEffect } from 'react';
import { updateVaultPage } from '@/app/actions';
import MDEditor from '@uiw/react-md-editor';

export default function WikiEditor({ vaultId, initialContent, pageName }) {
    const [content, setContent] = useState(initialContent || '');
    const [isSaving, setIsSaving] = useState(false);
    const [isDirty, setIsDirty] = useState(false);

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
        <div className="flex flex-col h-full border border-zinc-800 rounded-lg bg-zinc-950 shadow-sm overflow-hidden text-zinc-300" data-color-mode="dark">
            <div className="bg-zinc-900 px-4 py-2 border-b border-zinc-800 flex justify-between items-center z-10">
                <div className="flex items-center gap-4">
                    <span className="font-semibold text-zinc-400 text-sm flex items-center gap-2">
                        {pageName || 'index.md'}
                        {isDirty && <span className="text-amber-500 text-[10px] uppercase font-bold tracking-wider">● Unsaved</span>}
                    </span>
                </div>

                <div className="flex items-center gap-2">
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
            </div>

            <div className="flex-1 overflow-hidden relative bg-zinc-950">
                <MDEditor
                    value={content}
                    onChange={(val) => { setContent(val || ''); setIsDirty(true); }}
                    height="100%"
                    visibleDragbar={false}
                    preview="live"
                    hideToolbar={false}
                    className="h-full w-full border-none"
                    style={{ backgroundColor: 'transparent' }}
                />
            </div>
        </div>
    );
}
