import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * ESLint for the backend (issue #54).
 *
 * The frontend has had a `lint` script since it was added; the backend had none,
 * so CI ran only `tsc --noEmit` and the unit tests. Type errors are not style
 * errors: `any`, unused vars and floating promises all compile.
 *
 * Mirrors `frontend/eslint.config.mjs` (flat config, typescript-eslint's
 * recommended set) with Node globals instead of browser ones. Type-aware rules
 * are deliberately not enabled: they need `parserOptions.project` and roughly
 * double lint time, which is not worth it for a service whose types are already
 * checked by `tsc --noEmit` in the same job.
 */
export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      // A `_`-prefixed binding is intentionally unused. Express identifies an
      // error handler by its four-argument signature, so `errorHandler` cannot
      // drop its trailing `_next` — the underscore is how the convention says
      // "required here, unused by design".
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
