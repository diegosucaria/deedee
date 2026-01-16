'use client';
import { useState, useEffect } from 'react';
import { getAgentConfig, updateAgentConfig } from '../../actions';
import { Save, Eye, EyeOff, CheckCircle2, AlertCircle } from 'lucide-react';

export default function ModelsSettingsPage() {
    const [settings, setSettings] = useState({});
    const [xaiKey, setXaiKey] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [showKey, setShowKey] = useState(false);
    const [status, setStatus] = useState(null);

    useEffect(() => {
        getAgentConfig().then(data => {
            setSettings(data);
            if (data['provider:xai']?.apiKey) {
                setXaiKey(data['provider:xai'].apiKey);
            }
            setLoading(false);
        });
    }, []);

    const handleSave = async () => {
        setSaving(true);
        try {
            await updateAgentConfig('provider:xai', {
                apiKey: xaiKey,
                models: ['grok-beta', 'grok-2-vision-1212'] // Default supported models
            });
            setStatus({ type: 'success', msg: 'Settings saved successfully' });
            setTimeout(() => setStatus(null), 3000);
        } catch (err) {
            setStatus({ type: 'error', msg: 'Failed to save settings' });
        } finally {
            setSaving(false);
        }
    };

    if (loading) return <div className="p-8 text-zinc-500">Loading settings...</div>;

    return (
        <div className="max-w-4xl mx-auto space-y-8">
            <div>
                <h1 className="text-2xl font-bold text-white mb-2">Model Configuration</h1>
                <p className="text-zinc-400">Configure external AI model providers.</p>
            </div>

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

                <div className="pt-4 flex items-center justify-end gap-4">
                    {status && (
                        <div className={`flex items-center gap-2 text-sm ${status.type === 'success' ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {status.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                            {status.msg}
                        </div>
                    )}
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50"
                    >
                        {saving ? <div className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" /> : <Save size={18} />}
                        Save Configuration
                    </button>
                </div>
            </div>
        </div>
    );
}
