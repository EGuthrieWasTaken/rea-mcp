import { fileURLToPath } from "node:url";

/** The gateway entry point built by `test/global-setup.ts`. */
export const BUILT_MAIN = fileURLToPath(new URL("../../.test-build/main.js", import.meta.url));

/** The repository root. */
export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The fake REA fixture built by `test/global-setup.ts`. */
export const FAKE_REA = fileURLToPath(new URL("../../.test-build/fixtures/fake-rea.js", import.meta.url));
