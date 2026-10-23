import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

// The notice files quote the wording they prohibit, so the endorsement scan looks only at
// surfaces a first-time reader meets: the package manifest and the shipped documents.
const noticeFiles = ["README.md", "CONTRIBUTING.md", "docs/TRADEMARKS.md"];
const advertisedFiles = ["README.md", "SECURITY.md", "package.json"];

const forbiddenClaims = [
  "official codex",
  "openai official",
  "ported from codex",
  "based on codex",
  "works with codex",
  "codex compatible",
  "codex-compatible",
  "codex for pi",
  "codex dashboard for",
];

const assetExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".ttf", ".otf", ".woff", ".woff2"];

function trackedFiles(dir = root, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...trackedFiles(join(dir, entry.name), relativePath));
    else files.push(relativePath);
  }
  return files;
}

function advertisedText(): string {
  const sources = [...advertisedFiles, ...trackedFiles(join(root, "src"), "src")];
  return sources.map((file) => read(file)).join("\n").toLowerCase();
}

describe("trademark and affiliation notices", () => {
  it("states non-affiliation everywhere a reader arrives", () => {
    for (const file of [...noticeFiles, "package.json"]) {
      expect(read(file), `${file} must disclaim OpenAI affiliation`).toMatch(/not affiliated/i);
    }
  });

  it("keeps the full notice shipped with the package and linked from the readme", () => {
    const pkg = JSON.parse(read("package.json")) as { files: string[] };
    expect(pkg.files).toContain("docs/TRADEMARKS.md");
    expect(read("README.md")).toContain("docs/TRADEMARKS.md");
  });

  it("attributes the Codex mark and commits to a good-faith rename", () => {
    const notice = read("docs/TRADEMARKS.md");
    expect(notice).toMatch(/trademark of OpenAI OpCo, LLC/i);
    expect(notice).toMatch(/8423912/);
    expect(notice).toMatch(/will\s+rename rather than argue/i);
    expect(notice).toMatch(/renaming on request/i);
  });

  it("documents that no Codex code, client, or endpoint is involved", () => {
    const notice = read("docs/TRADEMARKS.md");
    expect(notice).toMatch(/no codex code/i);
    expect(notice).toMatch(/host-entry\.js/);
  });

  it("never claims OpenAI authorship, sponsorship, or Codex compatibility", () => {
    const text = advertisedText();
    for (const claim of forbiddenClaims) {
      expect(text, `${claim} implies an OpenAI connection`).not.toContain(claim);
    }
  });

  it("ships no brand artwork", () => {
    const assets = trackedFiles().filter((file) => assetExtensions.some((extension) => file.endsWith(extension)));
    expect(assets).toEqual([]);
  });
});
