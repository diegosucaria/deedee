'use client';

import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
    BarChart, Bar, AreaChart, Area, ReferenceLine
} from 'recharts';

const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
        return (
            <div className="bg-zinc-900 border border-zinc-700 p-3 rounded shadow-lg text-sm">
                <p className="text-zinc-400 mb-2">{new Date(label).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'numeric', day: 'numeric' })}</p>
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

// Helper: Generate ticks for every 6 hours (00:00, 06:00, 12:00, 18:00) covering the data range
const getSmartTicks = (data) => {
    if (!data || data.length === 0) return undefined;
    const timestamps = data.map(d => d.timestamp).sort((a, b) => a - b);
    const start = timestamps[0];
    const end = timestamps[timestamps.length - 1];

    const ticks = [];
    let current = new Date(start);
    current.setMinutes(0, 0, 0); // Round down to nearest hour? 
    // Better: Start at the previous 6-hour mark
    const h = current.getHours();
    const remainder = h % 6;
    current.setHours(h - remainder, 0, 0, 0);

    while (current.getTime() <= end) {
        const t = current.getTime();
        if (t >= start) ticks.push(t);
        current.setHours(current.getHours() + 6);
    }
    return ticks.length > 0 ? ticks : undefined;
};

export function LatencyChart({ data }) {
    // Fix impurity: capture reference time
    const now = new Date().getTime();
    const ticks = getSmartTicks(data);

    if (!data || data.length === 0) return <div className="h-full flex items-center justify-center text-zinc-600">No Data</div>;

    return (
        <ResponsiveContainer width="100%" height="100%">
            <LineChart
                data={data}
                margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
                syncId="synced-charts"
            >
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" horizontal={true} vertical={true} />
                <XAxis
                    dataKey="timestamp"
                    stroke="#71717a"
                    fontSize={12}
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    ticks={ticks}
                    tickFormatter={(ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                />
                <YAxis
                    stroke="#71717a"
                    fontSize={12}
                    tickFormatter={(val) => `${Math.round(val)}ms`}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                <ReferenceLine x={now} stroke="#f472b6" label="Now" strokeDasharray="3 3" />
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
    const now = new Date().getTime();
    const ticks = getSmartTicks(data);
    if (!data || data.length === 0) return <div className="h-full flex items-center justify-center text-zinc-600">No Data</div>;

    return (
        <ResponsiveContainer width="100%" height="100%">
            <AreaChart
                data={data}
                margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
                syncId="synced-charts"
            >
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" horizontal={true} vertical={true} />
                <XAxis
                    dataKey="timestamp"
                    stroke="#71717a"
                    fontSize={12}
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    ticks={ticks}
                    tickFormatter={(ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                />
                <YAxis
                    stroke="#71717a"
                    fontSize={12}
                    tickFormatter={(val) => `$${val.toFixed(4)}`}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                <ReferenceLine x={now} stroke="#ef4444" label="Now" strokeDasharray="3 3" />
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
    const now = new Date().getTime();
    const ticks = getSmartTicks(data);
    if (!data || data.length === 0) return <div className="h-full flex items-center justify-center text-zinc-600">No Data</div>;

    // Aggregate or use raw? Assuming raw trend data of requests
    return (
        <ResponsiveContainer width="100%" height="100%">
            <AreaChart
                data={data}
                margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
                syncId="synced-charts"
            >
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" horizontal={true} vertical={true} />
                <XAxis
                    dataKey="timestamp"
                    stroke="#71717a"
                    fontSize={12}
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    ticks={ticks}
                    tickFormatter={(ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                />
                <YAxis
                    stroke="#71717a"
                    fontSize={12}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                <ReferenceLine x={now} stroke="#fbbf24" label="Now" strokeDasharray="3 3" />
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

export function DailyCostChart({ data }) {
    if (!data || data.length === 0) return <div className="h-full flex items-center justify-center text-zinc-600">No Data</div>;

    return (
        <ResponsiveContainer width="100%" height="100%">
            <BarChart
                data={data}
                margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
                syncId="synced-charts"
            >
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis
                    dataKey="date"
                    stroke="#71717a"
                    fontSize={12}
                    tickFormatter={(date) => new Date(date).toLocaleDateString([], { month: 'numeric', day: 'numeric' })}
                />
                <YAxis
                    stroke="#71717a"
                    fontSize={12}
                    tickFormatter={(val) => `$${val.toFixed(2)}`}
                />
                <Tooltip
                    contentStyle={{ backgroundColor: '#18181b', borderColor: '#3f3f46', color: '#e4e4e7' }}
                    cursor={{ fill: '#27272a' }}
                    formatter={(val) => [`$${val.toFixed(4)}`, 'Cost']}
                />
                <Legend />
                <Bar dataKey="cost" name="Cost ($)" fill="#ef4444" radius={[4, 4, 0, 0]} />
            </BarChart>
        </ResponsiveContainer>
    );
}
