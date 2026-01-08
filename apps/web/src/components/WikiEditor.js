'use client';
import { useState, useRef, useEffect } from 'react';
import { updateVaultPage } from '@/app/actions';

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
        <div className="flex flex-col h-full border rounded-lg bg-white shadow-sm overflow-hidden">
            <div className="bg-gray-50 px-4 py-2 border-b flex justify-between items-center">
                <span className="font-semibold text-gray-700 text-sm">
                    {pageName || 'index.md'}
                    {isDirty && <span className="text-amber-500 ml-2 text-xs">● Unsaved</span>}
                </span>
                <button
                    onClick={handleSave}
                    disabled={isSaving || !isDirty}
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors ${isDirty
                            ? 'bg-blue-600 text-white hover:bg-blue-700'
                            : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                        }`}
                >
                    {isSaving ? 'Saving...' : 'Save'}
                </button>
            </div>
            <textarea
                className="flex-1 w-full p-4 resize-none focus:outline-none font-mono text-sm leading-relaxed"
                value={content}
                onChange={(e) => { setContent(e.target.value); setIsDirty(true); }}
                onKeyDown={handleKeyDown}
                placeholder="# Vault Context\nStart writing..."
            />
        </div>
    );
}
