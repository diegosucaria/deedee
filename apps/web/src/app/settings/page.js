'use client';

import { useState, useEffect } from 'react';
import { getAgentConfig, updateAgentConfig, getEnvConfig, getBackups, getVoiceSettings, saveVoiceSettings } from '../actions';
import { Settings, Check, AlertTriangle } from 'lucide-react';
import BackupSettings from '@/components/BackupSettings';
import EnvVariables from '@/components/EnvVariables';
import VoiceSelector from '@/components/VoiceSelector';

export default function SettingsPage() {
    const [config, setConfig] = useState(null);
    const [env, setEnv] = useState({});
    const [backups, setBackups] = useState([]);
    const [voice, setVoice] = useState('Kore');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [activeTab, setActiveTab] = useState('general');

    useEffect(() => {
        Promise.all([
            getAgentConfig(),
            getEnvConfig(),
            getBackups(),
            getVoiceSettings()
        ]).then(([configData, envData, backupsData, voiceData]) => {
            setConfig(configData);
            setEnv(envData);
            setBackups(backupsData);
            setVoice(voiceData);
        });
    }, []);

    const handleVoiceChange = async (newVoice) => {
        setSaving(true);
        // Optimistic
        setVoice(newVoice);
        const res = await saveVoiceSettings(newVoice);
        setSaving(false);
        if (!res.success) {
            setError(res.error);
            // Revert
            getVoiceSettings().then(setVoice);
        }
    };

    const handleSave = async (key, value) => {
        setSaving(true);
        setError(null);

        // Optimistic update
        setConfig(prev => ({
            ...prev,
            [key]: value, // Support top-level keys like owner_phone
            search_strategy: key === 'search_strategy' ? { ...prev?.search_strategy, mode: value } : prev?.search_strategy
        }));

        const payload = key === 'search_strategy' ? { mode: value } : value;
        const res = await updateAgentConfig(key, payload);

        setSaving(false);
        if (!res.success) {
            setError(res.error);
            // Revert (simplified: re-fetch)
            getAgentConfig().then(setConfig);
        }
    };

    const currentMode = config?.search_strategy?.mode || 'HYBRID';

    const tabs = [
        { id: 'general', label: 'General' },
        { id: 'backups', label: 'Backups' },
        { id: 'environment', label: 'Environment' },
    ];

    return (
        <div className="flex h-screen flex-col bg-zinc-950 text-zinc-200 p-6 md:p-12 overflow-y-auto w-full">
            <header className="mb-8 max-w-3xl mx-auto w-full">
                <h1 className="text-3xl font-bold tracking-tight text-white mb-2 flex items-center gap-3">
                    <Settings className="w-8 h-8 text-zinc-400" />
                    Agent Settings
                </h1>
                <p className="text-zinc-400">Configure global behaviors and system preferences.</p>

                {/* Tabs */}
                <div className="flex space-x-1 mt-6 bg-zinc-900/50 p-1 rounded-lg border border-zinc-800/50 w-fit">
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === tab.id
                                ? 'bg-zinc-800 text-white shadow-sm'
                                : 'text-zinc-400 hover:text-white hover:bg-zinc-800/50'
                                }`}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            </header>

            <section className="max-w-3xl mx-auto w-full space-y-8 pb-20">
                {activeTab === 'general' && (
                    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">

                        {/* Owner Phone */}
                        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                            <h2 className="text-lg font-semibold text-white mb-4">Owner Contact</h2>
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-sm font-medium text-zinc-400 mb-1">
                                        Your Name
                                    </label>
                                    <input
                                        type="text"
                                        defaultValue={config?.owner_name || ''}
                                        onBlur={(e) => handleSave('owner_name', e.target.value)}
                                        placeholder="e.g. Diego"
                                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none"
                                    />
                                    <p className="text-xs text-zinc-500 mt-1">
                                        How the agent should address you.
                                    </p>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-zinc-400 mb-1">
                                        Your Phone Number (WhatsApp)
                                    </label>
                                    <input
                                        type="text"
                                        defaultValue={config?.owner_phone || ''}
                                        onBlur={(e) => handleSave('owner_phone', e.target.value)}
                                        placeholder="e.g. 549351..."
                                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none"
                                    />
                                    <p className="text-xs text-zinc-500 mt-1">
                                        Used to resolve "me", "diego", "owner" in messages.
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Communication Settings */}
                        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                            <h2 className="text-lg font-semibold text-white mb-4">Communication</h2>
                            <div className="flex items-center justify-between">
                                <div>
                                    <h3 className="text-white font-medium">Dry Run Mode</h3>
                                    <p className="text-sm text-zinc-400 mt-1 max-w-md">
                                        Simulate sending messages without actually dispatching them to WhatsApp.
                                        Useful for testing delayed notifications safely.
                                    </p>
                                </div>
                                <div className="flex items-center">
                                    <label className="relative inline-flex items-center cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={config?.communication_dry_run === true}
                                            onChange={(e) => handleSave('communication_dry_run', e.target.checked)}
                                            className="sr-only peer"
                                        />
                                        <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-500/50 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                                    </label>
                                </div>
                            </div>
                            {config?.communication_dry_run && (
                                <div className="mt-4 flex items-center gap-2 text-yellow-500/90 text-sm bg-yellow-500/10 p-3 rounded-lg border border-yellow-500/20">
                                    <AlertTriangle className="w-4 h-4" />
                                    <span>
                                        <strong>Dry Run Active:</strong> The agent will LOG success but NO messages will be sent out.
                                    </span>
                                </div>
                            )}
                        </div>

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

                        {/* Voice Settings Card */}
                        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                            <div className="p-6 border-b border-zinc-800">
                                <h2 className="text-lg font-semibold text-white">Live Agent Voice</h2>
                                <p className="text-sm text-zinc-400 mt-1">
                                    Choose the voice persona for Gemini Live sessions.
                                </p>
                            </div>
                            <div className="p-6">
                                <VoiceSelector selectedVoice={voice} onSelect={handleVoiceChange} />
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'backups' && (
                    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                        <BackupSettings backups={backups} />
                    </div>
                )}

                {activeTab === 'environment' && (
                    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                        <EnvVariables env={env} />
                    </div>
                )}
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
