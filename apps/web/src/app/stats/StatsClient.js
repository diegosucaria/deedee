'use client';

import { useState, useEffect } from 'react';
import { SimpleLineChart } from '@/components/SimpleCharts';
import { RefreshCw, Activity, Cpu } from 'lucide-react';
import { fetchAPI } from '@/lib/api';

export default function StatsClient() {
    const [latencyData, setLatencyData] = useState([]);
    const [usageData, setUsageData] = useState(null);
    const [loading, setLoading] = useState(true);

    const fetchData = async () => {
        setLoading(true);
        try {
            // Fetch Latency
            const latData = await fetchAPI('/v1/stats/latency');

            // Group by Chat ID to align Router/Model/E2E for the same request
            const grouped = {};

            latData.forEach((item, index) => {
                let groupKey = `item-${index}`; // Default to unique if no ID found
                try {
                    const meta = JSON.parse(item.metadata);
                    // PREFER RUN ID
                    if (meta && meta.runId) {
                        groupKey = meta.runId;
                    }
                } catch (e) { }

                if (!grouped[groupKey]) {
                    grouped[groupKey] = {
                        timestamp: item.timestamp,
                        router: 0,
                        model: 0,
                        e2e: 0,
                        label: ''
                    };
                }

                if (item.type === 'latency_router') grouped[groupKey].router = item.value;
                if (item.type === 'latency_model') grouped[groupKey].model = item.value;
                if (item.type === 'latency_e2e') grouped[groupKey].e2e = item.value;
            });

            // Convert to Array & Sort
            const chartData = Object.values(grouped)
                .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
                .slice(-50) // Last 50 requests
                .map((d, i) => ({
                    ...d,
                    label: i + 1 // Simple index label 1..50
                }));

            setLatencyData(chartData);

            // Fetch Usage
            const usageJson = await fetchAPI('/v1/stats/usage');
            setUsageData(usageJson);

        } catch (e) {
            console.error(e);
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
        <div className="space-y-6">
            {/* Latency Chart */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                <div className="flex items-center justify-between mb-6">
                    <h2 className="text-xl font-semibold flex items-center gap-2 text-zinc-300">
                        <Activity className="w-5 h-5 text-indigo-400" />
                        Latency History (Last 100)
                    </h2>
                    <div className="flex gap-4 text-sm">
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full bg-pink-400" />
                            <span className="text-zinc-400">Total (e2e)</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full bg-indigo-400" />
                            <span className="text-zinc-400">Model</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full bg-emerald-400" />
                            <span className="text-zinc-400">Router</span>
                        </div>
                    </div>
                </div>

                <div className="h-64 w-full">
                    <SimpleLineChart
                        data={latencyData}
                        dataKey1="e2e"
                        color1="#f472b6" // Pink
                        dataKey2="model"
                        color2="#818cf8" // Indigo
                        dataKey3="router"
                        color3="#34d399" // Emerald
                    />
                </div>
            </div>

            {/* Token Usage */}
            {usageData && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-2 text-zinc-300">
                        <Cpu className="w-5 h-5 text-amber-400" />
                        Token Usage (Today)
                    </h2>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800">
                            <p className="text-sm text-zinc-500 mb-1">Total Tokens</p>
                            <p className="text-2xl font-bold text-zinc-200">{usageData.totalTokens?.toLocaleString() || 0}</p>
                        </div>
                        <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800">
                            <p className="text-sm text-zinc-500 mb-1">Prompt Tokens</p>
                            <p className="text-2xl font-bold text-sky-400">{usageData.promptTokens?.toLocaleString() || 0}</p>
                        </div>
                        <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800">
                            <p className="text-sm text-zinc-500 mb-1">Response Tokens</p>
                            <p className="text-2xl font-bold text-indigo-400">{usageData.candidateTokens?.toLocaleString() || 0}</p>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
