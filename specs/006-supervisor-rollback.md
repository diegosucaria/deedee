# Spec 006: Supervisor Rollback

## 1. Overview
The Supervisor acts as the "Git Operator" for the system. While Spec 010 handles pre-flight verification (testing *before* commit), Spec 006 handles the ability to **undo** a change if it proves problematic after deployment (or if the user changes their mind).

## 2. Requirements

### 2.1 HTTP Endpoint
The Supervisor must expose a POST endpoint to trigger a rollback.

- **URL**: `POST /cmd/rollback`
- **Body**: `{}` (Empty for now, defaults to reverting the last 1 commit)
- **Response**: `{ success: true, message: "Reverted commit <hash>" }`

### 2.2 Revert Logic
1.  **Safety Check**: Ensure we are on `master` and the working tree is clean.
2.  **Git Revert**: Execute `git revert --no-edit HEAD` to create a new commit that undoes the previous one.
    - *Rationale*: We use `revert` instead of `reset` because we are pushing to a remote (GitHub) that triggers a build. `reset` + `force push` is risky and can break CI/CD history.
3.  **Push**: Execute `git push origin master`.

### 2.3 Verification
- The Supervisor's existing `Verifier` (Spec 010) should probably be skipped or relaxed for rollback? 
    - *Decision*: We should still run tests. Reverting a broken commit *should* make tests pass. If reverting makes tests fail, we have a bigger problem, but we should probably still allow it or at least warn. 
    - *Simpler Approach*: Treat a revert like any other commit. Verify it. If verification fails, abort the revert (or force it if a `force: true` flag is sent).

## 3. Interfaces Integration
- The Agent should be able to call this tool: `rollbackLastChange()`.
