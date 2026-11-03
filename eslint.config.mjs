// Flat config for the whole workspace. Kept as .mjs because the root
// package.json is CJS. Type-aware linting (projectService) is deliberately not
// enabled yet — it lands in its own task.
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import { reactRefresh } from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "**/dist/",
    "**/node_modules/",
    "**/coverage/",
    // Prisma generates into node_modules/.prisma (already ignored above); this
    // covers a future `output` that points back inside apps/db.
    "apps/db/prisma/generated/",
  ]),

  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    extends: [js.configs.recommended],
  },

  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.recommended],
  },

  {
    files: [
      "api/**/*.ts",
      "apps/api/**/*.ts",
      "apps/db/**/*.ts",
      "packages/shared/**/*.ts",
    ],
    languageOptions: { globals: globals.node },
  },

  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
  },

  {
    files: ["apps/web/**/*.{ts,tsx}"],
    extends: [
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite(),
      jsxA11y.flatConfigs.recommended,
    ],
    rules: {
      // Absent from jsx-a11y's recommended set; aria-hidden on a focusable
      // element still traps keyboard/AT focus, so flag it explicitly.
      "jsx-a11y/no-aria-hidden-on-focusable": "error",
    },
  },

  // Last: turns off every rule Prettier owns.
  prettier,
]);
