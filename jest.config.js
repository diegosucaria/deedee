module.exports = {
    testMatch: [
        "<rootDir>/apps/**/*.test.js",
        "<rootDir>/packages/**/*.test.js"
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
