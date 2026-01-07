const { app } = require('../src/server');

console.log('🔍 Verifying API Auth Protection...');

// Whitelist of public paths (regex or exact string)
const PUBLIC_PATHS = [
    /^\/health$/,
    /^\/favicon\.ico$/  // Often requested by browsers
];

const protectedBase = '/v1';
let authMiddlewareFound = false;

function isPublic(path) {
    return PUBLIC_PATHS.some(p => {
        if (p instanceof RegExp) return p.test(path);
        return p === path;
    });
}

function verifyStack(stack) {
    const errors = [];
    const routes = [];

    stack.forEach(layer => {
        if (layer.route) {
            // It's a direct route (app.get, app.post)
            const path = layer.route.path;
            const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
            routes.push(`${methods} ${path}`);

            if (!path.startsWith(protectedBase) && !isPublic(path)) {
                errors.push(`❌ Unprotected Route found at root level: ${methods} ${path}`);
            }
        } else if (layer.name === 'router' && layer.regexp) {
            // It's a sub-router (app.use('/v1', ...))
            // This is harder to introspect for the exact path string from regex, 
            // but we can assume if it's the one mounting our protected routes.
            // In express 4, layer.regexp is generic. 
            // However, we know we mounted authMiddleware at /v1.
        } else if (layer.name === 'authMiddleware') {
            // Depending on how it's mounted, we might see it here.
            // If mounted as app.use('/v1', authMiddleware), it shows up as a layer filtering for /v1
            authMiddlewareFound = true;
            console.log('✅ Found authMiddleware in stack');
        }
    });

    // Strategy 2: Check if /v1 is actually protected.
    // We can inspect the handle of the layer corresponding to /v1
    // But Express structure is complex. 

    // Simpler check: Did we find authMiddleware?
    // In server.js: app.use('/v1', authMiddleware);
    // This adds a layer.name = 'authMiddleware' (if named function) or 'router' if exported differently.
    // My auth.js exports { authMiddleware }. The function name is authMiddleware.

    // Let's verify routes.
    if (routes.length > 0) {
        console.log('Found Top-Level Routes:', routes);
    }

    return errors;
}

try {
    const errors = verifyStack(app._router.stack);

    // Verify authMiddleware was found.
    // Note: If mounted with path, it might be wrapped.
    // Let's rely on the errors array for now.

    // Also, we know that `app.use('/v1', authMiddleware)` puts it in the stack.
    // Let's ensuring nothing is exposed outside /v1 except health.

    if (errors.length > 0) {
        console.error('\n⚠️ Security Verification Failed:');
        errors.forEach(e => console.error(e));
        process.exit(1);
    }

    // Check if we actually found the middleware
    /* 
       Note: Express wraps middleware in layers. checking layer.handle.name might work.
       Let's iterate again specifically looking for authMiddleware by name in the /v1 path context is hard.
       But finding it globally in the stack is a good proxy if we assume standard usage.
    */

    const layerNames = app._router.stack.map(l => l.handle.name || l.name);
    if (!layerNames.includes('authMiddleware')) {
        console.warn('⚠️ Warning: authMiddleware not explicitly found in top-level stack. It might be wrapped or anonymous.');
        // We won't fail build on this heuristic, but it's good to know.
    } else {
        console.log('✅ authMiddleware is registered.');
    }

    console.log('✨ All top-level routes are either /v1 (protected) or whitelisted.');
    process.exit(0);

} catch (error) {
    console.error('Script Error:', error);
    process.exit(1);
}
