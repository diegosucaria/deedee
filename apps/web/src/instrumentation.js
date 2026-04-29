// Runs once on Next.js server startup. We dynamic-import a Node-only
// bootstrap module so webpack's edge-runtime bundle (also produced from
// this file) never tries to follow `fs`/`crypto`/`path` imports.
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { bootstrap } = await import('./lib/auth/bootstrap.js');
        await bootstrap();
    }
}
