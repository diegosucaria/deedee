import TasksClient from '@/components/TasksClient';

export const dynamic = 'force-dynamic';

export default function TasksPage() {
    return (
        <div className="p-8 max-w-6xl mx-auto">
            <TasksClient />
        </div>
    );
}
