// Type labels and the filter behind the bell and the notifications page.
const {
    filterNotifications,
    notificationTypeLabel,
    notificationTypeOptions,
    notificationTypeStyle,
} = require('../src/lib/notifications.js');

const rows = [
    { id: '1', type: 'delivery_failure', severity: 'warning', is_read: false, is_dismissed: false },
    { id: '2', type: 'ask_user', severity: 'info', is_read: true, is_dismissed: false },
    { id: '3', type: 'model_failure', severity: 'error', is_read: false, is_dismissed: true },
    { id: '4', type: 'delivery_failure', severity: 'error', is_read: true, is_dismissed: false },
];

describe('notificationTypeLabel', () => {
    test('known types read as plain words', () => {
        expect(notificationTypeLabel('delivery_failure')).toBe('Not delivered');
        expect(notificationTypeLabel('ask_user')).toBe('Question');
    });

    test('unknown types lose the underscores instead of vanishing', () => {
        expect(notificationTypeLabel('model_failure')).toBe('Model failure');
        expect(notificationTypeLabel('backup_failed')).toBe('Backup failed');
        expect(notificationTypeLabel(undefined)).toBe('Other');
        expect(notificationTypeLabel('')).toBe('Other');
    });

    test('every type gets a badge class', () => {
        expect(notificationTypeStyle('delivery_failure')).toContain('amber');
        expect(notificationTypeStyle('something_new')).toContain('zinc');
    });
});

describe('notificationTypeOptions', () => {
    test('all plus the types present, sorted, no repeats', () => {
        expect(notificationTypeOptions(rows)).toEqual(['all', 'ask_user', 'delivery_failure', 'model_failure']);
    });

    test('an empty list offers only all', () => {
        expect(notificationTypeOptions([])).toEqual(['all']);
        expect(notificationTypeOptions([{ id: '9' }])).toEqual(['all']);
    });
});

describe('filterNotifications', () => {
    test('defaults hide dismissed rows and keep the rest', () => {
        expect(filterNotifications(rows).map(n => n.id)).toEqual(['1', '2', '4']);
    });

    test('type filter narrows to one kind and stacks with severity', () => {
        expect(filterNotifications(rows, { type: 'delivery_failure' }).map(n => n.id)).toEqual(['1', '4']);
        expect(filterNotifications(rows, { type: 'delivery_failure', severity: 'error' }).map(n => n.id)).toEqual(['4']);
        expect(filterNotifications(rows, { type: 'ask_user', severity: 'error' })).toEqual([]);
    });

    test('status filters pick unread and dismissed rows', () => {
        expect(filterNotifications(rows, { status: 'unread' }).map(n => n.id)).toEqual(['1']);
        expect(filterNotifications(rows, { status: 'dismissed' }).map(n => n.id)).toEqual(['3']);
        expect(filterNotifications(rows, { status: 'dismissed', type: 'model_failure' }).map(n => n.id)).toEqual(['3']);
    });
});
