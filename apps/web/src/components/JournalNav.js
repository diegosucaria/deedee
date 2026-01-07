'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar as CalendarIcon, ChevronRight } from 'lucide-react';

export default function JournalNav() {
    const router = useRouter();
    const [date, setDate] = useState('');

    const handleDateChange = (e) => {
        const selectedDate = e.target.value;
        setDate(selectedDate);
        if (selectedDate) {
            router.push(`/journal/${selectedDate}`);
        }
    };

    return (
        <div className="flex items-center gap-4 bg-zinc-900 p-4 rounded-xl border border-zinc-800 mb-8">
            <div className="flex items-center gap-2 text-zinc-400">
                <CalendarIcon className="w-5 h-5" />
                <span className="font-medium text-sm">Jump to Date:</span>
            </div>
            <input
                type="date"
                value={date}
                onChange={handleDateChange}
                className="bg-zinc-800 border border-zinc-700 text-white text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block p-2.5 [color-scheme:dark]"
            />
        </div>
    );
}
