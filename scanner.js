/**
 * scanner.js
 *
 * Walks a repository directory, finds all TypeScript files,
 * and runs the symbol extractor on each one.
 *
 * Handles:
 *   - Skipping node_modules, dist, .git, build dirs
 *   - Incremental scanning (only changed files via git diff)
 *   - Basic error recovery (one bad file doesn't kill the whole scan)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { extractSymbols } = require('./extractor');

// ─── Directories to always skip ───────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next',
  '.turbo', 'coverage', '.nyc_output', '__pycache__', '.cache',
  'vendor', '.yarn', '.pnpm-store',
]);

// ─── Main scanner ─────────────────────────────────────────────────────────────

/**
 * Scan all TypeScript files in a repo and return their symbol snapshots.
 *
 * @param {string}  repoRoot          Path to repo root
 * @param {object}  opts
 * @param {boolean} opts.incremental  Only scan files changed since last git commit
 * @param {number}  opts.maxFiles     Safety cap (default 2000)
 * @returns {ScanResult}
 */
function scanRepo(repoRoot, opts = {}) {
  const { incremental = false, maxFiles = 2000 } = opts;

  let filePaths;

  if (incremental) {
    filePaths = getChangedTsFiles(repoRoot);
    if (filePaths.length === 0) {
      return { snapshots: [], filesScanned: 0, errors: [], externalImports: new Set(), repoRoot, scannedAt: new Date().toISOString() };
    }
  } else {
    filePaths = findAllTsFiles(repoRoot, maxFiles);
  }

  const snapshots = [];
  const errors = [];
  let processed = 0;

  for (const filePath of filePaths) {
    try {
      const snapshot = extractSymbols(filePath);
      const symbolCount = countSymbols(snapshot);

      // Skip files with no extractable symbols (empty files, type-only re-exports)
      if (symbolCount > 0) {
        snapshots.push(snapshot);
      }

      processed++;

      // Progress indicator for large repos
      if (processed % 100 === 0) {
        process.stdout.write(`  Parsed ${processed}/${filePaths.length} files...\r`);
      }
    } catch (err) {
      // One bad file doesn't kill the scan
      errors.push({ filePath, error: err.message });
    }
  }

  if (processed > 100) process.stdout.write('\n'); // Clear progress line

  // Aggregate external imports collected during the AST parse — no extra I/O
  const externalImports = new Set();
  for (const snapshot of snapshots) {
    for (const name of snapshot.externalImports) {
      externalImports.add(name);
    }
  }

  return {
    snapshots,
    filesScanned: processed,
    errors,
    externalImports,
    repoRoot,
    scannedAt: new Date().toISOString(),
  };
}

// ─── File discovery ───────────────────────────────────────────────────────────

function findAllTsFiles(dir, maxFiles) {
  const files = [];
  walk(dir, files, maxFiles);
  return files;
}

function walk(dir, results, maxFiles) {
  if (results.length >= maxFiles) return;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // Permission error or broken symlink — skip
  }

  for (const entry of entries) {
    if (results.length >= maxFiles) break;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        walk(fullPath, results, maxFiles);
      }
    } else if (entry.isFile()) {
      if (isTsFile(entry.name)) {
        results.push(fullPath);
      }
    }
  }
}

function isTsFile(name) {
  // Include .ts and .tsx, exclude .d.ts declaration files
  return (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.d.ts');
}

// ─── Incremental scanning (git-aware) ────────────────────────────────────────

/**
 * Use git to find TypeScript files changed since the last commit.
 * Falls back to full scan if git isn't available.
 */
function getChangedTsFiles(repoRoot) {
  try {
    // Files changed in working tree vs last commit
    const output = execSync('git diff --name-only HEAD', {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5000,
    });

    return output
      .split('\n')
      .map(f => f.trim())
      .filter(f => isTsFile(f))
      .map(f => path.join(repoRoot, f))
      .filter(f => fs.existsSync(f)); // File might have been deleted

  } catch {
    return findAllTsFiles(repoRoot, 2000);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countSymbols(snapshot) {
  return (
    snapshot.functions.length +
    snapshot.classes.length +
    snapshot.interfaces.length +
    snapshot.typeAliases.length +
    snapshot.enums.length
  );
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { scanRepo };
