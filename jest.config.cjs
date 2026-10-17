/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "jsdom",
  roots: ["<rootDir>/__tests__"],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx"],
  extensionsToTreatAsEsm: [".ts", ".tsx"],
  testMatch: ["**/__tests__/**/*.(test|spec).(ts|tsx|js)"],
};

