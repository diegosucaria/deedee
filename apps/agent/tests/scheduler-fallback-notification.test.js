// A reminder that reached no channel leaves a dashboard notification. The
// bell renders whatever the broadcast carries, so the broadcast has to be the
// row itself: an id to key it, a title, and a link to open.
const { Scheduler } = require('../src/scheduler');

describe('_createFallbackNotification', () => {
    let agent;
    let scheduler;
    let created;
    let broadcasts;

    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => { });
        created = [];
        broadcasts = [];
        agent = {
            db: {
                createNotification: (row) => created.push(row),
                getAllAgentSettings: () => ({}),
                getScheduledJobs: () => [],
            },
            interface: {
                broadcast: (event, payload) => {
                    broadcasts.push({ event, payload });
                    return Promise.resolve();
                }
            }
        };
        scheduler = new Scheduler(agent);
    });

    afterEach(() => {
        if (scheduler.schedulerTimer) clearInterval(scheduler.schedulerTimer);
        jest.restoreAllMocks();
    });

    test('the broadcast carries the stored row, not a bare type', () => {
        scheduler._createFallbackNotification({ task: 'Reminder: water the plants' }, 'water the plants', 'no channel accepted it');

        expect(created).toHaveLength(1);
        expect(broadcasts).toHaveLength(1);
        const { event, payload } = broadcasts[0];
        expect(event).toBe('notification:new');
        expect(payload.id).toBe(created[0].id);
        expect(payload.id).toEqual(expect.any(String));
        expect(payload.type).toBe('delivery_failure');
        expect(payload.title).toBe(created[0].title);
        expect(payload.title.length).toBeGreaterThan(0);
        expect(payload.message).toBe('water the plants');
        expect(payload.severity).toBe('warning');
        expect(payload.is_read).toBe(false);
        expect(payload.is_dismissed).toBe(false);
        expect(payload.created_at).toEqual(expect.any(String));
    });

    test('the row links to the notifications page and names the job', () => {
        scheduler._createFallbackNotification({ task: 'Reminder: pay the rent' }, 'pay the rent', 'delivery refused');

        expect(created[0].metadata).toMatchObject({
            link: '/system/notifications',
            jobName: 'Reminder: pay the rent',
            errorReason: 'delivery refused',
        });
        expect(broadcasts[0].payload.metadata.link).toBe('/system/notifications');
    });

    test('a long message is trimmed in both the row and the broadcast', () => {
        const long = 'x'.repeat(2500);
        scheduler._createFallbackNotification({ task: 'Reminder: long one' }, long, 'refused');

        expect(created[0].message).toHaveLength(2003);
        expect(created[0].message.endsWith('...')).toBe(true);
        expect(broadcasts[0].payload.message).toBe(created[0].message);
    });

    test('an interface without broadcast is not an error', () => {
        agent.interface = {};
        expect(() => scheduler._createFallbackNotification({ task: 'Reminder: quiet' }, 'quiet', 'refused')).not.toThrow();
        expect(created).toHaveLength(1);
        expect(broadcasts).toHaveLength(0);
    });
});
