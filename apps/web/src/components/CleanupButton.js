'use client';

import { useState } from 'react';
import { cleanupData } from '@/app/actions';
import { Trash2, AlertTriangle, Loader2 } from 'lucide-react';

export default function CleanupButton() {
    const [status, setStatus] = useState('idle'); // idle, confirming, loading, success, error

    const handleCleanup = async () => {
        setStatus('loading');
        try {
            const result = await cleanupData();
            if (!result.success) throw new Error(result.error);
            setStatus('success');
            setTimeout(() => setStatus('idle'), 3000);
        } catch (err) {
            console.error(err);
            setStatus('error');
            setTimeout(() => setStatus('idle'), 3000);
        }
    };

    if (status === 'confirming') {
        return (
            <div className="flex items-center gap-2 animate-in fade-in zoom-in duration-200">
                <span className="text-sm text-red-400 font-medium flex items-center gap-1">
                    <AlertTriangle className="w-4 h-4" />
                    Reset All Metrics?
                </span>
                <button
                    onClick={handleCleanup}
                    className="px-3 py-1 bg-red-500 hover:bg-red-600 text-white text-xs font-bold rounded transition-colors"
                >
                    YES
                </button>
                <button
                    onClick={() => setStatus('idle')}
                    className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 text-xs font-medium rounded transition-colors"
                >
                    NO
                </button>
            </div>
        );
    }

    if (status === 'loading') {
        return (
            <div className="flex items-center gap-2 text-zinc-500 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                Cleaning...
            </div>
        );
    }

    if (status === 'success') {
        return (
            <div className="text-emerald-400 text-sm font-medium animate-in fade-in">
                Cleanup Complete
            </div>
        );
    }

    return (
        <button
            onClick={() => setStatus('confirming')}
            className="group flex items-center gap-2 px-3 py-1.5 rounded-lg border border-red-500/20 bg-red-500/10 hover:bg-red-500/20 text-red-400 transition-all text-sm"
            title="Delete all metrics and logs"
        >
            <Trash2 className="w-4 h-4 group-hover:scale-110 transition-transform" />
            <span className="font-medium">Reset Metrics</span>
        </button>
    );
}
