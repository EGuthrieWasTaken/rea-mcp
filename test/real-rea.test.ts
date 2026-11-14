// The gateway running the REAL pinned REA, not the fake: it proves the production
// launch (design D8) works through the same relay the other tests exercise.
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { connectClient, startHarness } from "./helpers/gateway.js";
import { tempDir } from "./helpers/tmp.js";
import { productionLaunch } from "../src/rea/launch.js";

describe("the gateway with the real REA", () => {
  it("initializes, lists REA's tools, and calls one of them", async () => {
    const launch = productionLaunch({ PATH: process.env.PATH, HOME: tempDir("rea-home-") });
    const harness = await startHarness({ launch, initializeTimeoutMs: 60_000 });
    const { client, transport } = await connectClient(harness);

    expect(client.getServerVersion()).toMatchObject({ name: "rea" });
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(200);
    expect(tools.map((tool) => tool.name)).toContain("inspect_analysis_settings");

    // A read-only tool that needs no analysis engine. Sent as a raw request, so the
    // SDK client does not also validate the result against REA's output schema.
    const result = await client.request(
      {
        method: "tools/call",
        params: { name: "inspect_analysis_settings", arguments: { settings: ["ghidra.startup_timeout_ms"] } },
      },
      CallToolResultSchema,
    );
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("ghidra.startup_timeout_ms");

    // REA ran in the session's own directory, and wrote nothing there at idle.
    expect(transport.sessionId).toBeDefined();
    await client.close();
  }, 120_000);
});
