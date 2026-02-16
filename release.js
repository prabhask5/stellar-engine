#!/usr/bin/env node

/**
 * Release script for stellar-drive.
 *
 * Bumps the version in package.json, validates, builds, publishes to npm,
 * commits the version bump, and pushes with tags.
 *
 * Usage:
 *   npm run release              # bump patch (1.0.14 -> 1.0.15)
 *   npm run release -- minor     # bump minor (1.0.14 -> 1.1.0)
 *   npm run release -- major     # bump major (1.0.14 -> 2.0.0)
 *   npm run release -- 2.0.0     # set explicit version
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = resolve(__dirname, 'package.json');

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function bumpVersion(current, type) {
  const [major, minor, patch] = current.split('.').map(Number);
  switch (type) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    default: return type; // explicit version string
  }
}

function isValidVersion(v) {
  return /^\d+\.\d+\.\d+$/.test(v);
}

function run(cmd) {
  execSync(cmd, { cwd: __dirname, stdio: 'inherit' });
}

// Determine bump type from CLI arg
const arg = process.argv[2] || 'patch';

const pkg = readJSON(PKG_PATH);
const currentVersion = pkg.version;
const newVersion = bumpVersion(currentVersion, arg);

if (!isValidVersion(newVersion)) {
  console.error(`Invalid version: "${newVersion}". Use patch, minor, major, or an explicit x.y.z version.`);
  process.exit(1);
}

if (newVersion === currentVersion) {
  console.error(`Version is already ${currentVersion}. Nothing to do.`);
  process.exit(1);
}

console.log(`\nstellar-drive Release`);
console.log(`  ${currentVersion} -> ${newVersion}\n`);

// 1. Update package.json
pkg.version = newVersion;
writeJSON(PKG_PATH, pkg);
console.log(`  Updated package.json`);

// 2. Validate
console.log(`\n  Running validate...`);
try {
  run('npm run validate');
} catch {
  console.error('\n  Validation failed. Fix errors and try again.');
  // Revert version
  pkg.version = currentVersion;
  writeJSON(PKG_PATH, pkg);
  console.error(`  Reverted package.json to ${currentVersion}`);
  process.exit(1);
}

// 3. Build
console.log(`\n  Building...`);
try {
  run('npm run build');
} catch {
  console.error('\n  Build failed.');
  pkg.version = currentVersion;
  writeJSON(PKG_PATH, pkg);
  console.error(`  Reverted package.json to ${currentVersion}`);
  process.exit(1);
}

// 4. Publish to npm
console.log(`\n  Publishing to npm...`);
try {
  run('npm publish');
} catch {
  console.error('\n  Publish failed.');
  pkg.version = currentVersion;
  writeJSON(PKG_PATH, pkg);
  console.error(`  Reverted package.json to ${currentVersion}`);
  process.exit(1);
}

// 5. Git commit, tag, and push
console.log(`\n  Committing and pushing...`);
try {
  run(`git add package.json`);
  run(`git commit -m "v${newVersion}"`);
  run(`git tag v${newVersion}`);
  run(`git push && git push --tags`);
} catch {
  console.error('\n  Git push failed. Package was published — commit and push manually.');
  process.exit(1);
}

console.log(`\n  Released stellar-drive@${newVersion}\n`);
