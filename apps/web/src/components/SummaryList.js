/**
 * One card per stored summary. `range_start` / `range_end` hold message ids,
 * so the header names them as such and shows what the summary saved instead
 * of printing two raw ids on their own.
 */
function tokenSaving(original, summary) {
    const from = Number(original);
    const to = Number(summary);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to < 0) return null;
    const saved = from - to;
    if (saved <= 0) return null;
    return {
        from,
        to,
        saved,
        percent: Math.round((saved / from) * 100),
    };
}

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
            {summaries.map((s) => {
                const saving = tokenSaving(s.original_tokens, s.summary_tokens);
                const hasRange = s.range_start || s.range_end;
                return (
                    <div key={s.id} className="p-6 bg-zinc-900/50 border border-zinc-800 rounded-xl hover:border-zinc-700 transition-colors">
                        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                            <div className="flex flex-wrap items-center gap-3">
                                <span className="px-2 py-1 text-xs font-semibold bg-indigo-500/10 text-indigo-400 rounded">
                                    SUMMARY #{s.id}
                                </span>
                                {s.chat_id && (
                                    <span className="px-2 py-1 text-xs font-mono bg-zinc-800 text-zinc-400 rounded border border-zinc-700" title="Chat this summary came from">
                                        chat {s.chat_id}
                                    </span>
                                )}
                                <span className="text-sm text-zinc-500">
                                    {new Date(s.created_at).toLocaleString()}
                                </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-3 text-xs">
                                {saving ? (
                                    <span className="text-emerald-400" title="Tokens before and after the summary">
                                        {saving.from.toLocaleString()} → {saving.to.toLocaleString()} tokens
                                        <span className="text-zinc-500"> ({saving.percent}% saved)</span>
                                    </span>
                                ) : (
                                    <span className="text-zinc-600">token counts not recorded</span>
                                )}
                                {hasRange && (
                                    <span className="text-zinc-600 font-mono" title="First and last message id covered">
                                        msg {s.range_start || '?'}–{s.range_end || '?'}
                                    </span>
                                )}
                            </div>
                        </div>

                        <div className="prose prose-invert prose-sm max-w-none">
                            <pre className="whitespace-pre-wrap font-sans text-zinc-300 bg-transparent p-0 border-none">
                                {s.content}
                            </pre>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
