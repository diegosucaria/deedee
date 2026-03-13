import { ClipboardList } from 'lucide-react';
import PageShell from '@/components/PageShell';
import TasksClient from '@/components/TasksClient';

export const dynamic = 'force-dynamic';

export default function TasksPage() {
    return (
        <PageShell icon={ClipboardList} title="Scheduler & Tasks" subtitle="Manage scheduled jobs, watchers, and sub-agents.">
            <TasksClient />
        </PageShell>
    );
}
