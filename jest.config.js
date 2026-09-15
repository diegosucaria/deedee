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
    moduleNameMapper: {
        "^bindings$": "<rootDir>/jest.setup.js"
    },
    verbose: true
};
