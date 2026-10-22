import { defineConfig } from "vitest/config";

// A nested git worktree or release checkout holds a second copy of this repository with its
// own sources and tests. Discovering that copy mixes two source trees into one test run.
export default defineConfig({
  test: { exclude: ["**/node_modules/**", "dist/**", ".worktrees/**", "release/**"] },
});
