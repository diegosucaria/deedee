'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, AlertTriangle, Loader2, CheckCircle } from 'lucide-react';
import { clearSummaries } from '@/app/actions';

/** Deletes every stored chat summary. Asks first, like the metrics reset. */
export default function ClearSummariesButton() {
    const router = useRouter();
    const [status, setStatus] = useState('idle'); // idle, confirming, loading, success, error

    const handleClear = async () => {
        setStatus('loading');
        const result = await clearSummaries();
        if (!result.success) {
            console.error('clearSummaries failed:', result.error);
            setStatus('error');
            setTimeout(() => setStatus('idle'), 3000);
            return;
        }
        setStatus('success');
        router.refresh();
        setTimeout(() => setStatus('idle'), 3000);
    };

    if (status === 'confirming') {
        return (
            <div className="flex items-center gap-2">
                <span className="text-sm text-red-400 font-medium flex items-center gap-1">
                    <AlertTriangle className="w-4 h-4" />
                    Delete every summary?
                </span>
                <button onClick={handleClear}
                    className="px-3 py-1 bg-red-500 hover:bg-red-600 text-white text-xs font-bold rounded transition-colors">
                    YES
                </button>
                <button onClick={() => setStatus('idle')}
                    className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 text-xs font-medium rounded transition-colors">
                    NO
                </button>
            </div>
        );
    }

    if (status === 'loading') {
        return (
            <span className="flex items-center gap-2 px-3 py-1.5 text-sm text-zinc-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                Clearing...
            </span>
        );
    }

    if (status === 'success') {
        return (
            <span className="flex items-center gap-2 px-3 py-1.5 text-sm text-emerald-400">
                <CheckCircle className="w-4 h-4" />
                Summaries cleared
            </span>
        );
    }

    return (
        <button
            onClick={() => setStatus('confirming')}
            className="group flex items-center gap-2 px-3 py-1.5 rounded-lg border border-red-500/20 bg-red-500/10 hover:bg-red-500/20 text-red-400 transition-all text-sm"
            title={status === 'error' ? 'That did not work. Try again.' : 'Delete every stored chat summary. The messages stay.'}
        >
            <Trash2 className="w-4 h-4 group-hover:scale-110 transition-transform" />
            <span className="font-medium">{status === 'error' ? 'Failed, try again' : 'Clear Summaries'}</span>
        </button>
    );
}
