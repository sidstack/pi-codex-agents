import { describe, expect, it } from "vitest";
import { countUnsettled } from "../src/core/activity.js";

describe("authoritative unsettled activity", () => {
  it("counts work independently of the error label", () => {
    expect(countUnsettled([
      { activity: "failed", running: true, prompts: 0 },
      { activity: "failed", running: false, prompts: 1 },
      { activity: "failed", running: false, prompts: 0 },
      { activity: "ready", running: false, prompts: 0 },
    ])).toBe(2);
  });
  it("treats ambiguous legacy failures conservatively", () => {
    expect(countUnsettled([{ activity: "failed" }, { activity: "failed", running: false }, { activity: "ready" }])).toBe(2);
  });
});

it("counts native preparation independently of the displayed activity", () => {
  expect(countUnsettled([{ activity: "ready", running: false, prompts: 0, pendingOperations: 1 }])).toBe(1);
});
