'use client';

import { useState, useEffect } from 'react';
import { LatencyChart, TokenEfficiencyChart, CostChart } from '@/components/InteractiveCharts';
import { RefreshCw, Activity, Cpu, DollarSign } from 'lucide-react';
import { getStatsLatency, getStatsUsage, getStatsCostTrend } from '../actions';

export default function StatsClient() {
    const [latencyData, setLatencyData] = useState([]);
    const [tokenTrendData, setTokenTrendData] = useState([]);
    const [usageData, setUsageData] = useState(null);
    const [loading, setLoading] = useState(true);

    const fetchData = async () => {
        setLoading(true);
        try {
            // Fetch Latency
            const latData = await getStatsLatency();

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
                if (!requests[key]) requests[key] = { timestamp: m.timestamp, e2e: 0, model: 0, router: 0, tokens: 0 };

                if (m.type === 'latency_e2e') requests[key].e2e = m.value;
                if (m.type === 'latency_model') requests[key].model = m.value;
                if (m.type === 'latency_router') requests[key].router = m.value;
            });

            const chartData = Object.values(requests)
                .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
                .slice(-50); // Last 50

            setLatencyData(chartData);

            // Fetch Token Trend (Cost & Tokens)
            const trend = await getStatsCostTrend();
            // Process trend for charts.
            // DB returns: { timestamp, estimated_cost, total_tokens, model }
            const mappedTrend = trend.map(t => ({
                timestamp: t.timestamp,
                estimated_cost: t.estimated_cost,
                tokens: t.total_tokens
            })).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

            setTokenTrendData(mappedTrend);

            // Fetch Usage
            const usageJson = await getStatsUsage();
            setUsageData(usageJson);

        } catch (e) {
            console.error('[StatsClient] Fetch Error:', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 10000);
        return () => clearInterval(interval);
    }, []);

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
                <div className="flex-1 w-full min-h-[200px]">
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
                <div className="flex-1 w-full min-h-[200px]">
                    <TokenEfficiencyChart data={tokenTrendData} />
                </div>
            </div>

            {/* Cost Chart */}
            <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-xl p-6 min-h-[300px] flex flex-col">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-semibold flex items-center gap-2 text-zinc-300">
                        <DollarSign className="w-5 h-5 text-red-400" />
                        Query Cost
                    </h2>
                </div>
                <div className="flex-1 w-full min-h-[200px]">
                    <CostChart data={tokenTrendData} />
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
                    </div>
                </div>
            )}
        </div>
    );
}
