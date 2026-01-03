
import { fetchAPI } from '@/lib/api';
import { Database } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function FactsPage() {
    let facts = [];
    try {
        const data = await fetchAPI('/v1/facts');
        facts = data.facts || [];
    } catch (err) {
        console.error('Facts fetch error:', err);
    }

    return (
        <div className="p-8">
            <h1 className="text-3xl font-bold mb-8 flex items-center gap-3">
                <Database className="h-8 w-8 text-indigo-400" />
                Memory Bank
            </h1>

            <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-sm">
                <table className="w-full text-left text-sm text-zinc-400">
                    <thead className="bg-zinc-950 text-zinc-200 uppercase tracking-wider text-xs font-medium border-b border-zinc-800">
                        <tr>
                            <th className="px-6 py-4">Key</th>
                            <th className="px-6 py-4">Value</th>
                            <th className="px-6 py-4">Last Updated</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                        {facts.map((fact) => (
                            <tr key={fact.key} className="hover:bg-zinc-800/50 transition-colors">
                                <td className="px-6 py-4 font-mono text-indigo-300">{fact.key}</td>
                                <td className="px-6 py-4 text-zinc-300">
                                    {typeof fact.value === 'object' ? JSON.stringify(fact.value) : fact.value}
                                </td>
                                <td className="px-6 py-4 text-zinc-500">
                                    {fact.updated_at ? new Date(fact.updated_at).toLocaleString() : '-'}
                                </td>
                            </tr>
                        ))}
                        {facts.length === 0 && (
                            <tr>
                                <td colSpan="3" className="px-6 py-8 text-center text-zinc-500">
                                    No facts stored in memory yet.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
