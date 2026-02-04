'use client';

import { useState, useEffect } from 'react';
import { Zap, Plus, Trash2, Edit, Save, X, Power, Key, AlertTriangle } from 'lucide-react';
import { clsx } from 'clsx';
import { getSkills, saveSkill, deleteSkill, toggleSkill, saveSkillSecrets } from './actions';

export default function SkillsPage() {
    const [skills, setSkills] = useState([]);
    const [loading, setLoading] = useState(true);

    // Editor State
    const [editorOpen, setEditorOpen] = useState(false);
    const [currentSkill, setCurrentSkill] = useState(null);
    const [editContent, setEditContent] = useState('');
    const [editFilename, setEditFilename] = useState('');

    // Secrets Modal State
    const [secretsOpen, setSecretsOpen] = useState(false);
    const [secretKeys, setSecretKeys] = useState(''); // Textarea for JSON/Env format

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
        setEditContent('---\nname: my-skill\ndescription: A new skill\nuser-invocable: true\nmetadata:\n  emoji: 🤖\n---\n\n# Instructions\n');
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

    const handleToggle = async (skill) => {
        // Optimistic Update
        const newStatus = !skill.enabled;
        setSkills(skills.map(s => s.name === skill.name ? { ...s, enabled: newStatus } : s));

        const res = await toggleSkill(skill.name, newStatus);
        if (!res.success) {
            // Revert
            setSkills(skills.map(s => s.name === skill.name ? { ...s, enabled: !newStatus } : s));
            alert(res.error);
        }
    };

    const openSecrets = (skill) => {
        setCurrentSkill(skill);
        // We don't have values, only keys. But user wants to set them.
        // We'll just show an empty box or hint.
        setSecretKeys('{\n  "API_KEY": ""\n}');
        setSecretsOpen(true);
    };

    const handleSaveSecrets = async () => {
        try {
            const secrets = JSON.parse(secretKeys);
            const res = await saveSkillSecrets(currentSkill.name, secrets);
            if (res.success) {
                setSecretsOpen(false);
                fetchSkills();
            } else {
                alert(`Error: ${res.error}`);
            }
        } catch (e) {
            alert('Invalid JSON format');
        }
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
                        <div key={skill.name} className={clsx(
                            "bg-zinc-900 border rounded-xl p-4 transition-colors flex flex-col relative overflow-hidden",
                            skill.enabled ? "border-zinc-800 hover:border-zinc-600" : "border-zinc-800 opacity-75 grayscale-[0.5]"
                        )}>
                            {/* Disabled Overlay Pattern or Strike? */}

                            <div className="flex items-start justify-between mb-2">
                                <div className="flex flex-col">
                                    <h3 className="font-semibold text-lg text-zinc-100 flex items-center gap-2">
                                        {skill.metadata?.emoji && <span>{skill.metadata.emoji}</span>}
                                        {skill.name}
                                    </h3>

                                    <div className="flex items-center gap-2 mt-1">
                                        <span className={clsx(
                                            "text-[10px] px-1.5 py-0.5 rounded w-fit",
                                            skill.type === 'builtin' ? "bg-zinc-800 text-zinc-400" : "bg-emerald-900/30 text-emerald-400 border border-emerald-900/50"
                                        )}>
                                            {skill.type.toUpperCase()}
                                        </span>
                                        {skill.missingDependencies?.length > 0 && (
                                            <span className="flex items-center gap-1 text-[10px] bg-red-900/20 text-red-400 border border-red-900/40 px-1.5 py-0.5 rounded cursor-help" title={skill.missingDependencies.join(', ')}>
                                                <AlertTriangle className="h-3 w-3" />
                                                Missing Deps
                                            </span>
                                        )}
                                    </div>
                                </div>

                                <button
                                    onClick={() => handleToggle(skill)}
                                    className={clsx(
                                        "p-1.5 rounded-lg transition-colors",
                                        skill.enabled ? "text-green-400 hover:bg-green-900/20" : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800"
                                    )}
                                    title={skill.enabled ? "Disable Skill" : "Enable Skill"}
                                >
                                    <Power className="h-5 w-5" />
                                </button>
                            </div>

                            <p className="text-zinc-400 text-sm flex-1 mb-4 line-clamp-2">
                                {skill.description || "No description provided."}
                            </p>

                            <div className="mt-auto border-t border-zinc-800/50 pt-3 flex items-center justify-between">
                                <div className="flex gap-2">
                                    {skill.userInvocable && (
                                        <span className="text-[10px] bg-indigo-900/20 text-indigo-300 border border-indigo-900/40 px-2 py-0.5 rounded-full">
                                            User Invocable
                                        </span>
                                    )}
                                </div>

                                <div className="flex gap-1">
                                    <button
                                        onClick={() => openSecrets(skill)}
                                        className={clsx("p-1.5 rounded-lg transition-colors",
                                            skill.secrets?.length > 0 ? "text-yellow-500 hover:bg-yellow-900/20" : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                                        )}
                                        title="Manage Secrets"
                                    >
                                        <Key className="h-4 w-4" />
                                    </button>
                                    <button
                                        onClick={() => handleEdit(skill)}
                                        className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                                        title="Edit"
                                        disabled={skill.type === 'builtin'} // Allow viewing code?
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

            {/* Secrets Modal */}
            {secretsOpen && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-lg flex flex-col shadow-2xl">
                        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
                            <h3 className="font-semibold text-lg flex items-center gap-2">
                                <Key className="h-4 w-4 text-yellow-500" />
                                Secrets: {currentSkill?.name}
                            </h3>
                            <button onClick={() => setSecretsOpen(false)} className="text-zinc-500 hover:text-white">
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        <div className="p-4">
                            <p className="text-xs text-zinc-400 mb-2">
                                Enter secrets as a JSON object. Keys will be available to the skill via standard config mechanisms.
                                Values are encrypted/safe.
                            </p>
                            <textarea
                                value={secretKeys}
                                onChange={(e) => setSecretKeys(e.target.value)}
                                className="w-full h-40 bg-zinc-950 border border-zinc-800 rounded p-3 font-mono text-xs text-green-400 focus:outline-none focus:border-indigo-500"
                            />
                        </div>
                        <div className="p-4 border-t border-zinc-800 flex justify-end gap-2">
                            <button
                                onClick={() => setSecretsOpen(false)}
                                className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSaveSecrets}
                                className="flex items-center gap-2 bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded-lg transition-colors text-sm font-medium"
                            >
                                <Save className="h-4 w-4" />
                                Save Secrets
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
