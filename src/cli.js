#!/usr/bin/env node
/**
 * cli.js
 *
 * The command-line interface.
 * Usage: npx context-debt audit [path]
 *
 * Runs a full drift audit and prints a human-readable report.
 * This is the demo artifact — the screenshot that goes in the pitch deck.
 */

'use strict';

const path = require('path');
const { scanRepo } = require('./scanner');
const { parseConfigs } = require('./config-parser');
const { scoreDrift, DriftState, Confidence } = require('./scorer');

// ─── Colour helpers (no dependencies) ────────────────────────────────────────

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  gray:   '\x1b[90m',
};

const B = s => `${c.bold}${s}${c.reset}`;
const dim = s => `${c.dim}${s}${c.reset}`;
const red = s => `${c.red}${s}${c.reset}`;
const green = s => `${c.green}${s}${c.reset}`;
const yellow = s => `${c.yellow}${s}${c.reset}`;
const cyan = s => `${c.cyan}${s}${c.reset}`;
const gray = s => `${c.gray}${s}${c.reset}`;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'audit';

  if (command !== 'audit') {
    console.log(`Usage: context-debt audit [path] [options]\n`);
    console.log(`  audit [path]              Run a drift audit on the repo at [path]`);
    console.log(`                            Defaults to the current directory\n`);
    console.log(`Options:`);
    console.log(`  --output <file>           Write JSON report to file (e.g. .context-debt/report.json)`);
    console.log(`  --max-drift <0-100>       Exit with code 1 if drift score exceeds this threshold\n`);
    process.exit(0);
  }

  // Parse positional path and flags
  const flags = parseFlags(args.slice(1));
  const targetPath = path.resolve(flags._path || '.');

  await runAudit(targetPath, flags);
}

function parseFlags(args) {
  const flags = { _path: null, output: null, maxDrift: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) {
        console.error(red(`\nError: --output requires a file path\n`));
        console.error(dim(`  Example: context-debt audit . --output .context-debt/report.json\n`));
        process.exit(1);
      }
      flags.output = args[++i];
    } else if (args[i] === '--max-drift') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) {
        console.error(red(`\nError: --max-drift requires a number between 0 and 100\n`));
        console.error(dim(`  Example: context-debt audit . --max-drift 25\n`));
        process.exit(1);
      }
      flags.maxDrift = parseInt(args[++i], 10);
      if (isNaN(flags.maxDrift) || flags.maxDrift < 0 || flags.maxDrift > 100) {
        console.error(red(`\nError: --max-drift must be a number between 0 and 100\n`));
        process.exit(1);
      }
    } else if (!args[i].startsWith('--')) {
      flags._path = args[i];
    }
  }

  return flags;
}

async function runAudit(repoRoot, flags = {}) {
  printHeader(repoRoot);

  // ── Step 1: Find and parse AI config files ──────────────────────────────
  console.log(B('\nStep 1/3') + '  Parsing AI config files...');
  const config = parseConfigs(repoRoot);

  if (config.configFiles.length === 0) {
    console.log(yellow('\n  No AI config files found.'));
    console.log(dim('  Looked for: .cursorrules, CLAUDE.md, copilot-instructions.md, and others'));
    console.log(dim('  Try running in a repo that has one of these files.\n'));
    process.exit(0);
  }

  for (const file of config.configFiles) {
    console.log(`  ${green('✓')} Found ${path.relative(repoRoot, file)}`);
  }
  console.log(`  ${cyan(config.claimedSymbols.length)} symbol references extracted`);

  // ── Step 2: Scan the repo ───────────────────────────────────────────────
  console.log(B('\nStep 2/3') + '  Scanning TypeScript files...');
  const scan = scanRepo(repoRoot);

  if (scan.errors.length > 0) {
    console.log(yellow(`  ${scan.errors.length} file(s) skipped due to parse errors`));
  }
  console.log(`  ${cyan(scan.filesScanned)} files scanned, ${cyan(scan.snapshots.reduce((n, s) => n + countSymbols(s), 0))} symbols extracted`);

  // ── Step 3: Score drift ─────────────────────────────────────────────────
  console.log(B('\nStep 3/3') + '  Scoring drift...\n');
  const report = scoreDrift(config.claimedSymbols, scan.snapshots, { externalImports: scan.externalImports });
  report.summary.configFiles = config.configFiles.length;
  report.summary.filesScanned = scan.filesScanned;

  printReport(report, repoRoot);

  // ── Write JSON report to disk ────────────────────────────────────────────
  if (flags.output) {
    writeJsonReport(report, flags.output, repoRoot);
  }

  // ── CI threshold enforcement ─────────────────────────────────────────────
  if (flags.maxDrift !== null && !isNaN(flags.maxDrift)) {
    if (report.driftScore > flags.maxDrift) {
      console.log(red(`\n  Drift score ${report.driftScore}% exceeds max-drift threshold of ${flags.maxDrift}%.`));
      process.exit(1);
    } else {
      console.log(green(`\n  Drift score ${report.driftScore}% is within max-drift threshold of ${flags.maxDrift}%.`));
    }
  }
}

// ─── JSON report writer ───────────────────────────────────────────────────────

function writeJsonReport(report, outputPath, repoRoot) {
  const fs = require('fs');
  const absPath = path.resolve(outputPath);

  // Create parent directory if it doesn't exist
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const jsonReport = {
    generatedAt: report.generatedAt,
    repoPath: repoRoot,
    driftScore: report.driftScore,
    severity: report.severity,
    summary: report.summary,
    findings: {
      stale:   report.findings.stale.map(serializeFinding),
      drifted: report.findings.drifted.map(serializeFinding),
      missing: report.findings.missing.map(serializeFinding),
    },
  };

  fs.writeFileSync(absPath, JSON.stringify(jsonReport, null, 2));
  console.log(dim(`\n  Report written to ${path.relative(process.cwd(), absPath)}`));
}

function serializeFinding(f) {
  return {
    state:      f.state,
    confidence: f.confidence,
    name:       f.claimed?.name || f.actual?.name,
    detail:     f.detail,
    ...(f.actual?.sourceFile ? { file: path.basename(f.actual.sourceFile) } : {}),
  };
}

// ─── Report printer ───────────────────────────────────────────────────────────

function printHeader(repoRoot) {
  const line = '─'.repeat(56);
  console.log(`\n${B('Context Debt')} ${dim('— drift audit')}`);
  console.log(dim(line));
  console.log(dim(`  Repo:  ${repoRoot}`));
  console.log(dim(`  Time:  ${new Date().toLocaleString()}`));
  console.log(dim(line));
}

function printReport(report, repoRoot) {
  const line = '━'.repeat(56);
  const { driftScore, severity, summary, findings } = report;

  // ── Score banner ────────────────────────────────────────────────────────
  console.log(dim(line));
  const scoreColour = scoreToColour(severity);
  const scoreStr = `${scoreColour}${B(driftScore + '%')}${c.reset}`;
  const severityBadge = `${scoreColour}[${severity.toUpperCase()}]${c.reset}`;

  console.log(`  Drift score   ${scoreStr}  ${severityBadge}`);
  console.log(dim(line));
  console.log();

  // ── Summary table ───────────────────────────────────────────────────────
  console.log(`  ${B('Summary')}`);
  console.log(`  ${pad('Config files scanned', 28)} ${summary.configFiles}`);
  console.log(`  ${pad('Symbols in AI config', 28)} ${summary.totalClaimed}`);
  console.log(`  ${pad('TypeScript files scanned', 28)} ${summary.filesScanned}`);
  console.log(`  ${pad('Symbols found in codebase', 28)} ${summary.totalSymbolsFound}`);
  console.log();
  console.log(`  ${green('✓')} ${pad('Fresh (exact match)', 26)} ${summary.fresh}`);
  console.log(`  ${red('✗')} ${pad('Stale (not found)', 26)} ${summary.stale}`);
  console.log(`  ${yellow('~')} ${pad('Drifted (signature changed)', 26)} ${summary.drifted}`);
  console.log(`  ${cyan('+')} ${pad('Missing (new, not in config)', 26)} ${summary.missing}`);
  console.log();

  // ── Stale findings ──────────────────────────────────────────────────────
  if (findings.stale.length > 0) {
    console.log(`  ${B(red('Stale references'))} ${dim('— these no longer exist')}`);
    console.log();

    for (const f of findings.stale.slice(0, 8)) {
      const conf = confidenceBadge(f.confidence);
      console.log(`  ${red('✗')} ${B(f.claimed.name)} ${conf}`);
      if (f.detail) console.log(`    ${dim(f.detail)}`);
      console.log();
    }

    if (findings.stale.length > 8) {
      console.log(dim(`  ... and ${findings.stale.length - 8} more stale reference(s)\n`));
    }
  }

  // ── Drifted findings ────────────────────────────────────────────────────
  if (findings.drifted.length > 0) {
    console.log(`  ${B(yellow('Drifted signatures'))} ${dim('— exists but changed')}`);
    console.log();

    for (const f of findings.drifted.slice(0, 5)) {
      const conf = confidenceBadge(f.confidence);
      console.log(`  ${yellow('~')} ${B(f.claimed.name)} ${conf}`);
      if (f.detail) console.log(`    ${dim(f.detail)}`);
      console.log();
    }
  }

  // ── Missing findings ────────────────────────────────────────────────────
  if (findings.missing.length > 0) {
    console.log(`  ${B(cyan('Missing from config'))} ${dim('— agents can\'t see these')}`);
    console.log();

    for (const f of findings.missing.slice(0, 5)) {
      console.log(`  ${cyan('+')} ${B(f.actual.name)}`);
      if (f.detail) console.log(`    ${dim(f.detail)}`);
      console.log();
    }
  }

  // ── Fix suggestion ──────────────────────────────────────────────────────
  console.log(dim('─'.repeat(56)));

  if (driftScore === 0) {
    console.log(`\n  ${green(B('All good.'))} Your AI context is fresh.\n`);
  } else {
    console.log(`\n  ${B('Next step:')} review the findings above and update your AI config manually.\n`);
  }
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function scoreToColour(severity) {
  switch (severity) {
    case 'clean':    return c.green;
    case 'low':      return c.cyan;
    case 'degraded': return c.yellow;
    case 'high':     return c.red;
    case 'critical': return c.red + c.bold;
    default:         return c.white;
  }
}

function confidenceBadge(confidence) {
  switch (confidence) {
    case 'high':   return dim('[high confidence]');
    case 'medium': return dim('[possible]');
    case 'low':    return dim('[low signal]');
    default:       return '';
  }
}

function pad(str, len) {
  return str.padEnd(len, ' ');
}

function countSymbols(snapshot) {
  return (
    snapshot.functions.length +
    snapshot.classes.length +
    snapshot.interfaces.length +
    snapshot.typeAliases.length +
    snapshot.enums.length
  );
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(`\n${red('Error:')} ${err.message}\n`);
  process.exit(1);
});
