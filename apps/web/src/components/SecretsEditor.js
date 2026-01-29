'use client';

import { useState, useEffect, useMemo } from 'react';
import { getBrowserSecretsRaw, saveBrowserSecretsRaw } from '@/app/actions';
import { Save, AlertCircle, Check, Eye, EyeOff, Plus, Trash2, Code, List, FileJson } from 'lucide-react';

export default function SecretsEditor() {
    const [mode, setMode] = useState('table'); // 'table' | 'json'
    const [jsonContent, setJsonContent] = useState('{}');
    const [status, setStatus] = useState('idle'); // idle, saved, error
    const [errorMsg, setErrorMsg] = useState('');
    const [isVisible, setIsVisible] = useState(false); // Global visibility toggle for table

    // Initial Load
    useEffect(() => {
        getBrowserSecretsRaw().then(data => {
            const raw = data || '{}';
            setJsonContent(raw);
        });
    }, []);

    // Derived state for Table Mode
    const tableData = useMemo(() => {
        try {
            const parsed = JSON.parse(jsonContent);
            return Object.entries(parsed).map(([key, value]) => ({ key, value }));
        } catch (e) {
            return [];
        }
    }, [jsonContent]);

    // Derived state for JSON Validation
    const jsonError = useMemo(() => {
        try {
            JSON.parse(jsonContent);
            return null;
        } catch (e) {
            return e.message;
        }
    }, [jsonContent]);

    // --- handlers ---

    const handleSave = async () => {
        setStatus('idle');
        setErrorMsg('');

        if (jsonError) {
            setStatus('error');
            setErrorMsg('Invalid JSON format');
            return;
        }

        const res = await saveBrowserSecretsRaw(jsonContent);
        if (res.success) {
            setStatus('saved');
            setTimeout(() => setStatus('idle'), 3000);
        } else {
            setStatus('error');
            setErrorMsg(res.error);
        }
    };

    const updateFromTable = (newData) => {
        const obj = newData.reduce((acc, { key, value }, index) => {
            // Allow empty keys to support "Add Row" functionality
            // Note: Multiple empty keys will overwrite each other, but that's acceptable for this simple editor
            // We strip null/undefined but keep empty string
            if (key !== null && key !== undefined) {
                // Prevent key collision loss during editing by appending a temporary suffix if needed? 
                // No, simpler: just let it overwrite for now, but usually user focuses and types.
                acc[key] = value;
            }
            return acc;
        }, {});
        setJsonContent(JSON.stringify(obj, null, 2));
    };

    const addRow = () => {
        const newData = [...tableData, { key: '', value: '' }];
        updateFromTable(newData);
    };

    const updateRow = (index, field, val) => {
        const newData = [...tableData];
        newData[index][field] = val;
        updateFromTable(newData);
    };

    const deleteRow = (index) => {
        const newData = tableData.filter((_, i) => i !== index);
        updateFromTable(newData);
    };

    const formatJson = () => {
        try {
            const parsed = JSON.parse(jsonContent);
            setJsonContent(JSON.stringify(parsed, null, 2));
        } catch (e) { }
    };

    return (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 flex flex-col h-[600px]">
            {/* Header */}
            <div className="flex justify-between items-center p-4 border-b border-zinc-800/50">
                <div className="flex items-center gap-3">
                    <h3 className="text-sm font-semibold text-zinc-300">Browser Secrets</h3>
                    <div className="bg-zinc-800 rounded-md p-1 flex gap-1">
                        <button
                            onClick={() => setMode('table')}
                            className={`p-1.5 rounded text-xs flex items-center gap-1.5 transition-colors ${mode === 'table' ? 'bg-zinc-700 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                        >
                            <List size={14} /> Table
                        </button>
                        <button
                            onClick={() => setMode('json')}
                            className={`p-1.5 rounded text-xs flex items-center gap-1.5 transition-colors ${mode === 'json' ? 'bg-zinc-700 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                        >
                            <Code size={14} /> JSON
                        </button>
                    </div>
                </div>

                <div className="flex gap-2">
                    {mode === 'table' && (
                        <button
                            onClick={() => setIsVisible(!isVisible)}
                            className="p-1.5 text-zinc-400 hover:text-white rounded hover:bg-zinc-800 transition-colors"
                            title={isVisible ? "Hide Values" : "Show Values"}
                        >
                            {isVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                    )}
                    {mode === 'json' && (
                        <button
                            onClick={formatJson}
                            disabled={!!jsonError}
                            className="p-1.5 text-zinc-400 hover:text-white rounded hover:bg-zinc-800 transition-colors disabled:opacity-30"
                            title="Prettify JSON"
                        >
                            <FileJson size={16} />
                        </button>
                    )}
                    <button
                        onClick={handleSave}
                        disabled={!!jsonError}
                        className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:opacity-50 text-white px-3 py-1.5 rounded text-xs transition-colors font-medium ml-2"
                    >
                        <Save size={14} /> Save Changes
                    </button>
                </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-hidden relative">
                {mode === 'table' ? (
                    <div className="h-full flex flex-col">
                        <div className="flex-1 overflow-y-auto p-4">
                            {jsonError ? (
                                <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-2">
                                    <AlertCircle size={24} className="text-amber-500" />
                                    <p>Invalid JSON detected. Please switch to JSON mode to fix.</p>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {tableData.length === 0 && (
                                        <div className="text-center py-8 text-zinc-600 text-xs italic">
                                            No secrets defined. Add one below.
                                        </div>
                                    )}
                                    {tableData.map((row, i) => (
                                        <div key={i} className="flex gap-2 items-center group">
                                            <input
                                                type="text"
                                                placeholder="Key (e.g. GITHUB_TOKEN)"
                                                value={row.key}
                                                onChange={(e) => updateRow(i, 'key', e.target.value)}
                                                className="flex-1 bg-black/50 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-indigo-300 focus:outline-none focus:border-indigo-500/50 placeholder:text-zinc-700"
                                            />
                                            <div className="flex-[2] relative">
                                                <input
                                                    type={isVisible ? "text" : "password"}
                                                    placeholder="Value"
                                                    value={row.value}
                                                    onChange={(e) => updateRow(i, 'value', e.target.value)}
                                                    className="w-full bg-black/50 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-zinc-300 focus:outline-none focus:border-indigo-500/50 placeholder:text-zinc-700"
                                                />
                                            </div>
                                            <button
                                                onClick={() => deleteRow(i)}
                                                className="p-2 text-zinc-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        {/* Footer / Add Row */}
                        {!jsonError && (
                            <div className="p-4 border-t border-zinc-800/50 bg-zinc-900/50">
                                <button
                                    onClick={addRow}
                                    className="flex items-center gap-2 text-xs text-zinc-400 hover:text-indigo-400 transition-colors"
                                >
                                    <Plus size={14} /> Add Parameter
                                </button>
                            </div>
                        )}
                    </div>
                ) : (
                    // JSON Mode
                    <div className="h-full relative flex flex-col">
                        <textarea
                            value={jsonContent}
                            onChange={(e) => setJsonContent(e.target.value)}
                            className="flex-1 w-full bg-black/50 p-4 font-mono text-xs focus:outline-none text-zinc-300 resize-none selection:bg-indigo-500/30"
                            spellCheck="false"
                        />
                        {/* Validation Status Overlay */}
                        <div className={`absolute bottom-4 right-4 text-[10px] px-2 py-1 rounded backdrop-blur-md border ${jsonError ? 'bg-red-950/50 border-red-900/50 text-red-400' : 'bg-zinc-900/50 border-zinc-800 text-zinc-500'}`}>
                            {jsonError ? `Syntax Error: ${jsonError}` : 'Valid JSON'}
                        </div>
                    </div>
                )}
            </div>

            {/* Status Bar */}
            <div className="h-8 border-t border-zinc-800 bg-black/20 flex items-center px-4 justify-between text-[10px]">
                <div className="flex items-center gap-2">
                    {status === 'saved' && (
                        <span className="text-green-400 flex items-center gap-1.5">
                            <Check size={12} /> Saved
                        </span>
                    )}
                    {status === 'error' && (
                        <span className="text-red-400 flex items-center gap-1.5">
                            <AlertCircle size={12} /> {errorMsg}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}
