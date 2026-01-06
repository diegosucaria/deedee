'use client';

import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
    BarChart, Bar, AreaChart, Area, ReferenceLine
} from 'recharts';

const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
        return (
            <div className="bg-zinc-900 border border-zinc-700 p-3 rounded shadow-lg text-sm">
                <p className="text-zinc-400 mb-2">{new Date(label).toLocaleTimeString()}</p>
                {payload.map((p, index) => (
                    <p key={index} style={{ color: p.color }} className="font-mono">
                        {p.name}: <span className="font-bold">{p.value}</span>{p.unit}
                    </p>
                ))}
            </div>
        );
    }
    return null;
};

export function LatencyChart({ data }) {
    if (!data || data.length === 0) return <div className="h-full flex items-center justify-center text-zinc-600">No Data</div>;

    return (
        <ResponsiveContainer width="100%" height="100%">
            <LineChart
                data={data}
                margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
                syncId="synced-charts"
            >
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis
                    dataKey="timestamp"
                    stroke="#71717a"
                    fontSize={12}
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={(ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                />
                <YAxis
                    stroke="#71717a"
                    fontSize={12}
                    tickFormatter={(val) => `${Math.round(val)}ms`}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                <ReferenceLine x={Date.now()} stroke="#f472b6" label="Now" strokeDasharray="3 3" />
                <Line
                    type="monotone"
                    dataKey="e2e"
                    name="Total (E2E)"
                    stroke="#f472b6"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                    unit="ms"
                />
                <Line
                    type="monotone"
                    dataKey="model"
                    name="Model"
                    stroke="#818cf8"
                    strokeWidth={2}
                    dot={false}
                    unit="ms"
                />
                <Line
                    type="monotone"
                    dataKey="router"
                    name="Router"
                    stroke="#34d399"
                    strokeWidth={2}
                    dot={false}
                    unit="ms"
                />
            </LineChart>
        </ResponsiveContainer>
    );
}

export function CostChart({ data }) {
    if (!data || data.length === 0) return <div className="h-full flex items-center justify-center text-zinc-600">No Data</div>;

    return (
        <ResponsiveContainer width="100%" height="100%">
            <AreaChart
                data={data}
                margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
                syncId="synced-charts"
            >
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis
                    dataKey="timestamp"
                    stroke="#71717a"
                    fontSize={12}
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={(ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                />
                <YAxis
                    stroke="#71717a"
                    fontSize={12}
                    tickFormatter={(val) => `$${val.toFixed(4)}`}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                <ReferenceLine x={Date.now()} stroke="#ef4444" label="Now" strokeDasharray="3 3" />
                <Area
                    type="monotone"
                    dataKey="estimated_cost"
                    name="Cost ($)"
                    stroke="#ef4444"
                    fill="#ef4444"
                    fillOpacity={0.1}
                    unit=""
                />
            </AreaChart>
        </ResponsiveContainer>
    );
}

export function TokenEfficiencyChart({ data }) {
    if (!data || data.length === 0) return <div className="h-full flex items-center justify-center text-zinc-600">No Data</div>;

    // Aggregate or use raw? Assuming raw trend data of requests
    return (
        <ResponsiveContainer width="100%" height="100%">
            <AreaChart
                data={data}
                margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
                syncId="synced-charts"
            >
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis
                    dataKey="timestamp"
                    stroke="#71717a"
                    fontSize={12}
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={(ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                />
                <YAxis
                    stroke="#71717a"
                    fontSize={12}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                <ReferenceLine x={Date.now()} stroke="#fbbf24" label="Now" strokeDasharray="3 3" />
                <Area
                    type="monotone"
                    dataKey="tokens"
                    name="Tokens / Msg"
                    stroke="#fbbf24"
                    fill="#fbbf24"
                    fillOpacity={0.1}
                    unit=""
                />
            </AreaChart>
        </ResponsiveContainer>
    );
}
