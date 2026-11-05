module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.jest.test.ts"],
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  transform: {
    "^.+\\.ts$": [
      "@swc/jest",
      {
        jsc: { target: "es2022", parser: { syntax: "typescript" } },
        module: { type: "commonjs" },
      },
    ],
  },
  testTimeout: 30_000,
};
