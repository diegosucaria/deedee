// Jest-compatible replacement for the `bindings` module.
//
// The real `bindings` module uses Error.prepareStackTrace to walk the V8
// call stack and find the calling module's directory. Jest's custom require
// system inserts extra stack frames, causing bindings to resolve the wrong
// module root and fail to find native .node addons.
//
// This shim resolves native bindings by path lookup instead.

const path = require('path');

function bindingsShim(name) {
    // Resolve the package that depends on `bindings` by walking up from the
    // caller. Since Jest intercepts require(), we find the package root via
    // require.resolve() which still works correctly.
    const pkgDir = path.dirname(require.resolve('better-sqlite3/package.json'));
    const tryPaths = [
        path.join(pkgDir, 'build', 'Release', name),
        path.join(pkgDir, 'build', 'Debug', name),
        path.join(pkgDir, 'build', name),
    ];

    for (const tryPath of tryPaths) {
        try {
            return require(tryPath);
        } catch (e) {
            if (e.code !== 'MODULE_NOT_FOUND') throw e;
        }
    }

    throw new Error(
        'Could not locate the bindings file. Tried:\n' +
        tryPaths.map(p => ' → ' + p).join('\n')
    );
}

module.exports = bindingsShim;
