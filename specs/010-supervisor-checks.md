# Spec 010: Supervisor Pre-Flight Checks

## Objective
Prevent the Agent from deploying broken code by enforcing local verification before `git push`.

## Components

### 1. Verification Logic (`apps/supervisor/src/verifier.js`)
- **Method**: `verify(files)`
- **Logic**:
    1.  If files include `.js`, run `node --check <file>` (Syntax check).
    2.  If `package.json` changed, run `npm install` (dry-run or actual).
    3.  **Gold Standard**: Run `npm test` in the modified workspace.

### 2. GitOps Integration (`apps/supervisor/src/git-ops.js`)
- Update `commitAndPush` to call `verify()` first.
- If verification fails, abort commit and return error to Agent.

## Scenario: Bad Syntax

**Given** Agent sends `commitAndPush` with a file containing `function {` (syntax error).
**When** Supervisor runs `node --check`.
**Then** It should fail.
**And** Supervisor should return `{ success: false, error: "Syntax Error..." }`.
**And** Git Push is aborted.

## Implementation Plan
1. Create `apps/supervisor/src/verifier.js`.
2. Update `apps/supervisor/src/git-ops.js`.
3. Update `apps/supervisor/tests/server.test.js`.
