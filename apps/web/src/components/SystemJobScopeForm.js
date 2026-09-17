'use client';

import { useEffect, useMemo, useState } from 'react';
import { setJobScope } from '@/app/actions';
import { getAgentTools } from '@/app/live/actions';
import { MODEL_OPTIONS } from './CreateTaskForm';
import { Loader2, Save, X, RotateCcw, Search } from 'lucide-react';

/**
 * Edit what a system job runs with: the model and the tools it may call.
 * The schedule and the prompt stay in code; only the scope is editable here.
 */
export default function SystemJobScopeForm({ job, onSaved, onCancel }) {
    const defaults = job?.scopeDefaults || { model: null, allowedTools: null };
    const override = job?.scopeOverride || { model: null, allowedTools: null };

    const [model, setModel] = useState(override.model || 'auto');
    const [selected, setSelected] = useState(() => new Set(override.allowedTools || defaults.allowedTools || []));
    const [usingDefaultTools, setUsingDefaultTools] = useState(!override.allowedTools);
    const [tools, setTools] = useState([]);
    const [toolsError, setToolsError] = useState(null);
    const [loadingTools, setLoadingTools] = useState(true);
    const [filter, setFilter] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        let alive = true;
        (async () => {
            const res = await getAgentTools();
            if (!alive) return;
            setTools(res.tools || []);
            setToolsError(res.success ? null : res.error || 'Could not read the tool list');
            setLoadingTools(false);
        })();
        return () => { alive = false; };
    }, []);

    // Every tool the agent knows, plus any name the job already carries.
    const toolNames = useMemo(() => {
        const names = new Set((tools || []).map(t => t.name).filter(Boolean));
        (defaults.allowedTools || []).forEach(n => names.add(n));
        (override.allowedTools || []).forEach(n => names.add(n));
        return Array.from(names).sort((a, b) => a.localeCompare(b));
    }, [tools, defaults.allowedTools, override.allowedTools]);

    const defaultToolSet = useMemo(() => new Set(defaults.allowedTools || []), [defaults.allowedTools]);
    const shown = toolNames.filter(n => n.toLowerCase().includes(filter.trim().toLowerCase()));

    const toggleTool = (name) => {
        const next = new Set(selected);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        setSelected(next);
        setUsingDefaultTools(false);
    };

    const resetTools = () => {
        setSelected(new Set(defaults.allowedTools || []));
        setUsingDefaultTools(true);
    };

    const save = async () => {
        setSaving(true);
        setError(null);
        const scope = { model };
        // Keeping the defaults means clearing the override: send an empty list.
        scope.allowedTools = usingDefaultTools ? [] : Array.from(selected);
        const res = await setJobScope(job.name, scope);
        setSaving(false);
        if (!res?.success) {
            setError(res?.error || 'Save failed');
            return;
        }
        onSaved?.(res);
    };

    // 'auto' means no override: the job falls back to its built-in default.
    const modelIsDefault = model === 'auto';
    const defaultModelLabel = defaults.model || 'Auto (Router)';

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 md:p-5">
            <div className="flex items-start justify-between gap-3 mb-4">
                <div className="min-w-0">
                    <h3 className="text-base font-semibold text-zinc-200 truncate">Scope for {job?.name}</h3>
                    <p className="text-xs text-zinc-500 mt-1">
                        The model and the tools this system job runs with. The schedule and the prompt live in code.
                    </p>
                </div>
                <button onClick={onCancel} className="p-1.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800" title="Close">
                    <X className="w-4 h-4" />
                </button>
            </div>

            <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-1">Model</label>
            <div className="flex items-center gap-2">
                <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200"
                >
                    {MODEL_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                </select>
                <span className="text-xs text-zinc-500">
                    Built-in default: <span className="font-mono text-zinc-400">{defaultModelLabel}</span>
                </span>
                {!modelIsDefault && (
                    <button
                        onClick={() => setModel('auto')}
                        className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                        title="Clear the model override"
                    >
                        <RotateCcw className="w-3 h-3" /> Use the default
                    </button>
                )}
            </div>
            {override.model && (
                <p className="text-[11px] text-amber-400 mt-1">Your override is in force: {override.model}</p>
            )}

            <div className="flex items-center justify-between gap-2 mt-5 mb-1">
                <label className="block text-xs uppercase tracking-wider text-zinc-500">
                    Tools ({usingDefaultTools ? (defaults.allowedTools?.length || 0) : selected.size})
                </label>
                <div className="flex items-center gap-2">
                    {!usingDefaultTools && (
                        <button onClick={resetTools} className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1">
                            <RotateCcw className="w-3 h-3" /> Back to the defaults
                        </button>
                    )}
                    <div className="relative">
                        <Search className="w-3 h-3 absolute left-2 top-2.5 text-zinc-600" />
                        <input
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            placeholder="Find a tool"
                            className="bg-zinc-950 border border-zinc-700 rounded-lg pl-7 pr-2 py-1 text-xs text-zinc-200 w-40"
                        />
                    </div>
                </div>
            </div>

            <p className="text-[11px] text-zinc-500 mb-2">
                {usingDefaultTools
                    ? 'This job uses the built-in tool list. Tick or untick anything to take it over.'
                    : 'Your own tool list. Clear it to go back to the built-in one.'}
            </p>

            {loadingTools ? (
                <div className="flex items-center gap-2 text-sm text-zinc-500 py-6">
                    <Loader2 className="w-4 h-4 animate-spin" /> Reading the tool list...
                </div>
            ) : (
                <div className="max-h-64 overflow-y-auto border border-zinc-800 rounded-lg divide-y divide-zinc-800/60">
                    {shown.length === 0 && (
                        <div className="px-3 py-4 text-xs text-zinc-500">No tool matches that.</div>
                    )}
                    {shown.map(name => (
                        <label key={name} className="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-800/50 cursor-pointer">
                            <input
                                type="checkbox"
                                className="rounded border-zinc-700 bg-zinc-900"
                                checked={selected.has(name)}
                                onChange={() => toggleTool(name)}
                            />
                            <span className="font-mono text-xs text-zinc-300">{name}</span>
                            {defaultToolSet.has(name) && (
                                <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">default</span>
                            )}
                        </label>
                    ))}
                </div>
            )}
            {toolsError && <p className="text-xs text-red-400 mt-2">{toolsError}</p>}
            {error && <p className="text-xs text-red-400 mt-2">{error}</p>}

            <div className="flex justify-end gap-2 mt-4">
                <button onClick={onCancel} className="px-3 py-2 text-sm text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800">
                    Cancel
                </button>
                <button
                    onClick={save}
                    disabled={saving}
                    className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium flex items-center gap-2"
                >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Save scope
                </button>
            </div>
        </div>
    );
}
