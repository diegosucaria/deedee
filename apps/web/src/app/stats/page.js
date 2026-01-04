export const dynamic = 'force-dynamic';
import { fetchAPI } from '@/lib/api';
import { BarChart3, MessageSquare, Brain, Clock, Zap, CheckCircle, Activity } from 'lucide-react';
import StatsClient from './StatsClient';

export default async function StatsPage() {
    let stats = null;
    try {
        stats = await fetchAPI('/v1/stats');
    } catch (err) {
        console.error('Stats fetch error:', err);
        return <div className="p-8 text-red-500">Error loading stats. ({err.message})</div>;
    }

    if (!stats) return <div className="p-8">Loading...</div>;

    const { messages, goals, jobs } = stats;

    return (
        <div className="p-8 max-w-6xl mx-auto space-y-8">
            <h1 className="text-3xl font-bold mb-8 flex items-center gap-3">
                <Activity className="h-8 w-8 text-indigo-400" />
                System Health & Stats
            </h1>

            {/* Key Metrics Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <StatCard
                    title="Total Messages"
                    value={messages.total}
                    icon={MessageSquare}
                    color="text-blue-400"
                    bg="bg-blue-400/10 border-blue-400/20"
                />
                <StatCard
                    title="Active in Last 24h"
                    value={messages.last24h}
                    icon={Zap}
                    color="text-yellow-400"
                    bg="bg-yellow-400/10 border-yellow-400/20"
                />
                <StatCard
                    title="Pending Goals"
                    value={goals.pending}
                    icon={Brain}
                    color="text-purple-400"
                    bg="bg-purple-400/10 border-purple-400/20"
                />
                <StatCard
                    title="Scheduled Jobs"
                    value={jobs.active}
                    icon={Clock}
                    color="text-emerald-400"
                    bg="bg-emerald-400/10 border-emerald-400/20"
                />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Role Distribution */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-2 text-zinc-300">
                        <BarChart3 className="w-5 h-5" />
                        Message Distribution
                    </h2>
                    <div className="space-y-4">
                        {Object.entries(messages.byRole).map(([role, count]) => (
                            <div key={role} className="flex items-center gap-4">
                                <div className="w-24 text-sm font-medium text-zinc-400 capitalize">{role}</div>
                                <div className="flex-1 bg-zinc-800 rounded-full h-4 overflow-hidden">
                                    <div
                                        className="h-full bg-indigo-500 rounded-full transition-all duration-500"
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
                        Goal Completion
                    </h2>
                    <div className="flex items-center justify-center p-8">
                        <div className="text-center">
                            <div className="text-5xl font-bold text-emerald-400 mb-2">{goals.completed}</div>
                            <div className="text-zinc-500">Goals Completed</div>
                        </div>
                        <div className="h-16 w-px bg-zinc-800 mx-8" />
                        <div className="text-center">
                            <div className="text-5xl font-bold text-purple-400 mb-2">{goals.pending}</div>
                            <div className="text-zinc-500">Goals Pending</div>
                        </div>
                    </div>
                </div>
            </div>
            {/* Real-time Charts */}
            <StatsClient />
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
