import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * The guardian lives in the Brain page now. The old address still works:
 * notifications written by the agent link here.
 */
export default function GuardianPage() {
    redirect('/brain?tab=guardian');
}
