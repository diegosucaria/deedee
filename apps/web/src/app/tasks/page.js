
import { fetchAPI } from '@/lib/api';
import { ClipboardList } from 'lucide-react';
import TaskList from '@/components/TaskList';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
    let jobs = [];
    try {
        const data = await fetchAPI('/v1/tasks');
        jobs = data.jobs || [];
    } catch (err) {
        console.error('Tasks fetch error:', err);
    }

    return (
        <div className="p-8">
            <h1 className="text-3xl font-bold mb-8 flex items-center gap-3">
                <ClipboardList className="h-8 w-8 text-indigo-400" />
                Scheduler
            </h1>

            <TaskList tasks={jobs} />
        </div>
    );
}
