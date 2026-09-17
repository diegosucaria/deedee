// apps/web is an ESM Next.js app with no Babel config. Next ships an SWC
// transformer for jest; use it for web source files so the middleware and
// lib code can be tested. Everything else keeps the babel-jest default.
const nextJestTransformer = require.resolve('next/dist/build/swc/jest-transformer');
const serverOnlyShim = require.resolve('next/dist/compiled/server-only/empty.js');

module.exports = {
    testMatch: [
        "<rootDir>/apps/**/*.test.js",
        "<rootDir>/packages/**/*.test.js",
        "<rootDir>/scripts/**/*.test.js"
    ],
    testPathIgnorePatterns: [
        "/node_modules/",
        "/dist/",
        "/coverage/"
    ],
    setupFilesAfterEnv: ["<rootDir>/jest.data-dir.js"],
    transform: {
        "[\\\\/]apps[\\\\/]web[\\\\/]src[\\\\/].+\\.js$": [nextJestTransformer, { isEsmProject: false }],
        "\\.[jt]sx?$": "babel-jest"
    },
    moduleNameMapper: {
        "^bindings$": "<rootDir>/jest.setup.js",
        // Workspace packages resolve through a node_modules symlink. In a git
        // worktree that symlink points at the main checkout, so tests would
        // read another branch's code. Map them to this tree instead.
        "^@deedee/(mcp-servers|shared|node-red-mcp)(/.*)?$": "<rootDir>/packages/$1$2",
        "^@deedee/(agent|api|interfaces|supervisor|web)(/.*)?$": "<rootDir>/apps/$1$2",
        // apps/web's "@/..." alias (see apps/web/jsconfig.json).
        "^@/(.*)$": "<rootDir>/apps/web/src/$1",
        // `server-only` is a marker package that only resolves inside the Next
        // bundler. Point it at Next's own empty shim.
        "^server-only$": serverOnlyShim,
        // apps/web's `@/` import alias (see apps/web/jsconfig.json).
        "^@/(.*)$": "<rootDir>/apps/web/src/$1"
    },
    verbose: true
};
