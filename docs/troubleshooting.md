# Troubleshooting & Learnings

This document collects common issues, gotchas, and solutions encountered during the development of DeeDee.

## Monorepo & Docker Isolation

### Issue: "Module not found" in Docker but passes locally
**Symptoms:** 
- `npm test` passes locally.
- The service crashes on startup in Docker with `Error: Cannot find module '...'`.

**Cause:**
This is due to **Dependency Hoisting** vs **Strict Pruning**.
1.  **Local Environment**: In a Monorepo, tools like Turbo/npm often "hoist" dependencies to the root `node_modules` to save space. If App A installs `package-x` and App B doesn't, App B might still be able to `require('package-x')` locally because it finds it in the root.
2.  **Docker Environment**: Our optimized Dockerfile uses `turbo prune --scope=@current/app`. This command inspects the app's `package.json` and generates a lockfile containing **only** the dependencies explicitly listed there. If `package-x` is missing from App B's `package.json`, it is strictly excluded from the container build.

**Solution:**
- **Always** explicitly add dependencies to the specific app's `package.json`, even if they seem to work locally.
- Use `npm list <package-name>` inside the app directory to verify it is a direct dependency.

### Issue: API 504 / ECONNREFUSED
**Symptoms:**
- API Gateway returns 504 Gateway Timeout.
- Logs show `ECONNREFUSED` when trying to contact the Agent.

**Cause:**
- **Missed Dependency**: The Agent crashing on startup (due to the issue above) is the most common cause.
- **Host Binding**: By default, some frameworks/containers bind to `127.0.0.1` (localhost). In Docker, `localhost` is local to the container. Services must listen on `0.0.0.0` to be accessible by other containers.

**Solution:**
- Ensure `server.js` listens on `0.0.0.0`.
- Check startup logs for silent crashes.
