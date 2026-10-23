import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { Allowlist } from "audit-ci";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const auditCiBin = join(root, "node_modules", "audit-ci", "dist", "bin.js");
const fixtureDir = join(root, "test", "fixtures", "audit-gate");
type AuditCiConfig = { moderate: boolean; "package-manager": string; "skip-dev"?: boolean; allowlist: Array<Record<string, { active?: boolean; notes?: string; expiry?: string }>> };
const committedConfig = JSON.parse(readFileSync(join(root, "audit-ci.json"), "utf8")) as AuditCiConfig;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies: Record<string, string> };

const bracesAdvisory = "GHSA-vfj7-8cjw-p6xm";
const ipAddressAdvisory = "GHSA-rxp7-6hxx-x8q5";

function committedException(advisory: string): { active?: boolean; notes?: string; expiry?: string } {
  const exception = committedConfig.allowlist.find((entry) => entry[advisory])?.[advisory];
  if (!exception) throw new Error(`audit-ci.json must carry a record for ${advisory}`);
  return exception;
}

// audit-ci decides pass/fail; the fixture only stands in for the `npm audit --json` transport so
// the gate can be exercised against report shapes the current registry no longer serves.
function runAuditGate(reportFile: string, configPath = join(root, "audit-ci.json")): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "audit-gate-"));
  const shim = join(dir, "npm");
  writeFileSync(shim, "#!/bin/sh\ncat \"$AUDIT_CI_FIXTURE_REPORT\"\n");
  chmodSync(shim, 0o755);
  const result = spawnSync(process.execPath, [auditCiBin, "--config", configPath, "--directory", fixtureDir], {
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}`, AUDIT_CI_FIXTURE_REPORT: join(fixtureDir, reportFile) },
  });
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// Names reachable from the declared devDependencies through the installed tree, at name level
// (hoisted or nested). Used to show the audit fixtures describe development-scope findings.
function devClosure(): Set<string> {
  const seen = new Set<string>(Object.keys(pkg.devDependencies));
  const queue = [...seen];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    const manifest = join(root, "node_modules", ...name.split("/"), "package.json");
    let dependencies: Record<string, string> | undefined;
    try {
      dependencies = (JSON.parse(readFileSync(manifest, "utf8")) as { dependencies?: Record<string, string> }).dependencies;
    } catch {
      continue;
    }
    for (const child of Object.keys(dependencies ?? {})) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return seen;
}

describe("dependency audit gate", () => {
  it("allowlists only scoped, justified and expiring advisories", () => {
    expect(committedConfig.moderate).toBe(true);
    expect(committedConfig["package-manager"]).toBe("npm");
    const allowlist = Allowlist.mapConfigToAllowlist({ allowlist: committedConfig.allowlist });
    expect(allowlist.modules).toEqual([]);
    expect(allowlist.paths).toEqual([]);
    expect(allowlist.advisories).toEqual([bracesAdvisory, ipAddressAdvisory]);
    expect(allowlist.advisoryRecords).toEqual([
      { [bracesAdvisory]: committedException(bracesAdvisory) },
      { [ipAddressAdvisory]: committedException(ipAddressAdvisory) },
    ]);
    for (const advisory of [bracesAdvisory, ipAddressAdvisory]) {
      const record = committedException(advisory);
      expect(record.active).toBe(true);
      expect(record.expiry).toBe("2026-11-20");
      expect(record.notes).toContain(advisory);
      expect(record.notes).toContain("dev-only release toolchain");
      expect(record.notes).toContain(`https://github.com/advisories/${advisory}`);
      expect(record.notes).toContain("not part of the published npm archive");
      expect(record.notes).toContain("2026-11-20");
    }
  });

  it("passes when every finding is the allowlisted braces advisory", () => {
    const gate = runAuditGate("npm-audit-allowlisted.json");
    expect(gate.output).toContain("GHSA-vfj7-8cjw-p6xm");
    expect(gate.status).toBe(0);
    expect(gate.output).toContain("Passed npm security audit");
  });

  it("passes for the ip-address advisory bundled inside the release toolchain npm dependency", () => {
    // The advisory is only reachable through node_modules/npm/node_modules/ip-address, the copy
    // bundled inside the npm CLI that @semantic-release/npm installs. npm ships no accepted
    // release with a fixed bundle, and bundled dependencies ignore overrides, so the record
    // suppresses it until the review date instead of widening the gate.
    const gate = runAuditGate("npm-audit-ip-address-allowlisted.json");
    expect(gate.status).toBe(0);
    expect(gate.output).toContain("Passed npm security audit");
    expect(gate.output).toContain(`Found vulnerable allowlisted advisories: ${ipAddressAdvisory}`);
    expect(gate.output).not.toContain("Failed security audit");
    expect(gate.output).not.toContain(`${ipAddressAdvisory}|`);

    const report = JSON.parse(readFileSync(join(fixtureDir, "npm-audit-ip-address-allowlisted.json"), "utf8")) as { vulnerabilities: Record<string, { nodes: string[] }> };
    expect(report.vulnerabilities["ip-address"]?.nodes).toEqual(["node_modules/npm/node_modules/ip-address"]);
    expect(pkg.dependencies?.["ip-address"]).toBeUndefined();

    // The locked tree proves the exception is dev-only: the advisory lives in the ip-address copy
    // nested inside the npm CLI that @semantic-release/npm installs, and that whole subtree is
    // marked dev because this package has no production dependencies.
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string; dev?: boolean; dependencies?: Record<string, string> }> };
    const vulnerable = lock.packages["node_modules/npm/node_modules/ip-address"];
    const npmPackage = lock.packages["node_modules/npm"];
    const semanticReleaseNpm = lock.packages["node_modules/@semantic-release/npm"];
    expect([npmPackage?.dev, vulnerable?.dev, semanticReleaseNpm?.dev]).toEqual([true, true, true]);
    expect(semanticReleaseNpm?.dependencies?.npm).toBe("^11.6.2");
    // The newest npm release that satisfies @semantic-release/npm still bundles the vulnerable
    // copy, so no range or lockfile change resolves the advisory today. If a future lockfile
    // breaks these two assertions, re-run the audit and delete the allowlist record.
    expect(npmPackage?.version).toBe("11.21.1");
    expect(vulnerable?.version).toBe("10.7.2");
  });

  it("covers the development tree, where the whole release toolchain lives", () => {
    // audit-ci defaults to the full tree; any scope narrowing would hide every pinned dependency
    // of this package, because they are all devDependencies and the package has none for npm.
    const auditScript = pkg.scripts["audit:ci"] ?? "";
    expect(auditScript).toBe("audit-ci --config ./audit-ci.json");
    expect(auditScript.split(" ")).not.toContain("--skip-dev");
    expect(auditScript).not.toMatch(/--production|--no-dev|--environment[= ]production/);
    expect(committedConfig["skip-dev"]).not.toBe(true);
    expect(pkg.dependencies).toBeUndefined();

    const report = JSON.parse(readFileSync(join(fixtureDir, "npm-audit-unlisted.json"), "utf8")) as { vulnerabilities: Record<string, { nodes: string[] }> };
    const vulnerable = Object.keys(report.vulnerabilities);
    const closure = devClosure();
    expect(vulnerable).toContain("semantic-release");
    for (const name of vulnerable) {
      expect(closure.has(name)).toBe(true);
      expect(pkg.dependencies?.[name]).toBeUndefined();
    }

    // The gate fails on findings that only exist in the development tree, so dev scope is not
    // skipped by the committed configuration.
    const gate = runAuditGate("npm-audit-unlisted.json");
    expect(gate.status).not.toBe(0);
  });

  it("fails on an unrelated advisory even at moderate severity", () => {
    const gate = runAuditGate("npm-audit-unlisted.json");
    expect(gate.status).not.toBe(0);
    expect(gate.output).toContain("GHSA-f8q6-p94x-37v3");
    expect(gate.output).toContain("Failed security audit due to moderate vulnerabilities");
    // The allowlisted advisories stay suppressed; only the new finding fails the gate.
    expect(gate.output).not.toContain(`${bracesAdvisory}|`);
    expect(gate.output).not.toContain(`${ipAddressAdvisory}|`);
  });

  it("fails again once the allowlist record expires", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-gate-config-"));
    const expired = join(dir, "audit-ci.json");
    writeFileSync(expired, JSON.stringify({ ...committedConfig, allowlist: [{ [bracesAdvisory]: { ...committedException(bracesAdvisory), expiry: "2020-01-01" } }] }, null, 2));
    const gate = runAuditGate("npm-audit-allowlisted.json", expired);
    rmSync(dir, { recursive: true, force: true });
    expect(gate.status).not.toBe(0);
    expect(gate.output).toContain("GHSA-vfj7-8cjw-p6xm");
    expect(gate.output).toContain("Failed security audit");
  });
});
