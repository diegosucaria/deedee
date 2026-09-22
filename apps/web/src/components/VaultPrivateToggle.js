'use client';
import { useState, useTransition } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { setVaultPrivate } from '@/app/actions';

/**
 * Marks a vault private. A private vault stays out of the search the agent
 * runs on every turn; a chat opened on the vault still searches it.
 */
export default function VaultPrivateToggle({ vaultId, isPrivate = false }) {
    const [priv, setPriv] = useState(!!isPrivate);
    const [error, setError] = useState(null);
    const [pending, startTransition] = useTransition();

    const toggle = () => {
        const wanted = !priv;
        setError(null);
        setPriv(wanted); // Optimistic
        startTransition(async () => {
            const res = await setVaultPrivate(vaultId, wanted);
            if (!res?.success) {
                setPriv(!wanted);
                setError(res?.error || 'Could not save');
            }
        });
    };

    return (
        <div className="flex items-center gap-2">
            <button
                onClick={toggle}
                disabled={pending}
                title={priv
                    ? 'Private: kept out of the search that runs on every turn. Click to make it searchable from any chat.'
                    : 'Searchable from any chat. Click to keep it out of the search that runs on every turn.'}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${priv
                    ? 'bg-amber-400/10 border-amber-400/30 text-amber-300 hover:bg-amber-400/20'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:bg-zinc-700'
                    } disabled:opacity-50`}
            >
                {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : priv ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                {priv ? 'Private' : 'Searchable'}
            </button>
            {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
    );
}
