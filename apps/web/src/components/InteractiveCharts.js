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
                <Tooltip content={({ active, payload, label }) => {
                    if (!active || !payload || !payload.length) return null;
                    const d = payload[0]?.payload;
                    return (
                        <div className="bg-zinc-900 border border-zinc-700 p-3 rounded shadow-lg text-sm">
                            <p className="text-zinc-400 mb-2">{new Date(label).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'numeric', day: 'numeric' })}</p>
                            {payload.map((p, i) => (
                                <p key={i} style={{ color: p.color }} className="font-mono">
                                    {p.name}: <span className="font-bold">{Math.round(p.value)}ms</span>
                                </p>
                            ))}
                            {d?.sample_count && <p className="text-zinc-500 mt-1 text-xs">{d.sample_count} samples</p>}
                        </div>
                    );
                }} />
                <Legend />
                <ReferenceLine x={now} stroke="#818cf8" label="Now" strokeDasharray="3 3" />
                <Line
                    type="monotone"
                    dataKey="p50"
                    name="P50"
                    stroke="#818cf8"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                />
                <Line
                    type="monotone"
                    dataKey="p95"
                    name="P95"
                    stroke="#f472b6"
                    strokeWidth={2}
                    strokeDasharray="6 3"
                    dot={false}
                    activeDot={{ r: 4 }}
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

const fmtTokens = (n) => {
    if (!n) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return n.toLocaleString();
};

export function TokenEfficiencyChart({ data }) {
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
                    tickFormatter={fmtTokens}
                />
                <Tooltip content={({ active, payload, label }) => {
                    if (!active || !payload || !payload.length) return null;
                    return (
                        <div className="bg-zinc-900 border border-zinc-700 p-3 rounded shadow-lg text-sm">
                            <p className="text-zinc-400 mb-2">{new Date(label).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'numeric', day: 'numeric' })}</p>
                            {payload.filter(p => p.value > 0).map((p, i) => (
                                <p key={i} style={{ color: p.color }} className="font-mono">
                                    {p.name}: <span className="font-bold">{fmtTokens(p.value)}</span>
                                </p>
                            ))}
                        </div>
                    );
                }} />
                <Legend />
                <ReferenceLine x={now} stroke="#60a5fa" label="Now" strokeDasharray="3 3" />
                <Area type="monotone" dataKey="prompt_tokens" name="Prompt" stroke="#60a5fa" fill="#60a5fa" fillOpacity={0.15} stackId="tokens" />
                <Area type="monotone" dataKey="cached_tokens" name="Cached" stroke="#34d399" fill="#34d399" fillOpacity={0.15} stackId="tokens" />
                <Area type="monotone" dataKey="candidate_tokens" name="Output" stroke="#818cf8" fill="#818cf8" fillOpacity={0.15} stackId="tokens" />
                <Area type="monotone" dataKey="thoughts_tokens" name="Thinking" stroke="#c084fc" fill="#c084fc" fillOpacity={0.15} stackId="tokens" />
            </AreaChart>
        </ResponsiveContainer>
    );
}

export function CacheHitRateChart({ data }) {
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
                    domain={[0, 100]}
                    tickFormatter={(val) => `${val}%`}
                />
                <Tooltip content={({ active, payload, label }) => {
                    if (!active || !payload || !payload.length) return null;
                    const d = payload[0]?.payload;
                    return (
                        <div className="bg-zinc-900 border border-zinc-700 p-3 rounded shadow-lg text-sm">
                            <p className="text-zinc-400 mb-2">{new Date(label).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'numeric', day: 'numeric' })}</p>
                            <p className="font-mono text-emerald-400">
                                Cache Hit: <span className="font-bold">{payload[0]?.value?.toFixed(1)}%</span>
                            </p>
                            {d && <p className="text-zinc-500 mt-1 text-xs">{fmtTokens(d.cached_tokens)} / {fmtTokens(d.prompt_tokens)} tokens</p>}
                        </div>
                    );
                }} />
                <Legend />
                <ReferenceLine x={now} stroke="#34d399" label="Now" strokeDasharray="3 3" />
                <Area
                    type="monotone"
                    dataKey="cache_hit_pct"
                    name="Cache Hit %"
                    stroke="#34d399"
                    fill="#34d399"
                    fillOpacity={0.1}
                />
            </AreaChart>
        </ResponsiveContainer>
    );
}

// --- Color palette for models ---
const MODEL_COLORS = [
    '#818cf8', '#f472b6', '#34d399', '#fbbf24', '#60a5fa',
    '#c084fc', '#fb923c', '#22d3ee', '#f87171', '#a78bfa',
    '#22c55e', '#06b6d4', '#e879f9', '#facc15',
];

const getModelColor = (model, index) => MODEL_COLORS[index % MODEL_COLORS.length];

const shortModelName = (model) => {
    if (!model) return 'unknown';
    return model.replace('gemini-', '').replace('-preview', '').replace('-exp', '');
};

export function ModelUsageChart({ data }) {
    if (!data || data.length === 0) return <div className="h-full flex items-center justify-center text-zinc-600">No Data</div>;

    // Discover all models present across all days
    const allModels = new Set();
    data.forEach(d => {
        Object.keys(d).forEach(k => { if (k !== 'date') allModels.add(k); });
    });
    const models = [...allModels].sort();

    return (
        <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis
                    dataKey="date"
                    stroke="#71717a"
                    fontSize={12}
                    tickFormatter={(date) => new Date(date + 'T00:00:00').toLocaleDateString([], { month: 'numeric', day: 'numeric' })}
                />
                <YAxis stroke="#71717a" fontSize={12} />
                <Tooltip
                    content={({ active, payload, label }) => {
                        if (!active || !payload || payload.length === 0) return null;
                        const dayTotal = payload.reduce((sum, entry) => sum + (Number(entry.value) || 0), 0);
                        return (
                            <div style={{ backgroundColor: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, padding: '10px 14px', color: '#e4e4e7', fontSize: 13 }}>
                                <div style={{ fontWeight: 600, marginBottom: 6, color: '#a1a1aa' }}>{label}</div>
                                {payload.filter(e => e.value > 0).sort((a, b) => b.value - a.value).map((entry, i) => (
                                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 2 }}>
                                        <span style={{ color: entry.color }}>{shortModelName(entry.name)}</span>
                                        <span style={{ fontFamily: 'monospace' }}>{Number(entry.value).toLocaleString()}</span>
                                    </div>
                                ))}
                                <div style={{ borderTop: '1px solid #3f3f46', marginTop: 6, paddingTop: 6, display: 'flex', justifyContent: 'space-between', gap: 16, fontWeight: 700 }}>
                                    <span style={{ color: '#facc15' }}>Total</span>
                                    <span style={{ fontFamily: 'monospace', color: '#facc15' }}>{dayTotal.toLocaleString()}</span>
                                </div>
                            </div>
                        );
                    }}
                />
                <Legend formatter={(value) => shortModelName(value)} />
                {models.map((model, i) => (
                    <Bar
                        key={model}
                        dataKey={model}
                        name={model}
                        stackId="model-usage"
                        fill={getModelColor(model, i)}
                    />
                ))}
            </BarChart>
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
    'Web Chat': '#818cf8', // indigo
    WhatsApp: '#22c55e',   // green
    Jobs: '#f59e0b',       // amber
    'Sub-agents': '#06b6d4', // cyan-500
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
                    <tfoot>
                        <tr className="border-t-2 border-zinc-700">
                            <td className="py-2 px-1 font-semibold text-zinc-200">Total</td>
                            <td className="text-right py-2 px-1 font-mono font-semibold text-zinc-300">{total.calls.toLocaleString()}</td>
                            <td className="text-right py-2 px-1 font-mono font-semibold text-zinc-300">{total.tokens.toLocaleString()}</td>
                            <td className="text-right py-2 px-1 font-mono font-semibold text-yellow-400">${total.cost.toFixed(4)}</td>
                            <td className="text-right py-2 px-1 font-mono font-semibold text-zinc-400">100%</td>
                        </tr>
                    </tfoot>
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
                    content={({ active, payload, label }) => {
                        if (!active || !payload || payload.length === 0) return null;
                        const dayTotal = payload.reduce((sum, entry) => sum + (Number(entry.value) || 0), 0);
                        return (
                            <div style={{ backgroundColor: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, padding: '10px 14px', color: '#e4e4e7', fontSize: 13 }}>
                                <div style={{ fontWeight: 600, marginBottom: 6, color: '#a1a1aa' }}>{label}</div>
                                {payload.filter(e => e.value > 0).sort((a, b) => b.value - a.value).map((entry, i) => (
                                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 2 }}>
                                        <span style={{ color: entry.color }}>{entry.name}</span>
                                        <span style={{ fontFamily: 'monospace' }}>${Number(entry.value).toFixed(4)}</span>
                                    </div>
                                ))}
                                <div style={{ borderTop: '1px solid #3f3f46', marginTop: 6, paddingTop: 6, display: 'flex', justifyContent: 'space-between', gap: 16, fontWeight: 700 }}>
                                    <span style={{ color: '#facc15' }}>Total</span>
                                    <span style={{ fontFamily: 'monospace', color: '#facc15' }}>${dayTotal.toFixed(4)}</span>
                                </div>
                            </div>
                        );
                    }}
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

/**
 * Model Cost Breakdown — sorted table showing cost per model
 */
export function ModelCostBreakdown({ data }) {
    if (!data || data.length === 0) {
        return <div className="h-full flex items-center justify-center text-zinc-600">No Data</div>;
    }

    const totalCost = data.reduce((sum, row) => sum + (row.cost || 0), 0);
    const totalCached = data.reduce((sum, row) => sum + (row.cached_tokens || 0), 0);

    // Shorten model names for display
    const shortName = (model) => {
        if (!model) return 'unknown';
        return model
            .replace('gemini-', '')
            .replace('-preview', '')
            .replace('-exp', '');
    };

    const fmtTokens = (n) => {
        if (!n) return '0';
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
        return n.toLocaleString();
    };

    return (
        <div className="overflow-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr className="text-zinc-500 text-xs border-b border-zinc-800">
                        <th className="text-left py-2 px-2">Model</th>
                        <th className="text-right py-2 px-2">Calls</th>
                        <th className="text-right py-2 px-2">Input</th>
                        {totalCached > 0 && <th className="text-right py-2 px-2">Cached</th>}
                        <th className="text-right py-2 px-2">Output</th>
                        <th className="text-right py-2 px-2">Cost</th>
                        <th className="text-right py-2 px-2">%</th>
                    </tr>
                </thead>
                <tbody>
                    {data.map((row) => {
                        const pct = totalCost > 0 ? ((row.cost / totalCost) * 100) : 0;
                        const cachePct = row.input_tokens > 0 ? ((row.cached_tokens || 0) / row.input_tokens * 100) : 0;
                        return (
                            <tr key={row.model} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                                <td className="py-2 px-2 text-zinc-300 font-mono text-xs" title={row.model}>
                                    {shortName(row.model)}
                                </td>
                                <td className="text-right py-2 px-2 font-mono text-zinc-400">{row.calls?.toLocaleString()}</td>
                                <td className="text-right py-2 px-2 font-mono text-zinc-400 text-xs">{fmtTokens(row.input_tokens)}</td>
                                {totalCached > 0 && (
                                    <td className="text-right py-2 px-2 font-mono text-xs" title={`${cachePct.toFixed(0)}% of input cached`}>
                                        <span className="text-green-400">{fmtTokens(row.cached_tokens)}</span>
                                    </td>
                                )}
                                <td className="text-right py-2 px-2 font-mono text-zinc-400 text-xs">{fmtTokens(row.output_tokens)}</td>
                                <td className="text-right py-2 px-2 font-mono text-zinc-200">${(row.cost || 0).toFixed(4)}</td>
                                <td className="text-right py-2 px-2 font-mono text-zinc-500">{pct.toFixed(1)}%</td>
                            </tr>
                        );
                    })}
                </tbody>
                <tfoot>
                    <tr className="border-t-2 border-zinc-700">
                        <td className="py-2 px-2 font-semibold text-zinc-200">Total</td>
                        <td className="text-right py-2 px-2 font-mono font-semibold text-zinc-300">{data.reduce((s, r) => s + (r.calls || 0), 0).toLocaleString()}</td>
                        <td className="text-right py-2 px-2 font-mono font-semibold text-zinc-300 text-xs">{fmtTokens(data.reduce((s, r) => s + (r.input_tokens || 0), 0))}</td>
                        {totalCached > 0 && (
                            <td className="text-right py-2 px-2 font-mono font-semibold text-xs">
                                <span className="text-green-400">{fmtTokens(totalCached)}</span>
                            </td>
                        )}
                        <td className="text-right py-2 px-2 font-mono font-semibold text-zinc-300 text-xs">{fmtTokens(data.reduce((s, r) => s + (r.output_tokens || 0), 0))}</td>
                        <td className="text-right py-2 px-2 font-mono font-semibold text-yellow-400">${totalCost.toFixed(4)}</td>
                        <td className="text-right py-2 px-2 font-mono font-semibold text-zinc-400">100%</td>
                    </tr>
                </tfoot>
            </table>
        </div>
    );
}
