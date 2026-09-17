'use client';

import { useState, useEffect, useMemo } from 'react';
import { BarChart3, Bot, Gauge, DollarSign, Zap, AlertTriangle, MessageSquareWarning, Wrench, Droplets, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import { GuardianOutcomesChart } from '@/components/InteractiveCharts';
import { getGuardianStats } from '@/app/actions';
import {
    OUTCOME_GROUPS, RANGE_PRESETS, rangeFor, outcomesPerDay, outcomeGroupTotals, formatPercent, formatMs, formatCost,
} from '@/lib/guardian';

function StatCard({ title, value, sub, icon: Icon, color, bg }) {
    return (
        <div className={`p-5 rounded-xl border ${bg} flex items-center gap-4`}>
            <div className={`p-3 rounded-lg bg-zinc-950 ${color}`}>
                <Icon className="w-5 h-5" />
            </div>
            <div className="min-w-0">
                <p className="text-sm text-zinc-400 font-medium">{title}</p>
                <p className={`text-2xl font-bold ${color}`}>{value}</p>
                {sub && <p className="text-xs text-zinc-500 truncate">{sub}</p>}
            </div>
        </div>
    );
}

function Panel({ title, icon: Icon, iconColor, right, children, className }) {
    return (
        <div className={clsx('bg-zinc-900 border border-zinc-800 rounded-xl p-6 flex flex-col', className)}>
            <div className="flex items-center justify-between mb-4 gap-2">
                <h2 className="text-xl font-semibold flex items-center gap-2 text-zinc-300">
                    <Icon className={`w-5 h-5 ${iconColor}`} />
                    {title}
                </h2>
                {right}
            </div>
            {children}
        </div>
    );
}

function BarList({ items, empty }) {
    if (!items || items.length === 0) return <div className="py-8 text-center text-zinc-600">{empty}</div>;
    const max = Math.max(...items.map(i => i.count), 1);
    return (
        <div className="space-y-3">
            {items.map(item => (
                <div key={item.name} className="flex items-center gap-3">
                    <div className="w-40 md:w-56 text-xs font-mono text-zinc-400 truncate" title={item.name}>{item.name}</div>
                    <div className="flex-1 bg-zinc-800 rounded-full h-2 overflow-hidden">
                        <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${(item.count / max) * 100}%` }} />
                    </div>
                    <div className="w-10 text-sm text-right text-zinc-300 font-mono">{item.count}</div>
                </div>
            ))}
        </div>
    );
}

/** Stats: outcomes per day, rates, feedback, top tools and sources, cost, latency, breaker trips. */
export default function GuardianStats() {
    const [preset, setPreset] = useState('30d');
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const range = useMemo(() => rangeFor(preset), [preset]);

    const load = async () => {
        setLoading(true);
        try {
            setStats(await getGuardianStats(range));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { load(); }, [range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps

    const chartData = useMemo(() => outcomesPerDay(stats?.perDay, range), [stats, range]);
    const totals = useMemo(() => outcomeGroupTotals(stats?.outcomes), [stats]);

    const rangeToggle = (
        <div className="flex items-center gap-2">
            <div className="flex bg-zinc-800 rounded-lg p-0.5">
                {RANGE_PRESETS.map(p => (
                    <button
                        key={p.id}
                        onClick={() => setPreset(p.id)}
                        className={`px-3 py-1 text-xs rounded-md transition-colors ${preset === p.id ? 'bg-indigo-500 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
                    >
                        {p.label}
                    </button>
                ))}
            </div>
            <button onClick={load} className="p-1.5 text-zinc-500 hover:text-white" title="Refresh">
                <RefreshCw className={clsx('h-4 w-4', loading && 'animate-spin')} />
            </button>
        </div>
    );

    if (!stats && loading) return <div className="p-4 text-zinc-500 animate-pulse">Loading stats...</div>;
    if (stats?.error) {
        return (
            <div className="space-y-4">
                <div className="flex justify-end">{rangeToggle}</div>
                <p className="text-sm text-red-400">Guardian stats unavailable: {stats.error}</p>
            </div>
        );
    }

    const s = stats || {};
    const fb = s.feedback || {};
    const guardianCost = s.tokenUsage?.calls > 0 ? s.tokenUsage.cost : s.cost;
    const share = s.escalationApprovalShare;

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <p className="text-sm text-zinc-400">{range.from} to {range.to}</p>
                {rangeToggle}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <StatCard title="Gated calls" value={(s.total || 0).toLocaleString()} sub={`${s.autoDecisions || 0} decided by the guardian`}
                    icon={BarChart3} color="text-blue-400" bg="bg-blue-400/10 border-blue-400/20" />
                <StatCard title="Auto-decision rate" value={formatPercent(s.autoRate)} sub="allowed or denied without you"
                    icon={Bot} color="text-indigo-400" bg="bg-indigo-400/10 border-indigo-400/20" />
                <StatCard title="Escalations" value={(s.escalations || 0).toLocaleString()}
                    sub={share == null ? 'none decided yet' : `you approved ${formatPercent(share)} (${s.escalationsApproved || 0})`}
                    icon={Gauge} color="text-amber-400" bg="bg-amber-400/10 border-amber-400/20" />
                <StatCard title="Guardian cost" value={formatCost(guardianCost)} sub={`${s.tokenUsage?.calls || 0} model calls (tag guardian)`}
                    icon={DollarSign} color="text-red-400" bg="bg-red-400/10 border-red-400/20" />
                <StatCard title="Median latency" value={formatMs(s.medianLatencyMs)} sub="per guardian call"
                    icon={Zap} color="text-yellow-400" bg="bg-yellow-400/10 border-yellow-400/20" />
                <StatCard title="Breaker trips" value={(s.breakerTrips || 0).toLocaleString()} sub="runs stopped after 3 denials"
                    icon={AlertTriangle} color="text-orange-400" bg="bg-orange-400/10 border-orange-400/20" />
            </div>

            {share != null && share >= 0.8 && (s.escalationsApproved || 0) >= 5 && (
                <p className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-2">
                    You approved most escalations. The policy may be too strict: see Policy.
                </p>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <Panel title="Outcomes per Day" icon={BarChart3} iconColor="text-indigo-400" className="lg:col-span-2 min-h-[360px]">
                    <div className="w-full h-[320px]">
                        <GuardianOutcomesChart data={chartData} groups={OUTCOME_GROUPS} />
                    </div>
                </Panel>
                <Panel title="Totals" icon={BarChart3} iconColor="text-sky-400">
                    <table className="w-full text-sm">
                        <tbody>
                            {totals.map(t => (
                                <tr key={t.key} className="border-b border-zinc-800/50">
                                    <td className="py-2 pr-2 text-zinc-300">
                                        <span className="inline-block h-2.5 w-2.5 rounded-sm mr-2 align-middle" style={{ backgroundColor: t.color }} />
                                        {t.key}
                                    </td>
                                    <td className="py-2 text-right font-mono text-zinc-300">{t.count}</td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot>
                            <tr className="border-t-2 border-zinc-700">
                                <td className="py-2 font-semibold text-zinc-200">Total</td>
                                <td className="py-2 text-right font-mono font-semibold text-zinc-200">{s.total || 0}</td>
                            </tr>
                        </tfoot>
                    </table>
                </Panel>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <Panel title="Your Feedback" icon={MessageSquareWarning} iconColor="text-violet-400">
                    <div className="grid grid-cols-2 gap-3">
                        {[
                            ['Should allow', fb.shouldAllow, 'text-emerald-300'],
                            ['Should deny', fb.shouldDeny, 'text-red-300'],
                            ['Denied, you disagree', fb.deniedButShouldAllow, 'text-emerald-300'],
                            ['Allowed, you disagree', fb.allowedButShouldDeny, 'text-red-300'],
                        ].map(([label, n, tone]) => (
                            <div key={label} className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
                                <p className="text-xs text-zinc-500">{label}</p>
                                <p className={`text-lg font-mono ${tone}`}>{n || 0}</p>
                            </div>
                        ))}
                    </div>
                </Panel>
                <Panel title="Top Gated Tools" icon={Wrench} iconColor="text-amber-400">
                    <BarList items={s.topTools} empty="No gated calls" />
                </Panel>
                <Panel title="Top Taint Sources" icon={Droplets} iconColor="text-cyan-400">
                    <BarList items={s.topTaintSources} empty="No tainted calls" />
                </Panel>
            </div>
        </div>
    );
}
