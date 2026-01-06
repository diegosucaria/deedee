'use client';

import { useState } from 'react';
import { safeParse, deepParse } from '@/lib/json-parser';
import { RefreshCw } from 'lucide-react';
import clsx from 'clsx';

export default function LogContent({ content, className }) {
    const [expanded, setExpanded] = useState(false);

    if (!content) return <span className="text-zinc-500">-</span>;

    // Helper to extract and parse JSON using brace balancing
    const parseLine = (line) => {
        if (!line) return null;
        let contentToParse = line.trim();

        // Scanner to find first valid JSON object/array
        for (let i = 0; i < contentToParse.length; i++) {
            const char = contentToParse[i];
            if (char === '{' || char === '[') {
                const isObject = char === '{';
                const startChar = char;
                const endChar = isObject ? '}' : ']';

                let balance = 0;
                let inQuote = false;
                let escape = false;

                // Scan forward from i
                for (let j = i; j < contentToParse.length; j++) {
                    const c = contentToParse[j];

                    if (escape) { escape = false; continue; }
                    if (c === '\\') { escape = true; continue; }
                    if (c === '"') { inQuote = !inQuote; continue; }

                    if (!inQuote) {
                        if (c === startChar) balance++;
                        else if (c === endChar) balance--;

                        if (balance === 0) {
                            // Found balanced end
                            const candidate = contentToParse.substring(i, j + 1);

                            // Use robust parsing
                            const parsed = safeParse(candidate);
                            if (parsed) {
                                try {
                                    const deep = deepParse(parsed);
                                    return JSON.stringify(deep, null, 2);
                                } catch (err) {
                                    console.error('deepParse failed:', err, candidate);
                                }
                            } else {
                                // console.warn('safeParse failed for candidate:', candidate.substring(0, 100));
                            }
                            break;
                        }
                    }
                }
            }
        }
        return null; // No JSON found
    };

    // Process all lines
    const lines = typeof content === 'string' ? content.split('\n') : [JSON.stringify(content)];
    // Optimization: only try parsing if line looks like JSON to avoid performance hit on huge logs
    const processedLines = lines.map((line, idx) => {
        const prettyJson = (line.includes('{') || line.includes('[')) ? parseLine(line) : null;
        return { original: line, pretty: prettyJson, id: idx };
    });

    const hasJson = processedLines.some(l => l.pretty);

    if (hasJson || lines.length > 5) {
        return (
            <div className={clsx("flex flex-col gap-1 min-w-0 w-full", className)}>
                {!expanded && (
                    <div
                        onClick={() => setExpanded(true)}
                        className="cursor-pointer text-xs text-indigo-400 hover:text-indigo-300 font-mono flex items-center gap-2 mb-1"
                    >
                        <RefreshCw className="w-3 h-3" />
                        <span>View Full Log ({lines.length} lines)</span>
                    </div>
                )}

                {expanded ? (
                    <div className="flex flex-col gap-1 border-l-2 border-zinc-800 pl-2 w-full">
                        {processedLines.map((l) => (
                            <div key={l.id} className="text-xs font-mono break-words whitespace-pre-wrap text-zinc-400 w-full">
                                {l.pretty ? (
                                    <details className="group my-1 open:bg-black/20 rounded">
                                        <summary className="cursor-pointer text-indigo-300 hover:text-indigo-200 list-none flex items-center gap-2 select-none">
                                            <span className="bg-indigo-500/10 border border-indigo-500/20 px-1 rounded text-[10px] font-bold">JSON</span>
                                            <span className="opacity-50 truncate max-w-[300px]">{l.original.substring(0, 60)}...</span>
                                        </summary>
                                        <pre className="mt-1 p-2 bg-black/50 rounded border border-white/5 text-[10px] text-zinc-300 overflow-x-auto whitespace-pre shadow-inner">
                                            {l.pretty}
                                        </pre>
                                    </details>
                                ) : (
                                    <div className="py-0.5">{l.original}</div>
                                )}
                            </div>
                        ))}
                        <button onClick={() => setExpanded(false)} className="text-[10px] text-zinc-500 hover:text-zinc-300 mt-2 text-left">Collapse</button>
                    </div>
                ) : (
                    // Preview (last few lines? or first few?)
                    <div className="text-zinc-500 text-xs font-mono line-clamp-3 cursor-pointer break-all" onClick={() => setExpanded(true)}>
                        {content}
                    </div>
                )}
            </div>
        );
    }

    // Default simple view (preserves passed className for colors)
    return (
        <span className={clsx("font-mono text-xs break-all whitespace-pre-wrap", className || "text-zinc-400")}>
            {content}
        </span>
    );
};
