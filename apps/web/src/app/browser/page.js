import { Globe } from 'lucide-react';
import PageShell from '@/components/PageShell';
import BrowserViewer from '@/components/BrowserViewer';
import { getBrowserStatus } from '../actions';

export const dynamic = 'force-dynamic';

export default async function BrowserPage() {
    const status = await getBrowserStatus();
    return (
        <PageShell icon={Globe} title="Browser" subtitle="Watch and drive the agent's browser. Log in to sites here; the profile keeps the cookies.">
            <BrowserViewer initialStatus={status} />
        </PageShell>
    );
}
