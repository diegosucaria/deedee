'use client';

import { useState, useEffect } from 'react';
import { LatencyChart, TokenEfficiencyChart, DailyCostChart, ServiceCostBreakdown, StackedDailyCostChart, ModelCostBreakdown } from '@/components/InteractiveCharts';
import { RefreshCw, Activity, Cpu, DollarSign, Database, PieChart, Server } from 'lucide-react';
import { getStatsLatency, getStatsUsage, getStatsCostTrend, getDailyCostTrend, getSystemStats, getCostByTag, getDailyCostByCategory, getCostByModel } from '../../actions';
import { useSocket } from '@/hooks/useSocket';

const COST_PERIODS = [
    { label: 'Today', days: 1 },
    { label: '7d', days: 7 },
    { label: '30d', days: 30 },
];

export default function StatsClient({ startDate, endDate }) {
    const [latencyData, setLatencyData] = useState([]);
    const [tokenTrendData, setTokenTrendData] = useState([]);
    const [dailyCostData, setDailyCostData] = useState([]);
    const [dailyCostByCategory, setDailyCostByCategory] = useState([]);
    const [usageData, setUsageData] = useState(null);
    const [dbStats, setDbStats] = useState(null);
    const [costByTag, setCostByTag] = useState(null);
    const [costByModel, setCostByModel] = useState([]);
    const [costPeriod, setCostPeriod] = useState(1); // days
    const [loading, setLoading] = useState(true);

    // Build query string from date range
    const buildQs = (extraParams = {}) => {
        const params = new URLSearchParams();
        if (startDate) params.append('start', startDate);
        if (endDate) params.append('end', endDate);
        Object.entries(extraParams).forEach(([k, v]) => params.append(k, v));
        return params.toString() ? `?${params.toString()}` : '';
    };

    const fetchData = async () => {
        setLoading(true);
        try {
            const qs = buildQs();

            // Fetch Latency
            const latData = await getStatsLatency(qs);

            // Group and Map latency data
            const mapped = latData.map(item => {
                let meta = {};
                try { meta = JSON.parse(item.metadata); } catch (e) { }

                return {
                    timestamp: item.timestamp,
                    value: item.value,
                    type: item.type,
                    runId: meta.runId
                };
            });

            const requests = {};
            mapped.forEach(m => {
                const key = m.runId || m.timestamp;
                if (!requests[key]) requests[key] = { timestamp: new Date(m.timestamp).getTime(), e2e: 0, model: 0, router: 0, tokens: 0 };

                if (m.type === 'latency_e2e') requests[key].e2e = m.value;
                if (m.type === 'latency_model') requests[key].model = m.value;
                if (m.type === 'latency_router') requests[key].router = m.value;
            });

            const chartData = Object.values(requests)
                .sort((a, b) => a.timestamp - b.timestamp)
                .slice(-50);

            setLatencyData(chartData);

            // Fetch Token Trend (Cost & Tokens)
            const trend = await getStatsCostTrend(qs);
            const mappedTrend = trend.map(t => ({
                timestamp: new Date(t.timestamp).getTime(),
                estimated_cost: t.estimated_cost,
                tokens: t.total_tokens
            })).sort((a, b) => a.timestamp - b.timestamp);

            setTokenTrendData(mappedTrend);

            // Fetch Daily Cost Trend
            const dailyCost = await getDailyCostTrend(qs);
            setDailyCostData(dailyCost);

            // Fetch Daily Cost by Category (uses date range)
            const dailyCatData = await getDailyCostByCategory(qs);
            setDailyCostByCategory(dailyCatData);

            // Fetch Usage
            const usageJson = await getStatsUsage(qs);
            setUsageData(usageJson);

            // Fetch System/DB Stats
            const sysStats = await getSystemStats(qs);
            setDbStats(sysStats);

        } catch (e) {
            console.error('[StatsClient] Fetch Error:', e);
        } finally {
            setLoading(false);
        }
    };

    // Fetch cost breakdown separately so period toggle doesn't re-fetch everything
    const fetchCostBreakdown = async (days) => {
        try {
            // If a global date range is set, use that instead of the days toggle
            const qs = (startDate || endDate)
                ? buildQs()
                : buildQs({ days });
            const [tagData, modelData] = await Promise.all([
                getCostByTag(qs),
                getCostByModel(qs)
            ]);
            setCostByTag(tagData);
            setCostByModel(modelData);
        } catch (e) {
            console.error('[StatsClient] CostBreakdown Error:', e);
        }
    };

    useEffect(() => {
        fetchData();
        fetchCostBreakdown(costPeriod);
        const interval = setInterval(() => {
            fetchData();
            fetchCostBreakdown(costPeriod);
        }, 60000);

        return () => clearInterval(interval);
    }, [startDate, endDate, costPeriod]);

    // Listen for real-time RAG updates via shared socket
    const { socket: statsSocket } = useSocket();
    useEffect(() => {
        if (!statsSocket) return;
        const handler = (newStats) => {
            console.log('[StatsClient] Received RAG stats update via socket');
            if (newStats) {
                setDbStats(prev => ({ ...prev, rag: newStats }));
            }
        };
        statsSocket.on('rag:stats', handler);
        return () => statsSocket.off('rag:stats', handler);
    }, [statsSocket]);

    // Fetch cost breakdown immediately when period changes (for responsive toggle)
    useEffect(() => {
        fetchCostBreakdown(costPeriod);
    }, [costPeriod]);

    if (loading && !latencyData.length) return <div className="p-4 text-zinc-500 animate-pulse">Loading stats...</div>;

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Cost Breakdown by Service — Full Width, Top */}
            <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-xl p-6 min-h-[300px] flex flex-col">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-semibold flex items-center gap-2 text-zinc-300">
                        <PieChart className="w-5 h-5 text-indigo-400" />
                        Cost Breakdown by Service
                    </h2>
                    <div className="flex items-center gap-2">
                        {/* Period Toggle — hidden when a global date range is set */}
                        {!startDate && !endDate && (
                            <div className="flex bg-zinc-800 rounded-lg p-0.5">
                                {COST_PERIODS.map(p => (
                                    <button
                                        key={p.days}
                                        onClick={() => setCostPeriod(p.days)}
                                        className={`px-3 py-1 text-xs rounded-md transition-colors ${
                                            costPeriod === p.days
                                                ? 'bg-indigo-500 text-white'
                                                : 'text-zinc-400 hover:text-zinc-200'
                                        }`}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                        )}
                        {/* Total Cost Badge */}
                        {costByTag?.total?.cost > 0 && (
                            <span className="text-sm font-mono text-red-400 bg-red-500/10 px-2.5 py-1 rounded-lg border border-red-500/20">
                                ${costByTag.total.cost.toFixed(4)}
                            </span>
                        )}
                    </div>
                </div>
                <div className="flex-1 min-h-[280px]">
                    <ServiceCostBreakdown data={costByTag} />
                </div>
            </div>

            {/* Cost by Model */}
            <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-xl p-6 flex flex-col">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-semibold flex items-center gap-2 text-zinc-300">
                        <Server className="w-5 h-5 text-emerald-400" />
                        Cost by Model
                    </h2>
                    <span className="text-xs text-zinc-500">
                        {COST_PERIODS.find(p => p.days === costPeriod)?.label || 'Today'}
                    </span>
                </div>
                <ModelCostBreakdown data={costByModel} />
            </div>

            {/* Stacked Daily Cost Chart — Full Width */}
            <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-xl p-6 min-h-[300px] flex flex-col">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-semibold flex items-center gap-2 text-zinc-300">
                        <DollarSign className="w-5 h-5 text-red-400" />
                        Daily Cost Trend
                    </h2>
                </div>
                <div className="w-full h-[300px]">
                    {dailyCostByCategory.length > 0
                        ? <StackedDailyCostChart data={dailyCostByCategory} />
                        : <DailyCostChart data={dailyCostData} />
                    }
                </div>
            </div>

            {/* Latency Chart */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 min-h-[300px] flex flex-col">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-semibold flex items-center gap-2 text-zinc-300">
                        <Activity className="w-5 h-5 text-indigo-400" />
                        System Latency (ms)
                    </h2>
                </div>
                <div className="w-full h-[300px]">
                    <LatencyChart data={latencyData} />
                </div>
            </div>

            {/* Token Efficiency Chart */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 min-h-[300px] flex flex-col">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-semibold flex items-center gap-2 text-zinc-300">
                        <Cpu className="w-5 h-5 text-amber-400" />
                        Token Efficiency (Tokens/Msg)
                    </h2>
                </div>
                <div className="w-full h-[300px]">
                    <TokenEfficiencyChart data={tokenTrendData} />
                </div>
            </div>

            {/* Database Stats */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 min-h-[300px] flex flex-col">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-semibold flex items-center gap-2 text-zinc-300">
                        <Database className="w-5 h-5 text-purple-400" />
                        Agent Database
                    </h2>
                </div>
                <div className="space-y-4 flex-1">
                    <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-between">
                        <div>
                            <p className="text-sm text-zinc-500 mb-1">Storage Size</p>
                            <p className="text-2xl font-bold text-zinc-200">
                                {(dbStats?.sizeBytes ? (dbStats.sizeBytes / 1024 / 1024).toFixed(2) : '0.00')} MB
                            </p>
                        </div>
                        <div className="h-10 w-10 rounded-full bg-purple-500/10 flex items-center justify-center">
                            <Database className="h-5 w-5 text-purple-400" />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
                            <p className="text-xs text-zinc-500">Messages</p>
                            <p className="text-lg font-mono text-zinc-300">{dbStats?.counts?.messages?.toLocaleString() || 0}</p>
                        </div>
                        <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
                            <p className="text-xs text-zinc-500">Sessions</p>
                            <p className="text-lg font-mono text-zinc-300">{dbStats?.counts?.chat_sessions?.toLocaleString() || 0}</p>
                        </div>
                        <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
                            <p className="text-xs text-zinc-500">People</p>
                            <p className="text-lg font-mono text-zinc-300">{dbStats?.counts?.people?.toLocaleString() || 0}</p>
                        </div>
                        <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
                            <p className="text-xs text-zinc-500">Goals</p>
                            <p className="text-lg font-mono text-zinc-300">{dbStats?.counts?.goals?.toLocaleString() || 0}</p>
                        </div>
                        <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
                            <p className="text-xs text-zinc-500">Scheduled Jobs</p>
                            <p className="text-lg font-mono text-zinc-300">{dbStats?.counts?.scheduled_jobs?.toLocaleString() || 0}</p>
                        </div>
                        <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
                            <p className="text-xs text-zinc-500">Memories (KV)</p>
                            <p className="text-lg font-mono text-zinc-300">{dbStats?.counts?.kv_store?.toLocaleString() || 0}</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* RAG Stats */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 min-h-[300px] flex flex-col">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-semibold flex items-center gap-2 text-zinc-300">
                        <Database className="w-5 h-5 text-cyan-400" />
                        Local RAG Index (Vaults)
                    </h2>
                </div>
                <div className="space-y-4 flex-1">
                    <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-between">
                        <div>
                            <p className="text-sm text-zinc-500 mb-1">Index Size</p>
                            <p className="text-2xl font-bold text-zinc-200">
                                {(dbStats?.rag?.sizeBytes ? (dbStats.rag.sizeBytes / 1024 / 1024).toFixed(2) : '0.00')} MB
                            </p>
                        </div>
                        <div className="h-10 w-10 rounded-full bg-cyan-500/10 flex items-center justify-center">
                            <Database className="h-5 w-5 text-cyan-400" />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
                            <p className="text-xs text-zinc-500">Total Documents</p>
                            <p className="text-lg font-mono text-zinc-300">{dbStats?.rag?.documents?.toLocaleString() || 0}</p>
                        </div>
                        <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
                            <p className="text-xs text-zinc-500">Total Chunks</p>
                            <p className="text-lg font-mono text-zinc-300">{dbStats?.rag?.chunks?.toLocaleString() || 0}</p>
                        </div>
                    </div>
                    {dbStats?.rag?.contentTypes && Object.keys(dbStats.rag.contentTypes).length > 0 && (
                        <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
                            <p className="text-xs text-zinc-500 mb-2">Content Types</p>
                            <div className="flex flex-wrap gap-2">
                                {Object.entries(dbStats.rag.contentTypes).map(([type, count]) => (
                                    <span key={type} className="px-2 py-1 bg-emerald-500/10 text-emerald-400 text-xs rounded border border-emerald-500/20">
                                        {type}: {count}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                    {dbStats?.rag?.vaults && Object.keys(dbStats.rag.vaults).length > 0 && (
                        <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
                            <p className="text-xs text-zinc-500 mb-2">Vault Distribution</p>
                            <div className="flex flex-wrap gap-2">
                                {Object.entries(dbStats.rag.vaults).map(([vault, count]) => (
                                    <span key={vault} className="px-2 py-1 bg-cyan-500/10 text-cyan-400 text-xs rounded border border-cyan-500/20">
                                        {vault}: {count}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Detailed Token Usage */}
            {usageData?.today && (
                <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-2 text-zinc-300">
                        <Cpu className="w-5 h-5 text-emerald-400" />
                        Token Consumption {startDate ? '(Range)' : '(Today)'}
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800">
                            <p className="text-sm text-zinc-500 mb-1">Total Tokens</p>
                            <p className="text-2xl font-bold text-zinc-200">{usageData.today.total?.toLocaleString() || 0}</p>
                        </div>
                        <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800">
                            <p className="text-sm text-zinc-500 mb-1">Prompt Tokens (Input)</p>
                            <p className="text-2xl font-bold text-sky-400">{usageData.today.prompt?.toLocaleString() || 0}</p>
                        </div>
                        <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800">
                            <p className="text-sm text-zinc-500 mb-1">Candidate Tokens (Output)</p>
                            <p className="text-2xl font-bold text-indigo-400">{usageData.today.candidate?.toLocaleString() || 0}</p>
                        </div>
                        <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800 col-span-1 md:col-span-3">
                            <p className="text-sm text-zinc-500 mb-1">{startDate ? 'Total Cost' : "Today's Cost"}</p>
                            <p className="text-2xl font-bold text-red-400">${usageData.today.cost ? Number(usageData.today.cost).toFixed(4) : '0.0000'}</p>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
