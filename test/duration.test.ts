import { describe, expect, it } from "vitest";
import { describeDuration } from "../src/duration.js";

describe("describeDuration", () => {
  it.each([
    [600, "10 minutes"],
    [300, "5 minutes"],
    [60, "1 minute"],
    [120, "2 minutes"],
    [3600, "60 minutes"],
    [90, "90 seconds"],
    [45, "45 seconds"],
    [1, "1 second"],
    [301, "301 seconds"],
  ])("says %i seconds as %j", (seconds, expected) => {
    expect(describeDuration(seconds)).toBe(expected);
  });
});
