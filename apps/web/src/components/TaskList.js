'use client';

import { useState } from 'react';
import { Trash2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation'; // Keep for client-side refresh if needed
import { cancelTask } from '../app/actions';

export function TaskList({ initialJobs }) {
    const router = useRouter();
    const [jobs, setJobs] = useState(initialJobs);
    const [canceling, setCanceling] = useState(null);

    const handleCancel = async (name) => {
        if (!confirm(`Are you sure you want to cancel job "${name}"?`)) return;

        setCanceling(name);

        // Optimistic Update
        const previousJobs = [...jobs];
        setJobs(prev => prev.filter(j => j.name !== name));

        try {
            const result = await cancelTask(name);

            if (!result.success) {
                throw new Error(result.error || 'Failed');
            }
            // Success: Data is revalidated on server.
            // We can optionally router.refresh() to ensure we are in sync, 
            // effectively re-fetching the server component and updating props, 
            // but since we are using local state initialized from props, 
            // we might not see the prop update unless we sync state to props (useEffect).
            // For simple list, optimistic update is sufficient UX. 
            // Router refresh ensures if we navigate away and back we are good.
            router.refresh();
        } catch (err) {
            console.error(err);
            alert('Error canceling task: ' + err.message);
            // Revert
            setJobs(previousJobs);
        } finally {
            setCanceling(null);
        }
    };

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {jobs.map((job) => (
                <div key={job.name} className="p-6 rounded-xl bg-zinc-900 border border-zinc-800 flex flex-col justify-between">
                    <div>
                        <h3 className="text-lg font-semibold text-zinc-200 flex items-center gap-2">
                            {job.name}
                        </h3>
                        <div className="mt-2 text-sm text-zinc-400 font-mono bg-zinc-950 p-2 rounded border border-zinc-800 inline-block">
                            {job.cron}
                        </div>
                        <div className="mt-4 text-sm text-zinc-500">
                            Next Run: <span className="text-zinc-300">{job.nextInvocation ? new Date(job.nextInvocation).toLocaleString() : 'N/A'}</span>
                        </div>
                    </div>

                    <div className="mt-6 flex justify-end">
                        <button
                            onClick={() => handleCancel(job.name)}
                            disabled={canceling === job.name}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-rose-500/10 text-rose-500 hover:bg-rose-500/20 transition-colors text-sm font-medium disabled:opacity-50"
                        >
                            {canceling === job.name ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            Cancel
                        </button>
                    </div>
                </div>
            ))}

            {jobs.length === 0 && (
                <p className="text-zinc-500 col-span-full text-center py-10">No active scheduled tasks.</p>
            )}
        </div>
    );
}
