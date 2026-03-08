module.exports = {
    testMatch: [
        "<rootDir>/**/*.test.js"
    ],
    testPathIgnorePatterns: [
        "/node_modules/",
        "/dist/",
        "/coverage/"
    ],
    moduleNameMapper: {
        "^bindings$": "<rootDir>/jest.setup.js"
    },
    verbose: true
};
