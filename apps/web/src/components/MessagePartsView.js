'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { describeParts, clipBody } from '@/lib/message-parts';

const KIND_LABEL = { call: 'Tool call', result: 'Tool result', media: 'Media', text: 'Text', thought: 'Thought', other: 'Part' };
const KIND_COLOR = {
    call: 'text-amber-400',
    result: 'text-emerald-400',
    media: 'text-sky-400',
    text: 'text-zinc-400',
    thought: 'text-purple-400',
    other: 'text-zinc-500'
};

/** One part. A long body opens with a first screenful and a "show all". */
function PartRow({ part }) {
    const [open, setOpen] = useState(false);
    const { head, hidden } = useMemo(() => clipBody(part.body), [part.body]);
    const body = open ? part.body : head;

    return (
        <div className="border-t border-zinc-800/60 pt-2 first:border-t-0 first:pt-0">
            <div className="text-xs font-medium">
                <span className={clsx(KIND_COLOR[part.kind] || KIND_COLOR.other, 'opacity-80')}>{KIND_LABEL[part.kind] || KIND_LABEL.other}</span>
                {part.name && <span className="font-mono text-zinc-300 ml-1.5">{part.name}</span>}
            </div>
            {body && (
                <pre className="text-[11px] text-zinc-500 bg-zinc-950/60 p-2 rounded mt-1 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
                    {body}
                </pre>
            )}
            {hidden > 0 && (
                <button
                    type="button"
                    onClick={() => setOpen(!open)}
                    className="text-[10px] text-zinc-600 hover:text-zinc-300 mt-1 transition-colors"
                >
                    {open ? 'Show less' : `Show all (${hidden} more lines)`}
                </button>
            )}
        </div>
    );
}

/**
 * The raw `parts` of a message, read as text. Rows in Message History only
 * show `content`, so a turn whose work sits in tool calls used to look empty.
 */
export default function MessagePartsView({ parts }) {
    const [open, setOpen] = useState(false);
    const rows = useMemo(() => describeParts(parts), [parts]);
    if (rows.length === 0) return null;

    const Chevron = open ? ChevronDown : ChevronRight;
    return (
        <div className="mt-2">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="flex items-center gap-1 text-[11px] text-zinc-600 hover:text-zinc-300 transition-colors"
            >
                <Chevron className="w-3 h-3" />
                {rows.length} part{rows.length === 1 ? '' : 's'}
            </button>
            {open && (
                <div className="mt-2 space-y-2 bg-zinc-900/40 border border-zinc-800/50 rounded-xl p-3">
                    {rows.map((part, i) => <PartRow key={i} part={part} />)}
                </div>
            )}
        </div>
    );
}
