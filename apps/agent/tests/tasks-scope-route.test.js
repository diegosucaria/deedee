/**
 * PATCH /internal/tasks/:id/scope: the owner picks the model and the tool list
 * a system job runs with. The values go into the persisted payload, which is
 * what Scheduler._systemJobOverrides reads on the next run.
 */
const request = require('supertest');
const express = require('express');
const { createInternalRouter } = require('../src/routes/internal');

function makeAgent() {
    const job = {
        metadata: {
            name: 'wardrobe_morning_outfit',
            cronExpression: '15 7 * * *',
            enabled: true,
            expiresAt: null,
            payload: {
                task: "Pick today's outfit.",
                isSystem: true,
                scope: { model: 'FLASH', allowedTools: ['searchMemory'] }
            }
        },
        nextInvocation: () => null
    };
    return {
        db: { saveScheduledJob: jest.fn() },
        scheduler: { jobs: { wardrobe_morning_outfit: job }, reregisterSystemJob: jest.fn().mockReturnValue(true) },
        interface: { broadcast: jest.fn() },
        _job: job
    };
}

function makeApp(agent) {
    const app = express();
    app.use(express.json());
    app.use('/internal', createInternalRouter(agent));
    return app;
}

describe('PATCH /internal/tasks/:id/scope', () => {
    let agent, app;
    beforeEach(() => { agent = makeAgent(); app = makeApp(agent); });

    test('saves the model and tool list, re-registers the job and broadcasts', async () => {
        const res = await request(app)
            .patch('/internal/tasks/wardrobe_morning_outfit/scope')
            .send({ model: 'pro', allowedTools: ['searchMemory', ' getFact '] });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, model: 'PRO', allowedTools: ['searchMemory', 'getFact'] });

        const saved = agent.db.saveScheduledJob.mock.calls[0][0];
        expect(saved.name).toBe('wardrobe_morning_outfit');
        expect(saved.cronExpression).toBe('15 7 * * *');
        expect(saved.enabled).toBe(true);
        expect(saved.payload.model).toBe('PRO');
        expect(saved.payload.allowedTools).toEqual(['searchMemory', 'getFact']);
        // The task and the system flag survive the edit.
        expect(saved.payload.isSystem).toBe(true);
        expect(saved.payload.task).toBe("Pick today's outfit.");
        expect(saved.payload.scope).toEqual({ model: 'FLASH', allowedTools: ['searchMemory'] });

        expect(agent.scheduler.reregisterSystemJob).toHaveBeenCalledWith('wardrobe_morning_outfit');
        expect(agent.interface.broadcast).toHaveBeenCalledWith('jobs:update', { action: 'scope', name: 'wardrobe_morning_outfit' });
    });

    test('model auto and an empty tool list clear the override', async () => {
        agent._job.metadata.payload.model = 'PRO';
        agent._job.metadata.payload.allowedTools = ['getFact'];

        const res = await request(app)
            .patch('/internal/tasks/wardrobe_morning_outfit/scope')
            .send({ model: 'auto', allowedTools: [] });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, model: 'auto', allowedTools: null });
        const saved = agent.db.saveScheduledJob.mock.calls[0][0];
        expect(saved.payload.model).toBeUndefined();
        expect(saved.payload.allowedTools).toBeUndefined();
    });

    test('a field left out of the body keeps its value', async () => {
        agent._job.metadata.payload.allowedTools = ['getFact'];
        await request(app).patch('/internal/tasks/wardrobe_morning_outfit/scope').send({ model: 'LITE' });
        const saved = agent.db.saveScheduledJob.mock.calls[0][0];
        expect(saved.payload.model).toBe('LITE');
        expect(saved.payload.allowedTools).toEqual(['getFact']);
    });

    test('cron, task and name in the body are ignored', async () => {
        await request(app).patch('/internal/tasks/wardrobe_morning_outfit/scope').send({
            model: 'FLASH',
            name: 'other_job',
            cron: '* * * * *',
            cronExpression: '* * * * *',
            task: 'do something else',
            isSystem: false
        });
        const saved = agent.db.saveScheduledJob.mock.calls[0][0];
        expect(saved.name).toBe('wardrobe_morning_outfit');
        expect(saved.cronExpression).toBe('15 7 * * *');
        expect(saved.payload.task).toBe("Pick today's outfit.");
        expect(saved.payload.isSystem).toBe(true);
    });

    test('a bad model or a bad tool list is a 400 and saves nothing', async () => {
        const bad = await request(app).patch('/internal/tasks/wardrobe_morning_outfit/scope').send({ model: 'gpt-9' });
        expect(bad.status).toBe(400);

        const badTools = await request(app).patch('/internal/tasks/wardrobe_morning_outfit/scope').send({ allowedTools: 'searchMemory' });
        expect(badTools.status).toBe(400);

        const badToolItem = await request(app).patch('/internal/tasks/wardrobe_morning_outfit/scope').send({ allowedTools: ['ok', 3] });
        expect(badToolItem.status).toBe(400);

        expect(agent.db.saveScheduledJob).not.toHaveBeenCalled();
        expect(agent.scheduler.reregisterSystemJob).not.toHaveBeenCalled();
    });

    test('an unknown job is a 404 and a job of the owner a 400', async () => {
        expect((await request(app).patch('/internal/tasks/nope/scope').send({ model: 'PRO' })).status).toBe(404);

        agent.scheduler.jobs.my_job = {
            metadata: { name: 'my_job', cronExpression: '0 9 * * *', payload: { task: 'mine' } },
            nextInvocation: () => null
        };
        const res = await request(app).patch('/internal/tasks/my_job/scope').send({ model: 'PRO' });
        expect(res.status).toBe(400);
        expect(agent.db.saveScheduledJob).not.toHaveBeenCalled();
    });

    test('a job that runs its work directly refuses a scope edit', async () => {
        agent.scheduler.jobs.nightly_backup = {
            metadata: {
                name: 'nightly_backup',
                cronExpression: '0 2 * * *',
                enabled: true,
                payload: { task: 'Back up to GCS.', isSystem: true, scopable: false }
            },
            nextInvocation: () => null
        };

        const res = await request(app).patch('/internal/tasks/nightly_backup/scope').send({ model: 'PRO' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/directly/);
        expect(agent.db.saveScheduledJob).not.toHaveBeenCalled();
        expect(agent.scheduler.reregisterSystemJob).not.toHaveBeenCalled();

        const list = await request(app).get('/internal/tasks?includeSystem=true');
        expect(list.body.jobs.find(j => j.name === 'nightly_backup').scopable).toBe(false);
        expect(list.body.jobs.find(j => j.name === 'wardrobe_morning_outfit').scopable).toBe(true);
    });

    test('GET /internal/tasks marks the defaults apart from the override', async () => {
        agent._job.metadata.payload.model = 'PRO';
        const res = await request(app).get('/internal/tasks?includeSystem=true');
        const job = res.body.jobs.find(j => j.name === 'wardrobe_morning_outfit');
        expect(job.model).toBe('PRO');
        expect(job.allowedTools).toEqual(['searchMemory']);
        expect(job.scopeDefaults).toEqual({ model: 'FLASH', allowedTools: ['searchMemory'] });
        expect(job.scopeOverride).toEqual({ model: 'PRO', allowedTools: null });
    });
});
