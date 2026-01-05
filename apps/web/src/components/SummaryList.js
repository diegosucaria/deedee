export default function SummaryList({ summaries }) {
    if (!summaries || summaries.length === 0) {
        return (
            <div className="p-12 text-center border border-zinc-800 rounded-xl bg-zinc-900/50">
                <p className="text-zinc-500">No consolidated memories found.</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {summaries.map((s) => (
                <div key={s.id} className="p-6 bg-zinc-900/50 border border-zinc-800 rounded-xl hover:border-zinc-700 transition-colors">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                            <span className="px-2 py-1 text-xs font-semibold bg-indigo-500/10 text-indigo-400 rounded">
                                SUMMARY #{s.id}
                            </span>
                            <span className="text-sm text-zinc-500">
                                {new Date(s.created_at).toLocaleString()}
                            </span>
                        </div>
                        <div className="text-xs text-zinc-600 font-mono">
                            {s.range_start} → {s.range_end}
                        </div>
                    </div>

                    <div className="prose prose-invert prose-sm max-w-none">
                        <pre className="whitespace-pre-wrap font-sans text-zinc-300 bg-transparent p-0 border-none">
                            {s.content}
                        </pre>
                    </div>
                </div>
            ))}
        </div>
    );
}
