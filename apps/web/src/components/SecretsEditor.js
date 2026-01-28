'use client';

import { useState, useEffect } from 'react';
import { getBrowserSecretsRaw, saveBrowserSecretsRaw } from '@/app/actions';
import { Save, AlertCircle, Check, Eye, EyeOff } from 'lucide-react';

export default function SecretsEditor() {
    const [jsonContent, setJsonContent] = useState('{}');
    const [status, setStatus] = useState('idle'); // idle, saved, error
    const [errorMsg, setErrorMsg] = useState('');
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        getBrowserSecretsRaw().then(data => {
            setJsonContent(data || '{}');
        });
    }, []);

    const handleSave = async () => {
        setStatus('idle');
        setErrorMsg('');

        try {
            // Validate client-side first
            JSON.parse(jsonContent);
        } catch (e) {
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

    return (
        <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm font-semibold text-zinc-300">Browser Secrets (JSON)</h3>
                <div className="flex gap-2">
                    <button
                        onClick={() => setIsVisible(!isVisible)}
                        className="p-1.5 text-zinc-400 hover:text-white rounded hover:bg-zinc-800 transition-colors"
                        title={isVisible ? "Hide Secrets" : "Show Secrets"}
                    >
                        {isVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                    <button
                        onClick={handleSave}
                        className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded text-xs transition-colors"
                    >
                        <Save size={14} /> Save
                    </button>
                </div>
            </div>

            <div className="relative">
                <textarea
                    value={jsonContent}
                    onChange={(e) => setJsonContent(e.target.value)}
                    className={`w-full h-80 bg-black border border-zinc-800 rounded p-3 font-mono text-xs focus:outline-none focus:border-indigo-500 text-zinc-300 ${!isVisible ? 'blur-sm select-none transition-all duration-300' : ''}`}
                    spellCheck="false"
                />
                {!isVisible && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <span className="text-zinc-500 text-sm font-medium bg-black/50 px-3 py-1 rounded backdrop-blur-md">Hidden</span>
                    </div>
                )}
            </div>

            {status === 'saved' && (
                <div className="mt-2 text-green-400 text-xs flex items-center gap-1">
                    <Check size={14} /> Saved successfully
                </div>
            )}

            {status === 'error' && (
                <div className="mt-2 text-red-400 text-xs flex items-center gap-1">
                    <AlertCircle size={14} /> {errorMsg}
                </div>
            )}

            <div className="mt-4 text-[10px] text-zinc-500">
                <p>Keys stored here are accessible by the Agent's Browser Tool via <code>browser_fill_secret</code>.</p>
                <p>Format: <code>{`{"MY_CARD": "4111...", "GITHUB_TOKEN": "ghp_..."}`}</code></p>
            </div>
        </div>
    );
}
