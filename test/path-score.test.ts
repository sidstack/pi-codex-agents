import { describe, expect, it } from "vitest";
import { scorePathMatch } from "../src/ui/path-score.js";

describe("path query scoring", () => {
  it("scores empty query as zero", () => {
    expect(scorePathMatch("", "/tmp/agent/session")).toBe(0);
    expect(scorePathMatch("   ", "/tmp/agent/session")).toBe(0);
  });
  it("ranks basename exact above prefix above substring above subsequence", () => {
    const exact = scorePathMatch("session", "/tmp/agent/session");
    const prefix = scorePathMatch("sess", "/tmp/agent/session");
    const substring = scorePathMatch("sion", "/tmp/agent/session");
    const subsequence = scorePathMatch("sn", "/tmp/agent/session");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
    expect(subsequence).toBeGreaterThan(0);
  });
  it("scores full-path substring below basename matches", () => {
    const fullPath = scorePathMatch("agent", "/tmp/agent/session");
    const basenameMatch = scorePathMatch("agent", "/tmp/agent/agent-notes");
    expect(fullPath).toBeGreaterThan(0);
    expect(basenameMatch).toBeGreaterThan(fullPath);
  });
  it("is case-insensitive", () => {
    expect(scorePathMatch("SESS", "/tmp/Agent/Session")).toBe(scorePathMatch("sess", "/tmp/agent/session"));
  });
  it("returns negative for no match", () => {
    expect(scorePathMatch("zzz", "/tmp/agent/session")).toBeLessThan(0);
    expect(scorePathMatch("sionx", "/tmp/agent/session")).toBeLessThan(0);
  });
});
