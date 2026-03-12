'use client';

import { useState, useEffect } from 'react';
import { Calendar as CalendarIcon, ArrowLeft } from 'lucide-react';
import { getJournalFiles, getJournalEntry } from '@/app/actions';
import JournalEditor from '@/components/JournalEditor';

export default function JournalTab() {
    const [files, setFiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedDate, setSelectedDate] = useState(null);
    const [entryContent, setEntryContent] = useState('');
    const [entryLoading, setEntryLoading] = useState(false);
    const [datePicker, setDatePicker] = useState('');

    useEffect(() => {
        fetchFiles();
    }, []);

    const fetchFiles = async () => {
        setLoading(true);
        const data = await getJournalFiles();
        setFiles(data);
        setLoading(false);
    };

    const openEntry = async (dateParam) => {
        setEntryLoading(true);
        setSelectedDate(dateParam);
        const result = await getJournalEntry(dateParam);
        if (result.error) {
            setEntryContent('');
        } else {
            setEntryContent(result.content);
        }
        setEntryLoading(false);
    };

    const handleDatePick = (e) => {
        const val = e.target.value;
        setDatePicker(val);
        if (val) openEntry(val);
    };

    const formatDate = (dateStr) => {
        const [y, m, d] = dateStr.replace('.md', '').split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString(undefined, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    };

    // Detail view
    if (selectedDate) {
        const displayDate = formatDate(selectedDate);
        return (
            <div>
                <button
                    onClick={() => { setSelectedDate(null); setEntryContent(''); fetchFiles(); }}
                    className="flex items-center gap-2 text-zinc-400 hover:text-white mb-4 transition-colors text-sm"
                >
                    <ArrowLeft className="h-4 w-4" />
                    Back to Journal
                </button>

                <h2 className="text-xl font-semibold text-white mb-1 flex items-center gap-3">
                    <CalendarIcon className="h-5 w-5 text-indigo-400" />
                    {displayDate}
                </h2>
                <div className="h-px w-full bg-zinc-800 mb-6" />

                {entryLoading ? (
                    <div className="text-zinc-500">Loading...</div>
                ) : (
                    <JournalEditor date={selectedDate} initialContent={entryContent} />
                )}
            </div>
        );
    }

    // List view
    return (
        <div>
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h2 className="text-xl font-semibold text-white">Journal</h2>
                    <p className="text-zinc-400 text-sm">Daily summaries and reflections.</p>
                </div>
            </div>

            <div className="flex items-center gap-4 bg-zinc-900 p-4 rounded-xl border border-zinc-800 mb-6">
                <div className="flex items-center gap-2 text-zinc-400">
                    <CalendarIcon className="w-5 h-5" />
                    <span className="font-medium text-sm">Jump to Date:</span>
                </div>
                <input
                    type="date"
                    value={datePicker}
                    onChange={handleDatePick}
                    className="bg-zinc-800 border border-zinc-700 text-white text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block p-2.5 [color-scheme:dark]"
                />
            </div>

            {loading ? (
                <div className="text-zinc-500">Loading...</div>
            ) : files.length === 0 ? (
                <p className="text-zinc-500">No journal entries found.</p>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {files.map((file) => {
                        const dateParam = file.replace('.md', '');
                        return (
                            <button
                                key={file}
                                onClick={() => openEntry(dateParam)}
                                className="block p-6 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-indigo-500 transition-colors text-left"
                            >
                                <h3 className="text-lg font-semibold text-zinc-200">{formatDate(file)}</h3>
                                <p className="text-sm text-zinc-500 mt-2">Daily Summary</p>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
