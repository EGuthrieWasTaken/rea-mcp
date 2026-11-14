import { afterEach } from "vitest";
import { closeHarnesses } from "./helpers/gateway.js";
import { removeTempDirs } from "./helpers/tmp.js";

// Runs after every test in every file: stop any gateway a test left open, then
// delete the temporary directories (in that order: the gateway may still use them).
afterEach(async () => {
  await closeHarnesses();
  removeTempDirs();
});
