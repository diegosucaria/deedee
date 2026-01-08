const { BaseExecutor } = require('./base');

class FileSystemExecutor extends BaseExecutor {
    async execute(name, args) {
        const { local } = this.services;

        switch (name) {
            case 'readFile': return await local.readFile(args.path);
            case 'writeFile': return await local.writeFile(args.path, args.content);
            case 'listDirectory': return await local.listDirectory(args.path);
            case 'runShellCommand': return await local.runShellCommand(args.command);

            case 'rollbackLastChange': {
                return await local.runShellCommand('git revert HEAD --no-edit');
            }
            case 'pullLatestChanges': {
                return await local.runShellCommand('git pull');
            }
            case 'commitAndPush': {
                // 1. Run Tests (High timeout)
                console.log('[FileSystem] Running tests before commit...');
                const testRes = await local.runShellCommand('npm test', { timeout: 120000 });
                if (testRes.error || testRes.stderr.includes('FAIL')) {
                    throw new Error(`Tests failed. Aborting commit.\n${testRes.stderr}\n${testRes.stdout}`);
                }

                // 2. Add
                await local.runShellCommand('git add .');

                // 3. Commit
                const commitRes = await local.runShellCommand(`git commit -m "${args.message.replace(/"/g, '\\"')}"`);
                if (commitRes.error && !commitRes.stdout.includes('nothing to commit')) {
                    throw new Error(`Commit failed: ${commitRes.stderr}`);
                }

                // 4. Push
                const pushRes = await local.runShellCommand('git push');
                if (pushRes.error) {
                    throw new Error(`Push failed: ${pushRes.stderr}`);
                }

                return { success: true, message: 'Changes committed and pushed successfully.' };
            }

            default: return null;
        }
    }
}

module.exports = { FileSystemExecutor };
