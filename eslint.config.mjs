import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "warn",
      "@next/next/no-img-element": "off",
      "react-hooks/set-state-in-effect": "off"
    }
  },
  globalIgnores([
    ".next/**",
    // git worktree 디렉터리의 빌드 산출물이 검사 대상에 포함되어
    // 로컬 verify:core 가 실패하는 문제를 막는다.
    ".worktrees/**",
    "node_modules/**",
    "out/**",
    "build/**",
    "scratch/**",
    "tmp/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
