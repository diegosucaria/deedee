'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getAgentConfig, updateAgentConfig, getEnvConfig, getBackups, getVoiceSettings, saveVoiceSettings } from '../actions';
import { Settings, Check, AlertTriangle, Eye, EyeOff, Save } from 'lucide-react';
import BackupSettings from '@/components/BackupSettings';
import EnvVariables from '@/components/EnvVariables';
import VoiceSelector from '@/components/VoiceSelector';
import ScrollableTabs from '@/components/ScrollableTabs';
import PageShell from '@/components/PageShell';
import InterfacesClient from '@/components/InterfacesClient';
import SecurityClient from './security/SecurityClient';

import { Suspense } from 'react';

function SettingsContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const activeTab = searchParams.get('tab') || 'general';

    const [config, setConfig] = useState(null);
    const [env, setEnv] = useState({});
    const [backups, setBackups] = useState([]);
    const [voice, setVoice] = useState('Kore');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [xaiKey, setXaiKey] = useState('');
    const [showKey, setShowKey] = useState(false);
    const [newModel, setNewModel] = useState('');

    useEffect(() => {
        Promise.all([
            getAgentConfig(),
            getEnvConfig(),
            getBackups(),
            getVoiceSettings()
        ]).then(([configData, envData, backupsData, voiceData]) => {
            setConfig(configData);
            if (configData['provider:xai']?.apiKey) {
                setXaiKey(configData['provider:xai'].apiKey);
            }
            setEnv(envData);
            setBackups(backupsData);
            setVoice(voiceData);
        });
    }, []);

    const handleTabChange = (tabId) => {
        router.replace(`/settings?tab=${tabId}`);
    };

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

    const [passkeysAvailable, setPasskeysAvailable] = useState(false);
    useEffect(() => {
        let cancelled = false;
        fetch('/api/auth/me', { cache: 'no-store' })
            .then((r) => r.ok ? r.json() : null)
            .then((d) => { if (!cancelled && d) setPasskeysAvailable(!!d.passkeysEnabled); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);

    const tabs = [
        { id: 'general', label: 'General' },
        { id: 'models', label: 'Models' },
        { id: 'communication', label: 'Communication' },
        { id: 'interfaces', label: 'Interfaces' },
        { id: 'security', label: 'Security' },
        { id: 'backups', label: 'Backups' },
        { id: 'environment', label: 'Environment' },
    ];

    return (
        <PageShell icon={Settings} title="Agent Settings" subtitle="Configure global behaviors and system preferences.">
            <ScrollableTabs
                tabs={tabs}
                activeTab={activeTab}
                onChange={handleTabChange}
                variant="pill"
                className="mb-8"
            />

            <section className="max-w-3xl space-y-8">
                {/* General Tab */}
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
                    </div>
                )}

                {/* Models Tab */}
                {activeTab === 'models' && (
                    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 space-y-6">
                            <div className="flex items-center gap-3 border-b border-zinc-800 pb-4">
                                <div className="h-10 w-10 bg-white text-black rounded-lg flex items-center justify-center font-bold text-xl">
                                    X
                                </div>
                                <div>
                                    <h3 className="text-lg font-medium text-white">xAI (Grok)</h3>
                                    <p className="text-sm text-zinc-400">Enable access to Grok models.</p>
                                </div>
                            </div>

                            <div className="space-y-4">
                                <label className="block text-sm font-medium text-zinc-300">API Key</label>
                                <div className="relative">
                                    <input
                                        type={showKey ? "text" : "password"}
                                        value={xaiKey}
                                        onChange={(e) => setXaiKey(e.target.value)}
                                        onBlur={(e) => handleSave('provider:xai', {
                                            apiKey: e.target.value,
                                            models: config?.['provider:xai']?.models || ['grok-beta', 'grok-2-vision-1212']
                                        })}
                                        placeholder="xai-..."
                                        className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-white focus:border-transparent outline-none transition-all"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowKey(!showKey)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
                                    >
                                        {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                                    </button>
                                </div>
                                <p className="text-xs text-zinc-500">
                                    Get your API key from <a href="https://console.x.ai/" target="_blank" className="text-indigo-400 hover:underline">console.x.ai</a>
                                </p>
                            </div>

                            <div className="space-y-4 pt-4 border-t border-zinc-800">
                                <label className="block text-sm font-medium text-zinc-300">Available Models</label>
                                <div className="flex flex-wrap gap-2">
                                    {(config?.['provider:xai']?.models || ['grok-beta', 'grok-2-vision-1212']).map((model) => (
                                        <div key={model} className="flex items-center gap-2 bg-zinc-800 px-3 py-1.5 rounded-full text-sm text-zinc-300 border border-zinc-700">
                                            <span>{model}</span>
                                            <button
                                                onClick={() => {
                                                    const currentModels = config?.['provider:xai']?.models || ['grok-beta', 'grok-2-vision-1212'];
                                                    const newModels = currentModels.filter(m => m !== model);
                                                    handleSave('provider:xai', {
                                                        apiKey: xaiKey,
                                                        models: newModels
                                                    });
                                                }}
                                                className="hover:text-red-400 transition-colors"
                                            >
                                                ×
                                            </button>
                                        </div>
                                    ))}
                                </div>

                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={newModel}
                                        onChange={(e) => setNewModel(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                if (!newModel.trim()) return;
                                                const currentModels = config?.['provider:xai']?.models || ['grok-beta', 'grok-2-vision-1212'];
                                                if (!currentModels.includes(newModel.trim())) {
                                                    handleSave('provider:xai', {
                                                        apiKey: xaiKey,
                                                        models: [...currentModels, newModel.trim()]
                                                    });
                                                }
                                                setNewModel('');
                                            }
                                        }}
                                        placeholder="Add model ID (e.g. grok-4-1...)"
                                        className="flex-1 bg-zinc-950 border border-zinc-700 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none text-sm"
                                    />
                                    <button
                                        onClick={() => {
                                            if (!newModel.trim()) return;
                                            const currentModels = config?.['provider:xai']?.models || ['grok-beta', 'grok-2-vision-1212'];
                                            if (!currentModels.includes(newModel.trim())) {
                                                handleSave('provider:xai', {
                                                    apiKey: xaiKey,
                                                    models: [...currentModels, newModel.trim()]
                                                });
                                            }
                                            setNewModel('');
                                        }}
                                        className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                                    >
                                        Add
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Communication Tab */}
                {activeTab === 'communication' && (
                    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                        {/* Communication Style */}
                        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                            <h2 className="text-lg font-semibold text-white mb-4">Communication Style</h2>
                            <div>
                                <label className="block text-sm font-medium text-zinc-400 mb-1">
                                    Tone &amp; Register
                                </label>
                                <textarea
                                    defaultValue={config?.communication_style || ''}
                                    onBlur={(e) => handleSave('communication_style', e.target.value)}
                                    placeholder="Describe the voice the agent should use when writing to you (e.g. warm but polished, leaning neutral). Leave blank for the model default."
                                    rows={4}
                                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none resize-y"
                                />
                                <p className="text-xs text-zinc-500 mt-1">
                                    Free text describing tone and register. Describe the voice you want rather than listing words to avoid — positive phrasing steers more reliably. Does not override language matching.
                                </p>
                            </div>
                        </div>

                        {/* Communication Settings */}
                        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                            <h2 className="text-lg font-semibold text-white mb-4">Notifications & Messaging</h2>

                            <div className="space-y-6">
                                {/* Notification Channel */}
                                <div>
                                    <label className="block text-sm font-medium text-zinc-400 mb-1">
                                        Notification Channel
                                    </label>
                                    <select
                                        value={config?.notification_channel || 'whatsapp'}
                                        onChange={(e) => handleSave('notification_channel', e.target.value)}
                                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none"
                                    >
                                        <option value="whatsapp">WhatsApp</option>
                                        <option value="telegram">Telegram</option>
                                    </select>
                                    <p className="text-xs text-zinc-500 mt-1">
                                        Where the agent sends "pushed" alerts and reminders.
                                    </p>
                                </div>

                                <div className="border-t border-zinc-800/50 pt-6 flex items-center justify-between">
                                    <div>
                                        <h3 className="text-white font-medium">Dry Run Mode</h3>
                                        <p className="text-sm text-zinc-400 mt-1 max-w-md">
                                            Simulate sending messages without actually dispatching them.
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

                {activeTab === 'interfaces' && (
                    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                        {/* Remove header from InterfacesClient if you want it cleaner, 
                            but for now we just render it. It has its own layout which might look double-headed.
                            Actually InterfacesClient has a big header "Interfaces". 
                            SettingsPage has "Agent Settings".
                            It's probably fine as a subsection.
                        */}
                        <InterfacesClient />
                    </div>
                )}

                {activeTab === 'security' && (
                    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                        <SecurityClient passkeysEnabled={passkeysAvailable} />
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
        </PageShell>
    );
}

export default function SettingsPage() {
    return (
        <Suspense fallback={<div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-500">Loading settings...</div>}>
            <SettingsContent />
        </Suspense>
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
