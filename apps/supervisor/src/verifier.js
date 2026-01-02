const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const execAsync = util.promisify(exec);

class Verifier {
  constructor(workDir = '/app/source') {
    this.workDir = workDir;
  }

  async verify(files) {
    console.log('[Verifier] Starting pre-flight checks...');

    // 1. Syntax Check (Fast)
    for (const file of files) {
      if (file.endsWith('.js')) {
        try {
          // Check syntax without executing
          await execAsync(`node --check ${file}`, { cwd: this.workDir });
        } catch (error) {
          throw new Error(`Syntax Error in ${file}: ${error.stderr}`);
        }
      }
    }

    // 2. Run Tests (Slow but Safe)
    // We try to run tests related to the workspaces.
    // For now, we run all tests because we want to ensure no regression.
    // In the future, we could optimize this to `npm test -w @deedee/agent`.
    try {
      console.log('[Verifier] Running tests...');

      // Ensure specific dependencies are installed in the volume
      // This is critical because the volume is separate from the container's build time files
      console.log('[Verifier] Installing dependencies in source...');
      await execAsync('npm install', { cwd: this.workDir });

      // Run tests for the whole monorepo
      await execAsync('npm test', { cwd: this.workDir });
    } catch (error) {
      // stdout usually contains the test failure details
      throw new Error(`Tests Failed:\n${error.stdout}\n${error.stderr}`);
    }

    console.log('[Verifier] Checks passed.');
    return true;
  }
}

module.exports = { Verifier };
