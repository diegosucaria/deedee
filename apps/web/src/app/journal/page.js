
import Link from 'next/link';
import { fetchAPI } from '@/lib/api';
import { Book } from 'lucide-react';
import JournalNav from '@/components/JournalNav';

export const dynamic = 'force-dynamic';

export default async function JournalPage() {
    let files = [];
    try {
        const data = await fetchAPI('/v1/journal');
        files = (data.files || []).sort().reverse();
    } catch (err) {
        console.error('Journal fetch error:', err);
    }

    return (
        <div className="p-8">
            <h1 className="text-3xl font-bold mb-8 flex items-center gap-3">
                <Book className="h-8 w-8 text-indigo-400" />
                Journal
            </h1>

            <JournalNav />

            {files.length === 0 ? (
                <p className="text-zinc-500">No journal entries found.</p>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {files.map((file) => {
                        const dateParams = file.replace('.md', '');
                        // Parse date properly (handle local time zone issues by appending T12:00:00 or splitting)
                        // Simple approach: split YYYY-MM-DD to avoid TZ shifts
                        const [y, m, d] = dateParams.split('-').map(Number);
                        const dateObj = new Date(y, m - 1, d);

                        const formattedDate = dateObj.toLocaleDateString(undefined, {
                            weekday: 'long',
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric'
                        });

                        return (
                            <Link
                                key={file}
                                href={`/journal/${dateParams}`}
                                className="block p-6 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-indigo-500 transition-colors"
                            >
                                <h2 className="text-xl font-semibold text-zinc-200">{formattedDate}</h2>
                                <p className="text-sm text-zinc-500 mt-2">Daily Summary</p>
                            </Link>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
