import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * Approvals live in the Brain page now. The old address still works: chat
 * cards, notifications and bookmarks point here.
 */
export default function ApprovalsPage() {
    redirect('/brain?tab=approvals');
}
