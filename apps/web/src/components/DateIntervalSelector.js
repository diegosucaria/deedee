'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Calendar, ChevronDown } from 'lucide-react';
import clsx from 'clsx';

export default function DateIntervalSelector() {
    const router = useRouter();
    const searchParams = useSearchParams();

    const initialStart = searchParams.get('start');
    const initialEnd = searchParams.get('end');

    // Detect if URL params match a known preset (e.g. page reload after clicking Today)
    const detectPreset = () => {
        if (!initialStart && !initialEnd) return 'today'; // No params = default to Today
        if (!initialStart && initialEnd) return 'all'; // End only = All Time
        const s = new Date(initialStart);
        const now = new Date();
        const today = new Date(); today.setHours(0, 0, 0, 0);
        // Today: start is midnight today
        if (Math.abs(s.getTime() - today.getTime()) < 60000) return 'today';
        // 24h: start is ~24h ago
        const h24 = new Date(now); h24.setHours(h24.getHours() - 24);
        if (Math.abs(s.getTime() - h24.getTime()) < 120000) return '24h';
        // 7d
        const d7 = new Date(now); d7.setDate(d7.getDate() - 7);
        if (Math.abs(s.getTime() - d7.getTime()) < 120000) return '7d';
        // 30d
        const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
        if (Math.abs(s.getTime() - d30.getTime()) < 120000) return '30d';
        return 'custom';
    };
    // All Time: no start param at all (handled by !initialStart above)
    const detectedPreset = detectPreset();

    const [preset, setPreset] = useState(detectedPreset);
    const [startDate, setStartDate] = useState(initialStart || '');
    const [endDate, setEndDate] = useState(initialEnd || '');
    const [isCustom, setIsCustom] = useState(detectedPreset === 'custom');

    const presets = [
        { label: 'Today', value: 'today' },
        { label: 'Last 24 Hours', value: '24h' },
        { label: 'Last 7 Days', value: '7d' },
        { label: 'Last 30 Days', value: '30d' },
        { label: 'All Time', value: 'all' },
    ];

    const updateUrl = (start, end) => {
        const params = new URLSearchParams(searchParams);
        if (start) params.set('start', start);
        else params.delete('start');

        if (end) params.set('end', end);
        else params.delete('end');

        router.replace(`?${params.toString()}`);
    };

    const handlePresetChange = (value) => {
        setPreset(value);
        setIsCustom(false);

        let start = new Date();
        const end = new Date(); // Now

        if (value === 'today') {
            start.setHours(0, 0, 0, 0);
        } else if (value === '24h') {
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

    useEffect(() => {
        // Sync preset if URL empty
        if (!initialStart && !initialEnd && !isCustom) {
            handlePresetChange('today');
        }
    }, []);

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
