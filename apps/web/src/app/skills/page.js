'use client';

import { useState, useEffect } from 'react';
import { Zap, Plus, Trash2, Edit, Save, X } from 'lucide-react';
import { clsx } from 'clsx';
import { getSkills, saveSkill, deleteSkill } from './actions';

export default function SkillsPage() {
    const [skills, setSkills] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editorOpen, setEditorOpen] = useState(false);
    const [currentSkill, setCurrentSkill] = useState(null); // { filename, content, ... }

    // Editor State
    const [editContent, setEditContent] = useState('');
    const [editFilename, setEditFilename] = useState('');

    useEffect(() => {
        fetchSkills();
    }, []);

    const fetchSkills = async () => {
        try {
            const data = await getSkills();
            setSkills(data);
        } catch (e) {
            console.error('Failed to fetch skills:', e);
        } finally {
            setLoading(false);
        }
    };

    const handleEdit = (skill) => {
        setCurrentSkill(skill);
        setEditFilename(skill.fileName);
        setEditContent(skill.content || '');
        setEditorOpen(true);
    };

    const handleCreate = () => {
        setCurrentSkill(null);
        setEditFilename('');
        setEditContent('---\nname: my-skill\ndescription: A new skill\nuser-invocable: true\n---\n\n# Instructions\n');
        setEditorOpen(true);
    };

    const handleSave = async () => {
        const res = await saveSkill(editFilename, editContent);
        if (res.success) {
            setEditorOpen(false);
            fetchSkills();
        } else {
            alert(`Failed to save: ${res.error}`);
        }
    };

    const handleDelete = async (filename) => {
        if (!confirm(`Delete ${filename}?`)) return;
        const res = await deleteSkill(filename);
        if (res.success) fetchSkills();
        else alert(`Failed to delete: ${res.error}`);
    };

    return (
        <div className="flex flex-col h-full bg-black text-white p-6 overflow-hidden">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <Zap className="h-6 w-6 text-yellow-500" />
                        Skills
                    </h1>
                    <p className="text-zinc-400 text-sm mt-1">Manage agent capabilities and personas.</p>
                </div>
                <button
                    onClick={handleCreate}
                    className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg transition-colors text-sm font-medium"
                >
                    <Plus className="h-4 w-4" />
                    New Skill
                </button>
            </div>

            {loading ? (
                <div className="text-zinc-500">Loading...</div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 overflow-y-auto pb-20">
                    {skills.map((skill) => (
                        <div key={skill.name} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 hover:border-zinc-700 transition-colors flex flex-col">
                            <div className="flex items-start justify-between mb-2">
                                <div className="flex flex-col">
                                    <h3 className="font-semibold text-lg text-zinc-100">{skill.name}</h3>
                                    <span className={clsx(
                                        "text-[10px] px-1.5 py-0.5 rounded w-fit mt-1",
                                        skill.type === 'builtin' ? "bg-zinc-800 text-zinc-400" : "bg-emerald-900/30 text-emerald-400 border border-emerald-900/50"
                                    )}>
                                        {skill.type.toUpperCase()}
                                    </span>
                                </div>
                                <div className="flex gap-1">
                                    <button
                                        onClick={() => handleEdit(skill)}
                                        className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                                        title="Edit"
                                    >
                                        <Edit className="h-4 w-4" />
                                    </button>
                                    {skill.type === 'user' && (
                                        <button
                                            onClick={() => handleDelete(skill.fileName)}
                                            className="p-1.5 text-zinc-400 hover:text-red-400 hover:bg-zinc-800 rounded-lg transition-colors"
                                            title="Delete"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </button>
                                    )}
                                </div>
                            </div>

                            <p className="text-zinc-400 text-sm flex-1 mb-4 line-clamp-2">
                                {skill.description || "No description provided."}
                            </p>

                            <div className="mt-auto border-t border-zinc-800/50 pt-3 flex flex-wrap gap-2">
                                {skill.userInvocable && (
                                    <span className="text-[10px] bg-indigo-900/20 text-indigo-300 border border-indigo-900/40 px-2 py-0.5 rounded-full">
                                        User Invocable
                                    </span>
                                )}
                                {skill.disableModelInvocation && (
                                    <span className="text-[10px] bg-orange-900/20 text-orange-300 border border-orange-900/40 px-2 py-0.5 rounded-full">
                                        Hidden from Context
                                    </span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Editor Modal */}
            {editorOpen && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-4xl h-[80vh] flex flex-col shadow-2xl">
                        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
                            <h3 className="font-semibold text-lg">
                                {currentSkill ? `Editing: ${currentSkill.name}` : 'New Skill'}
                            </h3>
                            <button onClick={() => setEditorOpen(false)} className="text-zinc-500 hover:text-white">
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        <div className="p-4 flex gap-4 border-b border-zinc-800">
                            <div className="flex-1">
                                <label className="block text-xs text-zinc-500 mb-1">Filename</label>
                                <input
                                    type="text"
                                    value={editFilename}
                                    onChange={(e) => setEditFilename(e.target.value)}
                                    placeholder="my-skill.md"
                                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                                    disabled={currentSkill && currentSkill.type === 'builtin'}
                                />
                            </div>
                        </div>

                        <div className="flex-1 p-0 overflow-hidden relative">
                            <textarea
                                value={editContent}
                                onChange={(e) => setEditContent(e.target.value)}
                                className="w-full h-full bg-zinc-950 text-zinc-300 p-4 font-mono text-sm resize-none focus:outline-none"
                                spellCheck="false"
                            />
                        </div>

                        <div className="p-4 border-t border-zinc-800 flex justify-end gap-2">
                            <button
                                onClick={() => setEditorOpen(false)}
                                className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={currentSkill && currentSkill.type === 'builtin'}
                                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Save className="h-4 w-4" />
                                Save Skill
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
