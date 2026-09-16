import { getNotifications, getNotificationOutbox } from '../../actions';
import NotificationsClient from '@/components/NotificationsClient';
import UndeliveredClient from '@/components/UndeliveredClient';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
    let notifications = [];
    let unreadCount = 0;
    let outbox = { rows: [], counts: { pending: 0, sent: 0, failed: 0, dead: 0 } };

    try {
        const data = await getNotifications(100, true, true);
        notifications = data.notifications || [];
        unreadCount = data.unreadCount || 0;
    } catch (e) {
        console.error('Failed to fetch notifications:', e);
    }

    try {
        const data = await getNotificationOutbox(50);
        outbox = { rows: data.rows || [], counts: data.counts || outbox.counts };
    } catch (e) {
        console.error('Failed to fetch the delivery outbox:', e);
    }

    return (
        <div className="flex flex-col text-zinc-200 w-full">
            <header className="mb-8 w-full">
                <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Notifications</h1>
                <p className="text-zinc-400">
                    System alerts, warnings, and important events. {unreadCount > 0 && `${unreadCount} unread.`}
                </p>
            </header>

            <section className="w-full mb-10">
                <UndeliveredClient initialRows={outbox.rows} initialCounts={outbox.counts} />
            </section>

            <section className="w-full pb-20">
                <NotificationsClient initialNotifications={notifications} initialUnreadCount={unreadCount} />
            </section>
        </div>
    );
}
