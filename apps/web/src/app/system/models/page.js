import { Cpu, CheckCircle, XCircle, MinusCircle } from 'lucide-react';
import { getModels } from '../../actions';
import { formatPrice, priceLines, timeAgo, smokeStyle } from '@/lib/models';

export const dynamic = 'force-dynamic';

const SMOKE_ICONS = { ok: CheckCircle, fail: XCircle, skip: MinusCircle };

/** Read-only: which model id each role runs on, what it costs, how it last did. */
export default async function ModelsPage() {
    const data = await getModels();
    const roles = data.roles || [];
    const smoke = data.smoke;

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <h1 className="text-2xl font-bold flex items-center gap-3">
                    <Cpu className="h-6 w-6 text-indigo-400" />
                    Models
                </h1>
                <p className="text-xs text-zinc-500">
                    {smoke
                        ? `Last smoke check ${timeAgo(smoke.at)} — ${smoke.ok} ok, ${smoke.failed} failed, ${smoke.skipped} skipped`
                        : 'The smoke check has not run here yet.'}
                </p>
            </div>

            {data.error && (
                <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                    Could not read the model list. {data.error}
                </div>
            )}

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                <div className="overflow-x-auto scrollbar-hide">
                    <table className="w-full text-sm text-left min-w-[780px]">
                        <thead className="bg-zinc-950 text-zinc-500 uppercase text-xs">
                            <tr>
                                <th className="px-4 py-3">Role</th>
                                <th className="px-4 py-3">Model id</th>
                                <th className="px-4 py-3">Set by</th>
                                <th className="px-4 py-3 text-right">In $/M</th>
                                <th className="px-4 py-3 text-right">Cached in $/M</th>
                                <th className="px-4 py-3 text-right">Out $/M</th>
                                <th className="px-4 py-3">Last smoke</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800">
                            {roles.map(role => {
                                const lines = priceLines(role.price);
                                const Icon = SMOKE_ICONS[role.smoke?.status] || MinusCircle;
                                return (
                                    <tr key={role.role} className="hover:bg-zinc-800/50 transition-colors align-top">
                                        <td className="px-4 py-4 font-medium text-zinc-300">{role.role}</td>
                                        <td className="px-4 py-4">
                                            <code className="text-xs bg-black px-1.5 py-0.5 rounded text-amber-500/90 border border-zinc-800">{role.model}</code>
                                            {lines.some(l => l.outputText !== null) && (
                                                <div className="text-[11px] text-zinc-600 mt-1">
                                                    text output {formatPrice(lines[0].outputText)}
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-4 py-4 text-zinc-500 text-xs">
                                            {role.source === 'env'
                                                ? <span title={`${role.envVar} is set`}>{role.envVar}</span>
                                                : <span title={`default; ${role.envVar} would override it`}>default</span>}
                                        </td>
                                        {['input', 'cachedInput', 'output'].map(field => (
                                            <td key={field} className="px-4 py-4 text-right font-mono text-xs text-zinc-400 whitespace-nowrap">
                                                {lines.map((line, i) => (
                                                    <div key={i}>
                                                        {line.label && <span className="text-zinc-600 mr-1.5">{line.label}</span>}
                                                        {role.exactPrice ? '' : '~'}{formatPrice(line[field])}
                                                    </div>
                                                ))}
                                            </td>
                                        ))}
                                        <td className="px-4 py-4">
                                            {role.smoke ? (
                                                <div className="space-y-1">
                                                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold uppercase border ${smokeStyle(role.smoke.status)}`}>
                                                        <Icon className="w-3 h-3" />
                                                        {role.smoke.status}
                                                    </span>
                                                    {role.smoke.ms !== null && <div className="text-[11px] text-zinc-600">{role.smoke.ms} ms</div>}
                                                    {role.smoke.error && <div className="text-[11px] text-red-400/80 max-w-xs break-words">{role.smoke.error}</div>}
                                                </div>
                                            ) : (
                                                <span className="text-xs text-zinc-600">not checked</span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                            {roles.length === 0 && (
                                <tr><td colSpan={7} className="px-4 py-8 text-center text-zinc-500">No model roles came back from the agent.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            <p className="text-xs text-zinc-500">
                Prices are dollars per million tokens. A tilde means the id has no row of its own and the
                price comes from the name heuristic. Cached input is a tenth of the input rate. Run the
                smoke check in the agent container with <code className="text-zinc-400">node scripts/model-smoke.js</code>;
                it writes the result this page reads. See <code className="text-zinc-400">docs/models.md</code>.
            </p>
        </div>
    );
}
