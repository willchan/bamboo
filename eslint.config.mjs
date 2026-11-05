// ESLint for the TypeScript packages without their own config (/db, /shared, /worker,
// /agent/tools). /web has its own config that layers eslint-config-next on the same rules.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["**/node_modules/**", "**/dist/**", "**/coverage/**", "web/**", "spikes/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
]);
