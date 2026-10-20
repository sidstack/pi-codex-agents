import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const pkg = JSON.parse(read("package.json")) as { version: string; scripts: Record<string, string>; publishConfig: { access?: string; tag?: string; provenance?: boolean }; devDependencies: Record<string, string> };
const release = JSON.parse(read(".releaserc.json")) as { tagFormat: string; branches: unknown[]; plugins: Array<[string, Record<string, unknown>] | string> };
const workflow = read(".github/workflows/publish.yml");
const ciWorkflow = read(".github/workflows/ci.yml");
const auditConfig = JSON.parse(read("audit-ci.json")) as { moderate: boolean; allowlist: Array<Record<string, { active?: boolean; expiry?: string; notes?: string }>> };
const prereleaseBranches = release.branches.slice(1) as Array<{ name: string; prerelease: string; channel: string }>;
// semantic-release interpolates branch config with lodash templates over `name`.
const interpolate = (value: string, name: string) => new Function("name", `return \`${value}\``)(name) as string;

describe("release automation", () => {
  it("delegates versioning to pinned semantic-release plugins in dependency order", () => {
    expect(release.tagFormat).toBe("v${version}");
    expect(release.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin))).toEqual([
      "@semantic-release/commit-analyzer",
      "@semantic-release/release-notes-generator",
      "@semantic-release/changelog",
      "@semantic-release/npm",
      "@semantic-release/exec",
      "@semantic-release/git",
      "@semantic-release/github",
    ]);
    const option = (name: string) => (release.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === name) as [string, Record<string, unknown>])[1];
    expect(option("@semantic-release/commit-analyzer").preset).toBe("conventionalcommits");
    expect(option("@semantic-release/release-notes-generator").preset).toBe("conventionalcommits");
    expect(option("@semantic-release/npm").npmPublish).toBe(true);
    expect(option("@semantic-release/exec").prepareCmd).toBe("node scripts/build.mjs");
    expect(option("@semantic-release/git").assets).toEqual(["package.json", "package-lock.json", "CHANGELOG.md", "dist"]);
    for (const name of ["semantic-release", "@semantic-release/npm", "@semantic-release/git", "@semantic-release/exec", "@semantic-release/changelog", "conventional-changelog-conventionalcommits", "audit-ci"]) {
      expect(pkg.devDependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(pkg.scripts["release:check"]).toBe("npm run build && npm run typecheck && npm test && npm run smoke && npm run fresh-install");
    expect(pkg.scripts.prepublishOnly).toBe("node scripts/prepublish.mjs");
    // npm owns versions now, so no manual version/dist script may come back.
    expect(pkg.scripts.version).toBeUndefined();
    expect(pkg.scripts.dist).toBeUndefined();
  });

  it("keeps the release branch patterns to one kebab-case segment per type", () => {
    expect(release.branches[0]).toBe("main");
    expect(prereleaseBranches.map((entry) => entry.name)).toEqual(["feat/+([a-z0-9-])", "fix/+([a-z0-9-])", "chore/+([a-z0-9-])"]);
    // A matched name contains only the characters the identifier transform keeps, so the
    // branch name to pre-release identifier mapping cannot collapse two branches together.
    const supported = /^(?:feat|fix|chore)\/\+\(\[a-z0-9-]\)$/;
    for (const entry of prereleaseBranches) expect(entry.name).toMatch(supported);
    expect(read("docs/RELEASING.md")).toContain("+([a-z0-9-])");
    expect(read("docs/RELEASING.md")).toContain("EPRERELEASEBRANCHES");
  });

  it("publishes branch betas and branch channels derived from the branch name", () => {
    const branch = "feat/launch-picker";
    for (const preid of prereleaseBranches.map((entry) => interpolate(entry.prerelease, branch))) {
      expect(preid).toBe("feat-launch-picker-beta");
      expect(`1.2.0-${preid}.1`).toMatch(/^1\.2\.0-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/);
    }
    for (const channel of prereleaseBranches.map((entry) => interpolate(entry.channel, branch))) {
      expect(channel).toBe("beta-feat-launch-picker");
      expect(channel).toMatch(/^[0-9A-Za-z][0-9A-Za-z.-]*$/);
    }
    // Branch names outside the supported shape are excluded from the release configuration by
    // the branch patterns instead of being sanitized into colliding identifiers, so they can
    // never abort the release run of a valid branch (test/release-engine.test.ts proves the
    // engine ignores them and still releases main).
    expect(prereleaseBranches.map((entry) => interpolate(entry.prerelease, "feat/two"))).not.toEqual(prereleaseBranches.map((entry) => interpolate(entry.prerelease, "fix/two")));
  });

  it("keeps the npm dist-tag under branch control and publishes with provenance", () => {
    expect(pkg.publishConfig.access).toBe("public");
    expect(pkg.publishConfig.provenance).toBe(true);
    expect(pkg.publishConfig.tag).toBeUndefined();
  });

  it("audits the full dependency tree with one expiring advisory exception", () => {
    expect(pkg.scripts["audit:ci"]).toBe("audit-ci --config ./audit-ci.json");
    expect(auditConfig.moderate).toBe(true);
    expect(auditConfig.allowlist).toHaveLength(1);
    const [record] = auditConfig.allowlist;
    const exception = record?.["GHSA-vfj7-8cjw-p6xm"];
    expect(Object.keys(record ?? {})).toEqual(["GHSA-vfj7-8cjw-p6xm"]);
    expect(exception?.active).toBe(true);
    expect(exception?.expiry).toBe("2026-11-20");
    const notes = exception?.notes ?? "";
    expect(notes.toLowerCase()).toContain("no fixed version");
    expect(notes).toContain("dev-only");
    for (const file of [ciWorkflow, workflow]) {
      expect(file).toContain("npm run audit:ci");
      expect(file).not.toContain("npm audit");
    }
  });

  it("commits generated modules matching the released version", () => {
    const build = JSON.parse(read("dist/build.json")) as { version: string };
    expect(build.version).toBe(pkg.version);
  });

  it("gates releases without a tag trigger and keeps the trusted publisher binding", () => {
    expect(workflow).toContain("name: Publish approved release");
    expect(workflow).toContain("branches: ['main', 'feat/**', 'fix/**', 'chore/**']");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+tags:/m);
    expect(workflow).toContain("concurrency:");
    expect(workflow).toContain("needs: check");
    expect(workflow).toContain("npm run release:check");
    expect(workflow).toContain("npm run audit:ci");
    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });

  it("asserts release identity on every publish path", () => {
    expect(pkg.scripts.prepublishOnly).toBe("node scripts/prepublish.mjs");
    const prepublish = read("scripts/prepublish.mjs");
    expect(prepublish).toContain("PI_AUTOMATED_PUBLISH");
    expect(prepublish).toContain("release:check");
    expect(prepublish).toContain("publish-guard.mjs");
    const guard = read("scripts/publish-guard.mjs");
    expect(guard).toContain("git(\"describe\"");
    expect(guard).toContain("--porcelain");
    expect(guard).toContain("dist/build.json");
  });
});
