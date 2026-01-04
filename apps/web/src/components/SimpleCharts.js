'use client';

import { useMemo } from 'react';

/**
 * A lightweight, dependency-free Line Chart component using SVG.
 * @param {Object} props
 * @param {Array} props.data - Array of objects { label, value1, value2 }
 * @param {string} props.dataKey1 - Key for first metric
 * @param {string} props.dataKey2 - Key for second metric (optional)
 * @param {string} props.color1 - Color for first metric (tailwind class or hex?) -> using hex/stroke
 * @param {string} props.color2 - Color for second metric
 */
export function SimpleLineChart({ data, dataKey1, dataKey2, height = 200, color1 = '#818cf8', color2 = '#34d399' }) {
    if (!data || data.length === 0) return <div className="h-full flex items-center justify-center text-zinc-600">No Data</div>;

    const padding = 20;
    const width = 600; // viewBox width
    const chartHeight = height;

    const values1 = data.map(d => d[dataKey1] || 0);
    const values2 = dataKey2 ? data.map(d => d[dataKey2] || 0) : [];
    const allValues = [...values1, ...values2];

    const maxVal = Math.max(...allValues, 100);
    const minVal = 0;

    const getX = (index) => padding + (index / (data.length - 1)) * (width - 2 * padding);
    const getY = (value) => chartHeight - padding - ((value - minVal) / (maxVal - minVal)) * (chartHeight - 2 * padding);

    const buildPath = (values) => {
        if (values.length === 0) return '';
        const points = values.map((v, i) => `${getX(i)},${getY(v)}`);
        return `M ${points.join(' L ')}`;
    };

    const path1 = buildPath(values1);
    const path2 = buildPath(values2);

    return (
        <div className="w-full h-full">
            <svg viewBox={`0 0 ${width} ${chartHeight}`} className="w-full h-full overflow-visible">
                {/* Grid Lines */}
                {[0, 0.25, 0.5, 0.75, 1].map(t => {
                    const y = chartHeight - padding - t * (chartHeight - 2 * padding);
                    return (
                        <g key={t}>
                            <line x1={padding} y1={y} x2={width - padding} y2={y} stroke="#27272a" strokeWidth="1" strokeDasharray="4 4" />
                            <text x={0} y={y + 4} className="text-[10px] fill-zinc-600 font-mono">{Math.round(minVal + t * (maxVal - minVal))}</text>
                        </g>
                    );
                })}

                {/* Lines */}
                {path2 && <path d={path2} fill="none" stroke={color2} strokeWidth="2" />}
                <path d={path1} fill="none" stroke={color1} strokeWidth="2" />

                {/* Points */}
                {values1.map((v, i) => (
                    <circle key={`p1-${i}`} cx={getX(i)} cy={getY(v)} r="3" fill={color1} />
                ))}
            </svg>
        </div>
    );
}
