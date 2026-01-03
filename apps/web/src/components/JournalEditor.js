'use client';

import { useState } from 'react';
import { updateJournal } from '@/app/actions';
import { Edit2, Save, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

export default function JournalEditor({ date, initialContent }) {
    const [isEditing, setIsEditing] = useState(false);
    const [content, setContent] = useState(initialContent);
    const [saving, setSaving] = useState(false);

    const handleSave = async () => {
        setSaving(true);
        const res = await updateJournal(date, content);
        setSaving(false);
        if (res.success) {
            setIsEditing(false);
        } else {
            alert('Failed to save: ' + res.error);
        }
    };

    if (isEditing) {
        return (
            <div className="space-y-4">
                <div className="flex justify-end gap-2">
                    <button
                        onClick={() => setIsEditing(false)}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
                        disabled={saving}
                    >
                        <X className="h-4 w-4" /> Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors"
                        disabled={saving}
                    >
                        {saving ? 'Saving...' : <><Save className="h-4 w-4" /> Save Changes</>}
                    </button>
                </div>
                <textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    className="w-full h-[600px] rounded-xl bg-zinc-900 border border-zinc-800 p-6 text-zinc-200 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y"
                />
            </div>
        );
    }

    return (
        <div className="relative group">
            <button
                onClick={() => setIsEditing(true)}
                className="absolute top-4 right-4 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800/80 text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-white hover:bg-zinc-700 transition-all backdrop-blur-sm"
            >
                <Edit2 className="h-4 w-4" /> Edit
            </button>
            <div className="markdown prose prose-invert max-w-none bg-zinc-900/50 p-8 rounded-2xl border border-zinc-800">
                <ReactMarkdown>{initialContent}</ReactMarkdown>
            </div>
        </div>
    );
}
