'use client';

import { useState, useEffect } from 'react';
import { getAgentConfig, updateAgentConfig } from '../actions';
import { Settings, Check, AlertTriangle } from 'lucide-react';

export default function SettingsPage() {
    const [config, setConfig] = useState(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        getAgentConfig().then(data => {
            setConfig(data);
        });
    }, []);

    const handleSave = async (key, value) => {
        setSaving(true);
        setError(null);

        // Optimistic update
        setConfig(prev => ({
            ...prev,
            searchStrategy: { ...prev?.searchStrategy, mode: value }
        }));

        const res = await updateAgentConfig('search_strategy', { mode: value });
        setSaving(false);
        if (!res.success) {
            setError(res.error);
            // Revert (simplified: re-fetch)
            getAgentConfig().then(setConfig);
        }
    };

    const currentMode = config?.searchStrategy?.mode || 'HYBRID';

    return (
        <div className="flex h-screen flex-col bg-zinc-950 text-zinc-200 p-6 md:p-12 overflow-y-auto w-full">
            <header className="mb-8 max-w-3xl mx-auto w-full">
                <h1 className="text-3xl font-bold tracking-tight text-white mb-2 flex items-center gap-3">
                    <Settings className="w-8 h-8 text-zinc-400" />
                    Agent Settings
                </h1>
                <p className="text-zinc-400">Configure global behavior strategies.</p>
            </header>

            <section className="max-w-3xl mx-auto w-full space-y-8">
                {/* Search Strategy Card */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                    <div className="p-6 border-b border-zinc-800">
                        <h2 className="text-lg font-semibold text-white">Hybrid Search Strategy</h2>
                        <p className="text-sm text-zinc-400 mt-1">
                            Controls how the agent deploys search tools.
                        </p>
                    </div>

                    <div className="p-6 space-y-4">
                        <StrategyOption
                            id="HYBRID"
                            title="Hybrid (Auto)"
                            description="Automatically switches between Native Google Search (for text) and Polyfill Search (for audio context) to balance speed and features."
                            isSelected={currentMode === 'HYBRID'}
                            onSelect={() => handleSave('search_strategy', 'HYBRID')}
                        />

                        <StrategyOption
                            id="NATIVE_ONLY"
                            title="Native Only (Performance)"
                            description="Forces Google Grounding. Faster and cheaper, but CANNOT output Audio/TTS or mix with other tools."
                            isSelected={currentMode === 'NATIVE_ONLY'}
                            onSelect={() => handleSave('search_strategy', 'NATIVE_ONLY')}
                            warning="Audio responses will fail in this mode."
                        />

                        <StrategyOption
                            id="STANDARD_ONLY"
                            title="Standard Only (Compatibility)"
                            description="Forces Polyfill Search (Tool Use). Slower, but allows text-to-speech mixing and multi-tool chains."
                            isSelected={currentMode === 'STANDARD_ONLY'}
                            onSelect={() => handleSave('search_strategy', 'STANDARD_ONLY')}
                        />
                    </div>
                    {error && (
                        <div className="bg-red-500/10 text-red-400 p-4 text-sm border-t border-red-500/20">
                            Error saving settings: {error}
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}

function StrategyOption({ id, title, description, isSelected, onSelect, warning }) {
    return (
        <button
            onClick={onSelect}
            className={`w-full text-left p-4 rounded-lg border transition-all ${isSelected
                ? 'bg-indigo-500/10 border-indigo-500/50 hover:bg-indigo-500/20'
                : 'bg-zinc-800/30 border-zinc-700/50 hover:bg-zinc-800/80 hover:border-zinc-600'
                }`}
        >
            <div className="flex items-start justify-between">
                <div>
                    <h3 className={`font-medium ${isSelected ? 'text-indigo-300' : 'text-zinc-200'}`}>
                        {title}
                    </h3>
                    <p className="text-sm text-zinc-400 mt-1">{description}</p>
                    {warning && (
                        <div className="flex items-center gap-1.5 mt-2 text-yellow-500/80 text-xs">
                            <AlertTriangle className="w-3 h-3" />
                            {warning}
                        </div>
                    )}
                </div>
                {isSelected && <Check className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />}
            </div>
        </button>
    );
}
