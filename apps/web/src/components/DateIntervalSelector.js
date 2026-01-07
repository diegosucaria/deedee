'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Calendar, ChevronDown } from 'lucide-react';
import clsx from 'clsx';

export default function DateIntervalSelector() {
    const router = useRouter();
    const searchParams = useSearchParams();

    // Default to '24h' if no params
    const initialStart = searchParams.get('start');
    const initialEnd = searchParams.get('end');

    const [preset, setPreset] = useState('24h');
    const [startDate, setStartDate] = useState(initialStart || '');
    const [endDate, setEndDate] = useState(initialEnd || '');
    const [isCustom, setIsCustom] = useState(!!(initialStart && initialEnd));

    const presets = [
        { label: 'Last 24 Hours', value: '24h' },
        { label: 'Last 7 Days', value: '7d' },
        { label: 'Last 30 Days', value: '30d' },
        { label: 'All Time', value: 'all' },
    ];

    useEffect(() => {
        // Sync preset if URL empty
        if (!initialStart && !initialEnd && !isCustom) {
            handlePresetChange('24h');
        }
    }, []);

    const handlePresetChange = (value) => {
        setPreset(value);
        setIsCustom(false);

        let start = new Date();
        const end = new Date(); // Now

        if (value === '24h') {
            start.setHours(start.getHours() - 24);
        } else if (value === '7d') {
            start.setDate(start.getDate() - 7);
        } else if (value === '30d') {
            start.setDate(start.getDate() - 30);
        } else if (value === 'all') {
            start = null; // No start
        }

        const startIso = start ? start.toISOString() : '';
        const endIso = end.toISOString();

        updateUrl(startIso, endIso);
    };

    const handleCustomApply = () => {
        if (!startDate || !endDate) return;
        setIsCustom(true);
        setPreset('custom');
        // Inputs are local strings (YYYY-MM-DD), convert to ISO
        // Assume Start Day 00:00 and End Day 23:59
        const s = new Date(startDate);
        const e = new Date(endDate);
        e.setHours(23, 59, 59, 999);

        updateUrl(s.toISOString(), e.toISOString());
    };

    const updateUrl = (start, end) => {
        const params = new URLSearchParams(searchParams);
        if (start) params.set('start', start);
        else params.delete('start');

        if (end) params.set('end', end);
        else params.delete('end');

        router.replace(`?${params.toString()}`);
    };

    return (
        <div className="flex flex-wrap items-center gap-4 bg-zinc-900 border border-zinc-800 p-2 rounded-xl">
            {/* Presets */}
            <div className="flex bg-zinc-950 rounded-lg p-1 border border-zinc-800">
                {presets.map(p => (
                    <button
                        key={p.value}
                        onClick={() => handlePresetChange(p.value)}
                        className={clsx(
                            "px-3 py-1.5 text-sm rounded-md transition-all font-medium",
                            preset === p.value && !isCustom ? "bg-indigo-600 text-white shadow-sm" : "text-zinc-400 hover:text-white hover:bg-zinc-800"
                        )}
                    >
                        {p.label}
                    </button>
                ))}
            </div>

            <div className="w-px h-6 bg-zinc-800 hidden sm:block"></div>

            {/* Custom Range */}
            <div className="flex items-center gap-2">
                <div className="relative">
                    <input
                        type="date"
                        value={startDate.split('T')[0]} // Simple parsing for input
                        onChange={(e) => {
                            setStartDate(e.target.value);
                            setPreset('custom');
                        }}
                        className="bg-zinc-950 border border-zinc-800 text-zinc-300 text-sm rounded-lg px-3 py-1.5 focus:border-indigo-500 outline-none"
                    />
                </div>
                <span className="text-zinc-500">-</span>
                <div className="relative">
                    <input
                        type="date"
                        value={endDate.split('T')[0]}
                        onChange={(e) => {
                            setEndDate(e.target.value);
                            setPreset('custom');
                        }}
                        className="bg-zinc-950 border border-zinc-800 text-zinc-300 text-sm rounded-lg px-3 py-1.5 focus:border-indigo-500 outline-none"
                    />
                </div>
                <button
                    onClick={handleCustomApply}
                    disabled={!startDate || !endDate}
                    className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-sm rounded-lg hover:bg-zinc-700 disabled:opacity-50"
                >
                    Apply
                </button>
            </div>
        </div>
    );
}
