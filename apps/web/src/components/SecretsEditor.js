'use client';

import { useState, useEffect } from 'react';
import { getBrowserSecretNames, saveBrowserSecret, deleteBrowserSecret } from '@/app/actions';
import { Save, AlertCircle, Check, Plus, Trash2, KeyRound } from 'lucide-react';

// The browser never receives a secret value. The list shows names; a value can
// be replaced or removed, never read back.
const NAME_RE = /^[A-Z0-9_]+$/;

export default function SecretsEditor() {
    const [names, setNames] = useState([]);
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState('idle'); // idle | saved | error
    const [errorMsg, setErrorMsg] = useState('');
    const [busyName, setBusyName] = useState(null);
    const [replacing, setReplacing] = useState({}); // name -> new value being typed
    const [newName, setNewName] = useState('');
    const [newValue, setNewValue] = useState('');

    const load = () => getBrowserSecretNames().then((list) => {
        setNames(list);
        setLoading(false);
    });

    useEffect(() => { load(); }, []);

    const report = (res) => {
        if (res.success) {
            setStatus('saved');
            setErrorMsg('');
            setTimeout(() => setStatus('idle'), 3000);
            return true;
        }
        setStatus('error');
        setErrorMsg(res.error || 'Save failed');
        return false;
    };

    const handleReplace = async (name) => {
        const value = replacing[name];
        if (typeof value !== 'string' || value === '') return;
        setBusyName(name);
        const res = await saveBrowserSecret(name, value);
        setBusyName(null);
        if (report(res)) {
            setReplacing((prev) => ({ ...prev, [name]: '' }));
            await load();
        }
    };

    const handleDelete = async (name) => {
        setBusyName(name);
        const res = await deleteBrowserSecret(name);
        setBusyName(null);
        if (report(res)) await load();
    };

    const handleAdd = async () => {
        const name = newName.trim().toUpperCase();
        if (!NAME_RE.test(name)) {
            setStatus('error');
            setErrorMsg('Use A-Z, 0-9 and _ for the name');
            return;
        }
        if (newValue === '') {
            setStatus('error');
            setErrorMsg('Enter a value');
            return;
        }
        setBusyName(name);
        const res = await saveBrowserSecret(name, newValue);
        setBusyName(null);
        if (report(res)) {
            setNewName('');
            setNewValue('');
            await load();
        }
    };

    return (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 flex flex-col h-[600px]">
            <div className="flex justify-between items-center p-4 border-b border-zinc-800/50">
                <div className="flex items-center gap-3">
                    <h3 className="text-sm font-semibold text-zinc-300">Browser Secrets</h3>
                    <span className="text-[10px] text-zinc-500">Values stay on the agent. You can replace or remove one, not read it.</span>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {loading && <div className="text-center py-8 text-zinc-600 text-xs italic">Loading…</div>}
                {!loading && names.length === 0 && (
                    <div className="text-center py-8 text-zinc-600 text-xs italic">No secrets saved. Add one below.</div>
                )}
                {names.map((name) => (
                    <div key={name} className="flex gap-2 items-center group">
                        <div className="flex-1 flex items-center gap-2 bg-black/50 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-indigo-300">
                            <KeyRound size={12} className="text-zinc-600" />
                            {name}
                            <span className="ml-auto text-[10px] text-green-500/80 font-sans">set</span>
                        </div>
                        <input
                            type="password"
                            placeholder="New value"
                            value={replacing[name] || ''}
                            onChange={(e) => setReplacing((prev) => ({ ...prev, [name]: e.target.value }))}
                            className="flex-[2] bg-black/50 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-zinc-300 focus:outline-none focus:border-indigo-500/50 placeholder:text-zinc-700"
                        />
                        <button
                            onClick={() => handleReplace(name)}
                            disabled={busyName === name || !replacing[name]}
                            title="Replace value"
                            className="p-2 text-zinc-500 hover:text-indigo-400 disabled:opacity-30 transition-colors"
                        >
                            <Save size={14} />
                        </button>
                        <button
                            onClick={() => handleDelete(name)}
                            disabled={busyName === name}
                            title="Remove secret"
                            className="p-2 text-zinc-600 hover:text-red-400 disabled:opacity-30 transition-colors"
                        >
                            <Trash2 size={14} />
                        </button>
                    </div>
                ))}
            </div>

            <div className="p-4 border-t border-zinc-800/50 bg-zinc-900/50 flex gap-2 items-center">
                <input
                    type="text"
                    placeholder="NAME (A-Z, 0-9, _)"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="flex-1 bg-black/50 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-indigo-300 focus:outline-none focus:border-indigo-500/50 placeholder:text-zinc-700"
                />
                <input
                    type="password"
                    placeholder="Value"
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    className="flex-[2] bg-black/50 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-zinc-300 focus:outline-none focus:border-indigo-500/50 placeholder:text-zinc-700"
                />
                <button
                    onClick={handleAdd}
                    className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-2 rounded text-xs transition-colors font-medium"
                >
                    <Plus size={14} /> Add
                </button>
            </div>

            <div className="h-8 border-t border-zinc-800 bg-black/20 flex items-center px-4 justify-between text-[10px]">
                <div className="flex items-center gap-2">
                    {status === 'saved' && (
                        <span className="text-green-400 flex items-center gap-1.5"><Check size={12} /> Saved</span>
                    )}
                    {status === 'error' && (
                        <span className="text-red-400 flex items-center gap-1.5"><AlertCircle size={12} /> {errorMsg}</span>
                    )}
                </div>
            </div>
        </div>
    );
}
