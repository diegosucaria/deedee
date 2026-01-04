'use client';

import { useState, useEffect } from 'react';
import { SimpleLineChart } from '@/components/SimpleCharts';
import { RefreshCw, Activity, Cpu } from 'lucide-react';
import { API_URL } from '@/lib/api';

export default function StatsClient() {
    const [latencyData, setLatencyData] = useState([]);
    const [usageData, setUsageData] = useState(null);
    const [loading, setLoading] = useState(true);

    const fetchData = async () => {
        setLoading(true);
        try {
            // Fetch Latency
            const latRes = await fetch(`${API_URL}/internal/stats/latency`);
            const latData = await latRes.json();

            // Transform for chart (map timestamp/id to label)
            // Expecting array of { type, value, metadata, timestamp }
            // Filter into buckets if needed or just show last N points

            // Group by Interaction (ChatId) if possible, or just plot raw stream
            // The backend returns a simple array. Let's map it.
            const stats = latData.map((d, i) => ({
                label: i,
                router: d.type === 'latency_router' ? d.value : 0,
                model: d.type === 'latency_model' ? d.value : 0,
                ...d
            }));

            // We need to merge Router/Model for same interaction ideally.
            // For now, let's just show two separate lines on same time axis is hard if strictly sequential.
            // Let's simplified: Filter for model latency only for now as primary metric.
            const modelLatencies = latData
                .filter(d => d.type === 'latency_model')
                .map((d, i) => ({ label: i, value: d.value }));

            const routerLatencies = latData
                .filter(d => d.type === 'latency_router')
                .map((d, i) => ({ label: i, value: d.value }));

            // Merge by index (approx)
            const merged = modelLatencies.map((m, i) => ({
                label: i,
                model: m.value,
                router: routerLatencies[i]?.value || 0
            }));

            setLatencyData(merged);

            // Fetch Usage
            const usageRes = await fetch(`${API_URL}/internal/stats/usage`);
            const usageJson = await usageRes.json();
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
                            <div className="w-3 h-3 rounded-full bg-indigo-400" />
                            <span className="text-zinc-400">Model (ms)</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full bg-emerald-400" />
                            <span className="text-zinc-400">Router (ms)</span>
                        </div>
                    </div>
                </div>

                <div className="h-64 w-full">
                    <SimpleLineChart
                        data={latencyData}
                        dataKey1="model"
                        color1="#818cf8"
                        dataKey2="router"
                        color2="#34d399"
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
