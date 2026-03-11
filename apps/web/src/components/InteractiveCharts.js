'use client';

import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
    BarChart, Bar, AreaChart, Area, ReferenceLine,
    PieChart, Pie, Cell
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

// --- Color palette for service categories ---
const CATEGORY_COLORS = {
    Chat: '#818cf8',       // indigo
    Dreams: '#c084fc',     // purple
    Speech: '#f472b6',     // pink
    Image: '#fb923c',      // orange
    DJ: '#22d3ee',         // cyan
    Memory: '#34d399',     // emerald
    Autopilot: '#fbbf24',  // amber
    Analysis: '#60a5fa',   // blue
    People: '#a78bfa',     // violet
    Grok: '#f87171',       // red
    Other: '#71717a',      // zinc
};

const getCategoryColor = (category) => CATEGORY_COLORS[category] || CATEGORY_COLORS.Other;

/**
 * Service Cost Breakdown — Donut chart + sorted table
 */
export function ServiceCostBreakdown({ data }) {
    if (!data || !data.categories || Object.keys(data.categories).length === 0) {
        return <div className="h-full flex items-center justify-center text-zinc-600">No Data</div>;
    }

    const { categories, total } = data;

    // Sort categories by cost descending
    const sorted = Object.entries(categories)
        .map(([name, stats]) => ({ name, ...stats }))
        .sort((a, b) => b.cost - a.cost);

    // Prepare pie data
    const pieData = sorted.map(s => ({
        name: s.name,
        value: s.cost
    }));

    return (
        <div className="flex flex-col lg:flex-row gap-6 h-full">
            {/* Donut Chart */}
            <div className="w-full lg:w-1/2 h-[280px] flex items-center justify-center">
                <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                        <Pie
                            data={pieData}
                            cx="50%"
                            cy="50%"
                            innerRadius={60}
                            outerRadius={100}
                            paddingAngle={2}
                            dataKey="value"
                        >
                            {pieData.map((entry, index) => (
                                <Cell key={`cell-${index}`} fill={getCategoryColor(entry.name)} />
                            ))}
                        </Pie>
                        <Tooltip
                            contentStyle={{ backgroundColor: '#18181b', borderColor: '#3f3f46', color: '#e4e4e7' }}
                            formatter={(val) => [`$${val.toFixed(4)}`, 'Cost']}
                        />
                    </PieChart>
                </ResponsiveContainer>
            </div>

            {/* Table */}
            <div className="w-full lg:w-1/2 overflow-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-zinc-500 text-xs border-b border-zinc-800">
                            <th className="text-left py-2 px-1">Service</th>
                            <th className="text-right py-2 px-1">Calls</th>
                            <th className="text-right py-2 px-1">Tokens</th>
                            <th className="text-right py-2 px-1">Cost</th>
                            <th className="text-right py-2 px-1">%</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map((s) => {
                            const pct = total.cost > 0 ? ((s.cost / total.cost) * 100) : 0;
                            return (
                                <tr key={s.name} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                                    <td className="py-2 px-1 flex items-center gap-2">
                                        <span
                                            className="w-2.5 h-2.5 rounded-full inline-block flex-shrink-0"
                                            style={{ backgroundColor: getCategoryColor(s.name) }}
                                        />
                                        <span className="text-zinc-300">{s.name}</span>
                                    </td>
                                    <td className="text-right py-2 px-1 font-mono text-zinc-400">{s.calls.toLocaleString()}</td>
                                    <td className="text-right py-2 px-1 font-mono text-zinc-400">{s.tokens.toLocaleString()}</td>
                                    <td className="text-right py-2 px-1 font-mono text-zinc-200">${s.cost.toFixed(4)}</td>
                                    <td className="text-right py-2 px-1 font-mono text-zinc-500">{pct.toFixed(1)}%</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

/**
 * Stacked Daily Cost Chart — one bar segment per service category
 */
export function StackedDailyCostChart({ data }) {
    if (!data || data.length === 0) return <div className="h-full flex items-center justify-center text-zinc-600">No Data</div>;

    // Discover all categories present across all days
    const allCategories = new Set();
    data.forEach(d => {
        Object.keys(d).forEach(k => {
            if (k !== 'date') allCategories.add(k);
        });
    });
    const categories = [...allCategories].sort();

    return (
        <ResponsiveContainer width="100%" height="100%">
            <BarChart
                data={data}
                margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
            >
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis
                    dataKey="date"
                    stroke="#71717a"
                    fontSize={12}
                    tickFormatter={(date) => new Date(date + 'T00:00:00').toLocaleDateString([], { month: 'numeric', day: 'numeric' })}
                />
                <YAxis
                    stroke="#71717a"
                    fontSize={12}
                    tickFormatter={(val) => `$${val.toFixed(2)}`}
                />
                <Tooltip
                    contentStyle={{ backgroundColor: '#18181b', borderColor: '#3f3f46', color: '#e4e4e7' }}
                    cursor={{ fill: '#27272a' }}
                    formatter={(val, name) => [`$${Number(val).toFixed(4)}`, name]}
                />
                <Legend />
                {categories.map((cat, i) => (
                    <Bar
                        key={cat}
                        dataKey={cat}
                        stackId="cost"
                        fill={getCategoryColor(cat)}
                        radius={i === categories.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                    />
                ))}
            </BarChart>
        </ResponsiveContainer>
    );
}
