#!/usr/bin/env bun
/**
 * TwistedRest release script.
 *
 * Usage:
 *   bun run release patch    # 0.1.1 → 0.1.2
 *   bun run release minor    # 0.1.1 → 0.2.0
 *   bun run release major    # 0.1.1 → 1.0.0
 *   bun run release 0.3.0    # explicit version
 *
 * What it does:
 *   1. Reads current version from tauri.conf.json
 *   2. Bumps it (patch/minor/major or explicit)
 *   3. Writes the new version to all 3 config files
 *   4. Commits "release: vX.Y.Z"
 *   5. Creates git tag vX.Y.Z
 *   6. Pushes commit + tag
 *   7. GitHub Actions builds the .dmg and attaches to the release
 */

import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");

const FILES = [
  {
    path: resolve(ROOT, "apps/desktop/src-tauri/tauri.conf.json"),
    pattern: /"version":\s*"[\d.]+"/,
    replace: (v: string) => `"version": "${v}"`,
  },
  {
    path: resolve(ROOT, "apps/desktop/src-tauri/Cargo.toml"),
    pattern: /^version\s*=\s*"[\d.]+"/m,
    replace: (v: string) => `version = "${v}"`,
  },
  {
    path: resolve(ROOT, "apps/desktop/package.json"),
    pattern: /"version":\s*"[\d.]+"/,
    replace: (v: string) => `"version": "${v}"`,
  },
  {
    path: resolve(ROOT, "apps/desktop/src/mainview/lib/update-checker.ts"),
    pattern: /const CURRENT_VERSION = "[\d.]+"/,
    replace: (v: string) => `const CURRENT_VERSION = "${v}"`,
  },
];

function getCurrentVersion(): string {
  const conf = readFileSync(FILES[0]!.path, "utf-8");
  const match = conf.match(/"version":\s*"([\d.]+)"/);
  if (!match) throw new Error("Could not read current version from tauri.conf.json");
  return match[1]!;
}

function bump(current: string, kind: string): string {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;

  const [major, minor, patch] = current.split(".").map(Number) as [number, number, number];
  switch (kind) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      throw new Error(`Unknown bump type: "${kind}". Use patch, minor, major, or an explicit version like 0.2.0`);
  }
}

function run(cmd: string) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

// ─── Main ──────────────────────────────────────────────────────

const kind = process.argv[2];
if (!kind) {
  console.error("Usage: bun run release <patch|minor|major|X.Y.Z>");
  process.exit(1);
}

const current = getCurrentVersion();
const next = bump(current, kind);
const tag = `v${next}`;

console.log(`\n  ${current} → ${next} (${tag})\n`);

// Write to all config files
for (const file of FILES) {
  const content = readFileSync(file.path, "utf-8");
  const updated = content.replace(file.pattern, file.replace(next));
  if (updated === content) {
    console.warn(`  ⚠ No change in ${file.path}`);
  } else {
    writeFileSync(file.path, updated);
    console.log(`  ✓ ${file.path.replace(ROOT + "/", "")}`);
  }
}

// Generate commit log since last tag for release notes
let commitLog = "";
try {
  const lastTag = execSync("git describe --tags --abbrev=0 2>/dev/null", {
    cwd: ROOT,
    encoding: "utf-8",
  }).trim();
  commitLog = execSync(`git log ${lastTag}..HEAD --oneline --no-decorate`, {
    cwd: ROOT,
    encoding: "utf-8",
  }).trim();
} catch {
  commitLog = execSync("git log --oneline --no-decorate -20", {
    cwd: ROOT,
    encoding: "utf-8",
  }).trim();
}

if (commitLog) {
  console.log("\n  Commits since last release:");
  for (const line of commitLog.split("\n")) {
    console.log(`    ${line}`);
  }
}

// Git commit + tag + push
console.log("");
run(`git add -A`);
run(`git commit -m "release: ${tag}"`);
run(`git tag -a ${tag} -m "${tag}\n\n${commitLog.replace(/"/g, '\\"')}"`);
run(`git push`);
run(`git push origin ${tag}`);

console.log(`\n  ✓ Released ${tag}`);
console.log(`  → GitHub Actions will build the .dmg and attach to the release.\n`);
