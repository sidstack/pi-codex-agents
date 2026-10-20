import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReleaseFixture, releaseFixtureConfig, type ReleaseFixture, type ReleaseRun } from "./helpers/semantic-release-fixture.js";

// Runs the pinned semantic-release engine itself against a throwaway local bare repository
// (file:// remote, so no network) with the committed `.releaserc.json` branch configuration.
// Publication to npm and GitHub is disabled in the fixture plugin set; everything that decides
// versions, tags and channels is the real engine.
const runs = new Map<string, ReleaseRun>();
let fixture: ReleaseFixture;

const run = (label: string): ReleaseRun => {
  const value = runs.get(label);
  if (!value) throw new Error(`no semantic-release run recorded for ${label}`);
  return value;
};

const released = (run: ReleaseRun): { version: string; channel: string } | undefined => {
  const [, version, channel] = run.output.match(/Published release (\S+) on (\S+) channel/) ?? [];
  return version && channel ? { version, channel } : undefined;
};

beforeAll(() => {
  fixture = createReleaseFixture(releaseFixtureConfig());
  runs.set("main", fixture.runRelease("main", "main", false));

  fixture.branchFromMain("feat/demo-one", "feat: demo feature");
  runs.set("demoOne", fixture.runRelease("feat/demo-one", "feat/demo-one", false));
  fixture.commit("fix: demo follow-up");
  runs.set("demoOneAgain", fixture.runRelease("feat/demo-one again", "feat/demo-one", false));

  fixture.branchFromMain("chore/notes-only", "docs: notes only");
  runs.set("notesOnly", fixture.runRelease("chore/notes-only", "chore/notes-only"));

  fixture.branchFromMain("feat/breaking-two", "feat!: breaking demo");
  runs.set("breakingTwo", fixture.runRelease("feat/breaking-two", "feat/breaking-two", false));

  // Branch names the release configuration must not match: their characters cannot be
  // represented in a pre-release identifier, so the patterns exclude them outright.
  fixture.branchFromMain("feat/bad.dots", "feat: dotted feature");
  runs.set("badDots", fixture.runRelease("feat/bad.dots", "feat/bad.dots"));
  fixture.branchFromMain("feat/nested/deep", "feat: nested feature");
  runs.set("nested", fixture.runRelease("feat/nested/deep", "feat/nested/deep"));
  fixture.branchFromMain("feat/UPPER", "feat: upper feature");
  runs.set("upper", fixture.runRelease("feat/UPPER", "feat/UPPER"));
  fixture.branchFromMain("feat/ab-c", "feat: hyphen feature");
  runs.set("abHyphen", fixture.runRelease("feat/ab-c", "feat/ab-c", false));
  fixture.branchFromMain("feat/ab.c", "feat: colliding dotted feature");
  runs.set("abDotted", fixture.runRelease("feat/ab.c", "feat/ab.c"));

  // Hyphen runs are part of the branch name, not separators. The identifier transform converts
  // only the `/` between the type and the name, so these two branches keep distinct
  // pre-release identifiers and channels instead of collapsing into one (EPRERELEASEBRANCHES).
  fixture.branchFromMain("feat/a-b", "feat: single hyphen feature");
  runs.set("singleHyphen", fixture.runRelease("feat/a-b", "feat/a-b", false));
  fixture.branchFromMain("feat/a--b", "feat: double hyphen feature");
  runs.set("doubleHyphen", fixture.runRelease("feat/a--b", "feat/a--b", false));

  fixture.checkout("main");
  fixture.commit("fix: main fix");
  runs.set("mainAfterMalformed", fixture.runRelease("main with malformed branches present", "main", false));
}, 180_000);

afterAll(() => {
  fixture.dispose();
});

describe("semantic-release branch configuration", () => {
  it("releases main as a stable version on the default channel", () => {
    expect(run("main").status).toBe(0);
    expect(released(run("main"))).toEqual({ version: "1.0.0", channel: "default" });
  });

  it("numbers repeated branch releases as increasing betas on a per-branch channel", () => {
    expect(run("demoOne").status).toBe(0);
    expect(released(run("demoOne"))).toEqual({ version: "1.1.0-feat-demo-one-beta.1", channel: "beta-feat-demo-one" });
    expect(released(run("demoOneAgain"))).toEqual({ version: "1.1.0-feat-demo-one-beta.2", channel: "beta-feat-demo-one" });
  });

  it("keeps breaking changes inside the branch pre-release line", () => {
    expect(run("breakingTwo").status).toBe(0);
    expect(released(run("breakingTwo"))).toEqual({ version: "2.0.0-feat-breaking-two-beta.1", channel: "beta-feat-breaking-two" });
  });

  it("releases nothing for a branch without releasable commits", () => {
    const runWithoutChanges = run("notesOnly");
    expect(runWithoutChanges.status).toBe(0);
    expect(runWithoutChanges.output).toContain("There are no relevant changes, so no new version is released.");
    expect(released(runWithoutChanges)).toBeUndefined();
  });

  const malformedBranches: Record<string, string> = { badDots: "feat/bad.dots", nested: "feat/nested/deep", upper: "feat/UPPER", abDotted: "feat/ab.c" };
  for (const [label, branch] of Object.entries(malformedBranches)) {
    it(`ignores the malformed branch ${branch} instead of failing the run`, () => {
      const malformed = run(label);
      expect(malformed.status).toBe(0);
      expect(malformed.output).toContain("therefore a new version won");
      expect(malformed.output).not.toMatch(/EPRERELEASEBRANCHES|EINVALIDBRANCHNAME|EDUPLICATEBRANCHES/);
      expect(released(malformed)).toBeUndefined();
    });
  }

  it("keeps a hyphenated branch releasable next to dotted siblings", () => {
    expect(run("abHyphen").status).toBe(0);
    expect(released(run("abHyphen"))).toEqual({ version: "1.1.0-feat-ab-c-beta.1", channel: "beta-feat-ab-c" });
  });

  it("releases hyphen-run branch names side by side with distinct identifiers", () => {
    for (const [label, branch] of [["singleHyphen", "feat/a-b"], ["doubleHyphen", "feat/a--b"]] as const) {
      const release = released(run(label));
      const identifier = branch.replaceAll("/", "-");
      const version = `1.1.0-${identifier}-beta.1`;
      expect(run(label).status).toBe(0);
      expect(release).toEqual({ version, channel: `beta-${identifier}` });
      expect(version).toMatch(/^1\.1\.0-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/);
      expect(`beta-${identifier}`).toMatch(/^[0-9A-Za-z][0-9A-Za-z.-]*$/);
    }
    expect(released(run("singleHyphen"))?.version).not.toBe(released(run("doubleHyphen"))?.version);
    expect(released(run("singleHyphen"))?.channel).not.toBe(released(run("doubleHyphen"))?.channel);
  });

  it("does not let malformed branch names block main", () => {
    const afterMalformed = run("mainAfterMalformed");
    expect(afterMalformed.status).toBe(0);
    expect(afterMalformed.output).not.toMatch(/EPRERELEASEBRANCHES|EINVALIDBRANCHNAME|EDUPLICATEBRANCHES/);
    expect(released(afterMalformed)).toEqual({ version: "1.0.1", channel: "default" });
  });

  it("tags only the supported branches", () => {
    const tags = fixture.tags();
    expect(tags).toContain("v1.0.0");
    expect(tags).toContain("v1.0.1");
    expect(tags).toContain("v1.1.0-feat-demo-one-beta.1");
    expect(tags).toContain("v1.1.0-feat-demo-one-beta.2");
    expect(tags).toContain("v1.1.0-feat-ab-c-beta.1");
    expect(tags).toContain("v1.1.0-feat-a-b-beta.1");
    expect(tags).toContain("v1.1.0-feat-a--b-beta.1");
    expect(tags.filter((tag) => /dotted|bad|nested|UPPER|ab\.c/i.test(tag))).toEqual([]);
  });
});
