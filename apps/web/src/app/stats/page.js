import CleanupButton from '@/components/CleanupButton';
import DateIntervalSelector from '@/components/DateIntervalSelector';
import StatsClient from './StatsClient';
import { fetchAPI } from '@/lib/api';
import { Activity, MessageSquare, Zap, Brain, CheckCircle, BarChart3, Clock } from 'lucide-react';

// Re-alias CleanupButton if it was named CleanMetricsButton in usage, or import correct one.
// Based on usage <CleanMetricsButton />, but import is CleanupButton.
const CleanMetricsButton = CleanupButton;
export default async function StatsPage({ searchParams }) {
    const params = new URLSearchParams(searchParams);
    const queryString = params.toString() ? `?${params.toString()}` : '';

    let stats = null;
    try {
        stats = await fetchAPI(`/v1/stats${queryString}`);
    } catch (err) {
        console.error('Stats fetch error:', err);
        return <div className="p-8 text-red-500">Error loading stats. ({err.message})</div>;
    }

    if (!stats) return <div className="p-8">Loading...</div>;

    const { messages, goals, jobs, journal, latency, efficiency } = stats;

    return (
        <div className="p-8 max-w-6xl mx-auto space-y-8">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
                <h1 className="text-3xl font-bold flex items-center gap-3">
                    <Activity className="h-8 w-8 text-indigo-400" />
                    System Health & Stats
                </h1>
                <div className="flex items-center gap-4">
                    <DateIntervalSelector />
                    <CleanMetricsButton />
                </div>
            </div>

            {/* Top Row: KPIs */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <StatCard
                    title="Total Messages"
                    value={messages.total?.toLocaleString()}
                    icon={MessageSquare}
                    color="text-blue-400"
                    bg="bg-blue-400/10 border-blue-400/20"
                />
                <StatCard
                    title={params.get('start') ? "Avg Response (Range)" : "Avg Response (24h)"}
                    value={latency?.avg24h ? `${latency.avg24h}ms` : '-'}
                    icon={Zap}
                    color="text-yellow-400"
                    bg="bg-yellow-400/10 border-yellow-400/20"
                />
                <StatCard
                    title="Context Efficiency"
                    value={stats.smartContext?.estimatedTokensSaved ? `~${(stats.smartContext.estimatedTokensSaved / 1000).toFixed(1)}k Saved` : '-'}
                    icon={Brain}
                    color="text-purple-400"
                    bg="bg-purple-400/10 border-purple-400/20"
                />
                <StatCard
                    title={params.get('start') ? "Journal (Range)" : "Journal (7 Days)"}
                    value={journal?.last7DaysEntries || 0}
                    icon={CheckCircle}
                    color="text-emerald-400"
                    bg="bg-emerald-400/10 border-emerald-400/20"
                />
            </div>

            {/* Middle Row: Charts */}
            <StatsClient startDate={searchParams?.start} endDate={searchParams?.end} />

            {/* Bottom Row: Details */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Role Distribution */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-2 text-zinc-300">
                        <BarChart3 className="w-5 h-5" />
                        Message Roles
                    </h2>
                    <div className="space-y-4">
                        {Object.entries(messages.byRole).map(([role, count]) => (
                            <div key={role} className="flex items-center gap-4">
                                <div className="w-24 text-sm font-medium text-zinc-400 capitalize">{role}</div>
                                <div className="flex-1 bg-zinc-800 rounded-full h-2 overflow-hidden">
                                    <div
                                        className="h-full bg-indigo-500 rounded-full"
                                        style={{ width: `${(count / messages.total) * 100}%` }}
                                    />
                                </div>
                                <div className="w-12 text-sm text-right text-zinc-300">{count}</div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Goals Status */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-2 text-zinc-300">
                        <CheckCircle className="w-5 h-5" />
                        Goals
                    </h2>
                    <div className="flex items-center justify-around p-4 h-full">
                        <div className="text-center">
                            <div className="text-4xl font-bold text-emerald-400 mb-1">{goals.completed}</div>
                            <div className="text-xs text-zinc-500 uppercase tracking-wider">Done</div>
                        </div>
                        <div className="h-12 w-px bg-zinc-800" />
                        <div className="text-center">
                            <div className="text-4xl font-bold text-purple-400 mb-1">{goals.pending}</div>
                            <div className="text-xs text-zinc-500 uppercase tracking-wider">Pending</div>
                        </div>
                    </div>
                </div>

                {/* Job Breakdown */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-2 text-zinc-300">
                        <Clock className="w-5 h-5" />
                        Active Jobs ({jobs.total})
                    </h2>
                    <div className="flex items-center justify-around p-4 h-full">
                        <div className="text-center">
                            <div className="text-4xl font-bold text-sky-400 mb-1">{jobs.system}</div>
                            <div className="text-xs text-zinc-500 uppercase tracking-wider">System</div>
                        </div>
                        <div className="h-12 w-px bg-zinc-800" />
                        <div className="text-center">
                            <div className="text-4xl font-bold text-indigo-400 mb-1">{jobs.recurring}</div>
                            <div className="text-xs text-zinc-500 uppercase tracking-wider">Recurring</div>
                        </div>
                        <div className="h-12 w-px bg-zinc-800" />
                        <div className="text-center">
                            <div className="text-4xl font-bold text-amber-400 mb-1">{jobs.oneOff}</div>
                            <div className="text-xs text-zinc-500 uppercase tracking-wider">One-Off</div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Active Jobs Table and Job Logs Table have been moved to /tasks */}
        </div>
    );
}

function StatCard({ title, value, icon: Icon, color, bg }) {
    return (
        <div className={`p-6 rounded-xl border ${bg} flex items-center gap-4`}>
            <div className={`p-3 rounded-lg bg-zinc-950 ${color}`}>
                <Icon className="w-6 h-6" />
            </div>
            <div>
                <p className="text-sm text-zinc-400 font-medium">{title}</p>
                <p className={`text-2xl font-bold ${color}`}>{value}</p>
            </div>
        </div>
    );
}
