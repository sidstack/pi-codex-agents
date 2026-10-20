import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dirname, "..", "..");
const semanticReleaseBin = join(repositoryRoot, "node_modules", "semantic-release", "bin", "semantic-release.js");

export type ReleaseRun = { label: string; status: number | null; output: string };

export type ReleaseFixture = {
  root: string;
  runs: ReleaseRun[];
  tags(): string[];
  commit(message: string): void;
  branchFromMain(name: string, message: string): void;
  checkout(ref: string): void;
  runRelease(label: string, ref: string, dryRun?: boolean): ReleaseRun;
  dispose(): void;
};

type ReleaseConfig = { tagFormat: string; branches: unknown[] };

// The fixture keeps the committed branch configuration and tag format and runs the pinned
// semantic-release engine against a local bare repository over file://, so branch matching,
// pre-release numbering, channel derivation, tag creation and pushing all happen for real and
// offline. Publish-side behaviour is neutralised: `@semantic-release/npm` keeps
// `npmPublish: false`, and `@semantic-release/github` is dropped because it needs a GitHub
// token and a GitHub URL. None of that takes part in version or channel derivation.
function fixtureConfig(config: ReleaseConfig): string {
  return JSON.stringify(
    {
      tagFormat: config.tagFormat,
      branches: config.branches,
      plugins: [
        ["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
        ["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
        ["@semantic-release/changelog", { changelogFile: "CHANGELOG.md", changelogTitle: "# Changelog" }],
        ["@semantic-release/npm", { npmPublish: false }],
        ["@semantic-release/git", { assets: ["package.json", "CHANGELOG.md"] }],
      ],
    },
    null,
    2,
  );
}

export function createReleaseFixture(config: ReleaseConfig): ReleaseFixture {
  const root = mkdtempSync(join(tmpdir(), "release-engine-fixture-"));
  const bare = join(root, "origin.git");
  const work = join(root, "work");
  const remoteUrl = `file://${bare}`;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
  };
  const runs: ReleaseRun[] = [];

  const fail = (command: string, args: string[], output: string): never => {
    throw new Error(`${command} ${args.join(" ")} failed: ${output.trim()}`);
  };

  const init = spawnSync("git", ["init", "--bare", "-b", "main", bare], { encoding: "utf8", env });
  if (init.status !== 0) fail("git", ["init", "--bare", bare], init.stdout + init.stderr);
  const clone = spawnSync("git", ["clone", remoteUrl, work], { encoding: "utf8", env });
  if (clone.status !== 0) fail("git", ["clone", remoteUrl, work], clone.stdout + clone.stderr);

  const git = (...args: string[]): string => {
    const result = spawnSync("git", args, { cwd: work, encoding: "utf8", env });
    if (result.status !== 0) fail("git", args, result.stdout + result.stderr);
    return (result.stdout ?? "").trim();
  };

  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Release Fixture");
  writeFileSync(join(work, "index.js"), "export const value = 1;\n");
  writeFileSync(
    join(work, "package.json"),
    JSON.stringify({ name: "release-engine-fixture", version: "0.0.0-development", type: "module", repository: { type: "git", url: remoteUrl } }, null, 2) + "\n",
  );
  writeFileSync(join(work, ".releaserc.json"), fixtureConfig(config));
  git("add", "-A");
  git("commit", "-m", "feat: initial feature");
  git("push", "-u", "origin", "main");

  const commit = (message: string): void => {
    const head = git("rev-parse", "--abbrev-ref", "HEAD");
    writeFileSync(join(work, "index.js"), `export const value = ${message.length};\n`);
    git("add", "-A");
    git("commit", "-m", message);
    git("push", "origin", head);
  };

  const checkout = (ref: string): void => {
    git("checkout", ref);
  };

  const branchFromMain = (name: string, message: string): void => {
    git("checkout", "-B", name, "main");
    commit(message);
  };

  const runRelease = (label: string, ref: string, dryRun = true): ReleaseRun => {
    checkout(ref);
    const args = [semanticReleaseBin];
    if (dryRun) args.push("--dry-run");
    args.push("--no-ci");
    const result = spawnSync(process.execPath, args, { cwd: work, encoding: "utf8", env });
    const run = { label, status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
    runs.push(run);
    return run;
  };

  return {
    root,
    runs,
    tags: () => git("ls-remote", "--tags", "--", remoteUrl).split("\n").filter(Boolean).map((line) => line.split("refs/tags/")[1] ?? ""),
    commit,
    branchFromMain,
    checkout,
    runRelease,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function releaseFixtureConfig(): ReleaseConfig {
  return JSON.parse(readFileSync(join(repositoryRoot, ".releaserc.json"), "utf8")) as ReleaseConfig;
}
