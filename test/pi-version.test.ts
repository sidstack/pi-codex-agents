import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_VERSION_RANGE, supportedPiVersion, unsupportedContract } from "../src/pi-version.js";
import { registerInstalledSdk } from "../src/pi/sdk-loader.js";

const roots: string[] = [];
function temporary() { const root = mkdtempSync(join(tmpdir(), "pi-version-")); roots.push(root); return root; }

describe("supported Pi versions", () => {
  it.each(["1.3.0", "1.3.7", "1.4.0", "1.4.11"])("accepts the validated patch release %s", (version) => {
    expect(supportedPiVersion(version)).toBe(true);
  });
  it.each(["1.2.9", "1.5.0", "2.0.0", "1.4.0-beta.1", "next"])("rejects the unvalidated release %s", (version) => {
    expect(supportedPiVersion(version)).toBe(false);
  });
  it("states the accepted range in the startup failure", () => {
    expect(unsupportedContract("extension editor cancellation")).toContain("pi-codex-agents");
    expect(unsupportedContract("extension editor cancellation")).toContain(PI_VERSION_RANGE);
  });
  it("refuses an SDK outside the range before installing resolution hooks", () => {
    const root = temporary();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.2.0" }));
    expect(() => registerInstalledSdk(root)).toThrow(`pi-codex-agents native host requires the npm-installed Pi ${PI_VERSION_RANGE}`);
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "other", "package.json"), JSON.stringify({ name: "some-other-package", version: "1.4.0" }));
    expect(() => registerInstalledSdk(join(root, "other"))).toThrow(/npm-installed Pi/);
    rmSync(root, { recursive: true, force: true });
  });
});
