'use client';

import { useState, useEffect } from 'react';
import { LatencyChart, TokenEfficiencyChart, DailyCostChart } from '@/components/InteractiveCharts';
import { RefreshCw, Activity, Cpu, DollarSign, Database } from 'lucide-react';
import { getStatsLatency, getStatsUsage, getStatsCostTrend, getDailyCostTrend, getSystemStats } from '../../actions';

export default function StatsClient({ startDate, endDate }) {
    const [latencyData, setLatencyData] = useState([]);
    const [tokenTrendData, setTokenTrendData] = useState([]);
    const [dailyCostData, setDailyCostData] = useState([]);
    const [usageData, setUsageData] = useState(null);
    const [dbStats, setDbStats] = useState(null);
    const [loading, setLoading] = useState(true);

    const fetchData = async () => {
        setLoading(true);
        try {
            // Build query params
            const params = new URLSearchParams();
            if (startDate) params.append('start', startDate);
            if (endDate) params.append('end', endDate);
            const qs = params.toString() ? `?${params.toString()}` : '';

            // Fetch Latency
            const latData = await getStatsLatency(qs);

            // Group and Map latency data
            // Group by Metadata.runId OR ChatId OR Timestamp (proximity)
            // Ideally we want to see trends.
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

            // Grouping logic (simplified: just list E2E points for now, or group by runId?)
            // If we just show lines over time, we need consistent X-Axis.
            // Let's rely on E2E events as the primary "Request" anchors.

            // NOTE: For a perfect stacked/line chart we need to join rows.
            // For now let's just format it such that 'e2e' is the main line.
            // A truly accurate graph needs data reshaping on the backend or here.
            // Simplified approach: Filter for e2e only? No, use raw points.

            // Better Approach:
            // Create a list of "Requests".
            const requests = {};
            mapped.forEach(m => {
                // If we have runId, use it. Else use timestamp grouping (1s window?)
                const key = m.runId || m.timestamp;
                if (!requests[key]) requests[key] = { timestamp: new Date(m.timestamp).getTime(), e2e: 0, model: 0, router: 0, tokens: 0 };

                if (m.type === 'latency_e2e') requests[key].e2e = m.value;
                if (m.type === 'latency_model') requests[key].model = m.value;
                if (m.type === 'latency_router') requests[key].router = m.value;
            });

            const chartData = Object.values(requests)
                .sort((a, b) => a.timestamp - b.timestamp)
                .slice(-50); // Last 50

            setLatencyData(chartData);

            // Fetch Token Trend (Cost & Tokens)
            const trend = await getStatsCostTrend(qs);
            // Process trend for charts.
            // DB returns: { timestamp, estimated_cost, total_tokens, model }
            const mappedTrend = trend.map(t => ({
                timestamp: new Date(t.timestamp).getTime(),
                estimated_cost: t.estimated_cost,
                tokens: t.total_tokens
            })).sort((a, b) => a.timestamp - b.timestamp);

            setTokenTrendData(mappedTrend);

            // Fetch Daily Cost Trend
            const dailyCost = await getDailyCostTrend();
            setDailyCostData(dailyCost);

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

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 10000);

        // Listen for real-time RAG updates
        // We probably need to connect to the Interfaces socket
        // Assuming we can import io or use a global if provided?
        // Let's create a temporary socket just for this page if needed, or use polling as fallback.
        // User rule says "YOU MUST implement a socket event".
        try {
            const { io } = require('socket.io-client');
            const socket = io(); // Connects to same origin (API proxy -> Interfaces?)
            // Wait, Web is Next.js (port 3000), Interfaces is 5000 (proxied via /api/socket ? No.
            // Client usually connects to the Interfaces URL.
            // Env var? NEXT_PUBLIC_API_URL?
            // "apps/web/src/app/chat/[id]/page.js" uses socket.

            socket.on('rag:stats', (newStats) => {
                console.log('[StatsClient] Received RAG stats update via socket');
                if (newStats) {
                    setDbStats(prev => ({
                        ...prev,
                        rag: newStats
                    }));
                } else {
                    fetchData(); // Full refresh if payload empty
                }
            });

            return () => {
                clearInterval(interval);
                socket.disconnect();
            };
        } catch (e) {
            console.error('[StatsClient] Socket setup failed:', e);
            return () => clearInterval(interval);
        }
    }, [startDate, endDate]);

    if (loading && !latencyData.length) return <div className="p-4 text-zinc-500 animate-pulse">Loading stats...</div>;

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
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

            {/* Cost Chart */}
            <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-xl p-6 min-h-[300px] flex flex-col">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-semibold flex items-center gap-2 text-zinc-300">
                        <DollarSign className="w-5 h-5 text-red-400" />
                        Daily Cost Trend
                    </h2>
                </div>
                <div className="w-full h-[300px]">
                    <DailyCostChart data={dailyCostData} />
                </div>
            </div>

            {/* Detailed Token Usage */}
            {usageData?.today && (
                <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-2 text-zinc-300">
                        <Cpu className="w-5 h-5 text-emerald-400" />
                        Token Consumption (Today)
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
                            <p className="text-sm text-zinc-500 mb-1">Today's Cost</p>
                            <p className="text-2xl font-bold text-red-400">${usageData.today.cost ? Number(usageData.today.cost).toFixed(4) : '0.0000'}</p>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
