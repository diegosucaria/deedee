import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * The guardian lives in the Brain page now. The old address still works,
 * and keeps the sub-tab it was asked for: /guardian?tab=policy lands on the
 * policy tab, where the sub-tab travels as `view`.
 */
export default async function GuardianPage({ searchParams }) {
    const params = await searchParams;
    const view = typeof params?.view === 'string' ? params.view : (typeof params?.tab === 'string' ? params.tab : null);
    redirect(view ? `/brain?tab=guardian&view=${encodeURIComponent(view)}` : '/brain?tab=guardian');
}
