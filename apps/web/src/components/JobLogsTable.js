'use client';

import { useState, useEffect } from 'react';
import { fetchAPI } from '@/lib/api';
import { Clock, CheckCircle, XCircle, RefreshCw } from 'lucide-react';

const LogContent = ({ content }) => {
    const [expanded, setExpanded] = useState(false);

    if (!content) return <span className="text-zinc-500">-</span>;

    // Helper to deeply parse JSON strings within objects
    const deepParse = (input) => {
        if (typeof input === 'string') {
            try {
                const parsed = JSON.parse(input);
                if (typeof parsed === 'object' && parsed !== null) {
                    return deepParse(parsed);
                }
            } catch (e) { return input; }
        }

        if (typeof input === 'object' && input !== null) {
            if (Array.isArray(input)) {
                return input.map(deepParse);
            }
            const newObj = {};
            for (const key in input) {
                newObj[key] = deepParse(input[key]);
            }
            return newObj;
        }

        return input;
    };

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
                            let candidate = contentToParse.substring(i, j + 1);
                            try {
                                let parsed = JSON.parse(candidate);
                                if (typeof parsed === 'object' && parsed !== null) {
                                    parsed = deepParse(parsed);
                                    return JSON.stringify(parsed, null, 2);
                                }
                            } catch (e) {
                                // 1. Try cleaning newlines (already added)
                                try {
                                    const sanitized = candidate.replace(/\n/g, '\\n');
                                    let parsed = JSON.parse(sanitized);
                                    return JSON.stringify(deepParse(parsed), null, 2);
                                } catch (e2) {
                                    // 2. Try handling Python-style dicts (common in Pydantic/Python logs)
                                    // input_value={'limit': 100} -> {"limit": 100}
                                    try {
                                        let pySanitized = candidate
                                            .replace(/'/g, '"')          // Replace single quotes with double (brittle but works for simple dumps)
                                            .replace(/None/g, 'null')    // Python None -> null
                                            .replace(/True/g, 'true')    // Python True -> true
                                            .replace(/False/g, 'false')  // Python False -> false
                                            .replace(/\(/g, '[')         // Tuples -> Arrays
                                            .replace(/\)/g, ']')
                                            .replace(/\\n/g, "\\\\n");   // Fix double escapes if needed

                                        let parsed = JSON.parse(pySanitized);
                                        return JSON.stringify(deepParse(parsed), null, 2);
                                    } catch (e3) {
                                        // Still failed
                                    }
                                }
                            }
                            // If we found a balanced block but it failed parsing, 
                            // we usually stop because we found the matching brace for the start.
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
    const processedLines = lines.map((line, idx) => {
        const prettyJson = parseLine(line);
        return { original: line, pretty: prettyJson, id: idx };
    });

    const hasJson = processedLines.some(l => l.pretty);

    if (hasJson || lines.length > 5) {
        return (
            <div className="flex flex-col gap-1">
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
                    <div className="flex flex-col gap-1 border-l-2 border-zinc-800 pl-2">
                        {processedLines.map((l) => (
                            <div key={l.id} className="text-xs font-mono break-words whitespace-pre-wrap text-zinc-400">
                                {l.pretty ? (
                                    <details className="group my-1">
                                        <summary className="cursor-pointer text-indigo-300 hover:text-indigo-200 list-none flex items-center gap-2 select-none">
                                            <span className="bg-indigo-500/10 border border-indigo-500/20 px-1 rounded text-[10px] font-bold">JSON</span>
                                            <span className="opacity-50 truncate">{l.original.substring(0, 60)}...</span>
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
                        <button onClick={() => setExpanded(false)} className="text-[10px] text-zinc-500 hover:text-zinc-300 mt-2">Collapse</button>
                    </div>
                ) : (
                    // Preview (last few lines? or first few?)
                    <div className="text-zinc-500 text-xs font-mono line-clamp-3 cursor-pointer" onClick={() => setExpanded(true)}>
                        {content}
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="text-zinc-400 font-mono text-xs break-words whitespace-pre-wrap">
            {content}
        </div>
    );
};

export default function JobLogsTable() {
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);

    const loadLogs = async () => {
        setLoading(true);
        try {
            const data = await fetchAPI('/v1/logs/jobs?limit=50');
            setLogs(data.logs || []);
        } catch (err) {
            console.error('Failed to load job logs:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadLogs();
        const interval = setInterval(loadLogs, 30000); // Poll every 30s
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-zinc-300 flex items-center gap-2">
                    <Clock className="w-5 h-5 text-indigo-400" />
                    Recent Job Executions
                </h3>
                <button
                    onClick={loadLogs}
                    className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-white transition-colors"
                >
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            <div className="overflow-x-auto max-h-[600px]">
                <table className="w-full text-sm text-left relative">
                    <thead className="bg-zinc-950 text-zinc-500 uppercase text-xs sticky top-0 z-10 shadow-sm border-b border-zinc-800">
                        <tr>
                            <th className="px-6 py-3 w-[120px]">Status</th>
                            <th className="px-6 py-3 w-[200px]">Job Name</th>
                            <th className="px-6 py-3 min-w-[300px]">Output</th>
                            <th className="px-6 py-3 w-[100px] text-right">Duration</th>
                            <th className="px-6 py-3 w-[180px] text-right">Time</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800 bg-zinc-900/50">
                        {logs.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-6 py-12 text-center text-zinc-500">
                                    No job logs found.
                                </td>
                            </tr>
                        ) : (
                            logs.map((log) => (
                                <tr key={log.id} className="hover:bg-zinc-800/50 transition-colors group">
                                    <td className="px-6 py-4 align-top">
                                        {log.status === 'success' ? (
                                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-500 border border-emerald-500/10">
                                                <CheckCircle className="w-3 h-3" />
                                                Success
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-500/10 text-red-500 border border-red-500/10">
                                                <XCircle className="w-3 h-3" />
                                                Failed
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-6 py-4 align-top font-mono text-zinc-300 text-xs">
                                        {log.job_name}
                                    </td>
                                    <td className="px-6 py-4 align-top max-w-xl">
                                        <LogContent content={log.output} />
                                    </td>
                                    <td className="px-6 py-4 align-top text-right text-zinc-400 font-mono text-xs">
                                        {log.duration_ms}ms
                                    </td>
                                    <td className="px-6 py-4 align-top text-right text-zinc-500 text-xs whitespace-nowrap">
                                        {new Date(log.timestamp).toLocaleString(undefined, {
                                            month: 'short', day: 'numeric',
                                            hour: '2-digit', minute: '2-digit'
                                        })}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
