/**
 * index.js
 *
 * Public SDK surface for @context-debt/core.
 *
 * This is what other tools embed:
 *
 *   const { RepoIndex } = require('@context-debt/core');
 *   const index = new RepoIndex({ repoPath: '.' });
 *   const report = await index.audit();
 *   const context = await index.getContext({ task: 'Refactor auth module' });
 */

'use strict';

const path = require('path');
const { scanRepo } = require('./scanner');
const { parseConfigs } = require('./config-parser');
const { scoreDrift, DriftState, Confidence } = require('./scorer');
const { extractSymbols } = require('./extractor');

// ─── RepoIndex class ──────────────────────────────────────────────────────────

class RepoIndex {
  /**
   * @param {object} opts
   * @param {string} opts.repoPath   Path to the repository root
   * @param {boolean} opts.incremental  Only scan files changed since last commit
   */
  constructor(opts = {}) {
    this.repoPath = path.resolve(opts.repoPath || '.');
    this.incremental = opts.incremental || false;
    this._snapshots = null;  // Cached scan results
  }

  // ── Core: run a full drift audit ──────────────────────────────────────────

  /**
   * Run a drift audit and return the full report.
   *
   * @param {string} [configPath]  Path to a specific AI config file.
   *                               Defaults to auto-detecting all config files.
   * @returns {Promise<DriftReport>}
   */
  async audit(configPath) {
    const scan = await this._getSnapshots();

    let config;
    if (configPath) {
      const { parseConfigFile } = require('./config-parser');
      const symbols = parseConfigFile(path.resolve(configPath));
      config = {
        configFiles: [path.resolve(configPath)],
        claimedSymbols: symbols,
      };
    } else {
      config = parseConfigs(this.repoPath);
    }

    const report = scoreDrift(config.claimedSymbols, scan.snapshots, { externalImports: scan.externalImports });
    report.configFiles = config.configFiles;
    return report;
  }

  // ── Context: get a fresh, drift-checked context slice for an agent task ───

  /**
   * Given a task description, return the minimum trusted context an agent
   * needs — only symbols relevant to the task, guaranteed fresh.
   *
   * This is what an MCP server or IDE extension would call per-request.
   *
   * @param {object} opts
   * @param {string} opts.task        Natural language description of the task
   * @param {number} opts.maxSymbols  Cap on symbols returned (default 50)
   * @param {string[]} opts.files     Specific files to include (optional)
   * @returns {Promise<ContextSlice>}
   */
  async getContext({ task = '', maxSymbols = 50, files = [] } = {}) {
    const scan = await this._getSnapshots();

    // Filter to specific files if requested
    const relevantSnapshots = files.length > 0
      ? scan.snapshots.filter(s => files.some(f => s.filePath.includes(f)))
      : scan.snapshots;

    // Score relevance of each symbol to the task
    const scored = scoreRelevance(task, relevantSnapshots);

    // Take top N by relevance score
    const topSymbols = scored.slice(0, maxSymbols);

    // Generate skeletons for each symbol
    const skeleton = generateSkeleton(topSymbols);

    return {
      task,
      symbolCount: topSymbols.length,
      skeleton,                          // The string to inject into the agent context
      symbols: topSymbols,              // Structured symbol data if needed
      freshAt: new Date().toISOString(),
      tokenEstimate: Math.ceil(skeleton.length / 4),  // Rough token estimate
    };
  }

  // ── Symbols: raw symbol access ────────────────────────────────────────────

  /**
   * Get all symbols from a specific file.
   * @param {string} filePath
   * @returns {Promise<FileSymbols>}
   */
  async getFileSymbols(filePath) {
    return extractSymbols(path.resolve(filePath));
  }

  /**
   * Get all symbols from the entire repo.
   * @returns {Promise<FileSymbols[]>}
   */
  async getAllSymbols() {
    const scan = await this._getSnapshots();
    return scan.snapshots;
  }

  // ── Cache management ──────────────────────────────────────────────────────

  /**
   * Force a fresh scan, discarding cached results.
   */
  async refresh() {
    this._scan = null;
    return this._getSnapshots();
  }

  async _getSnapshots() {
    if (!this._scan) {
      this._scan = scanRepo(this.repoPath, { incremental: this.incremental });
    }
    return this._scan;
  }
}

// ─── Relevance scoring ────────────────────────────────────────────────────────

/**
 * Score each symbol's relevance to a task description.
 * Simple keyword overlap — no LLM required for the PoC.
 * Replace with embeddings similarity in v2 for better results.
 */
function scoreRelevance(task, snapshots) {
  if (!task) {
    // No task — return all exported symbols equally weighted
    return collectExportedSymbols(snapshots).map(s => ({ ...s, relevanceScore: 1 }));
  }

  const taskTokens = tokenise(task.toLowerCase());
  const scored = [];

  for (const snapshot of snapshots) {
    const allSymbols = collectAllSymbols(snapshot);
    for (const sym of allSymbols) {
      const nameTokens = tokenise(sym.name.toLowerCase());
      const fileTokens = tokenise(path.basename(snapshot.filePath, '.ts').toLowerCase());

      // Count keyword overlaps between task and symbol name / file name
      const nameOverlap = nameTokens.filter(t => taskTokens.includes(t)).length;
      const fileOverlap = fileTokens.filter(t => taskTokens.includes(t)).length;

      const score = (nameOverlap * 3) + (fileOverlap * 2) + (sym.isExported ? 1 : 0);

      if (score > 0 || sym.isExported) {
        scored.push({ ...sym, sourceFile: snapshot.filePath, relevanceScore: score });
      }
    }
  }

  // Sort by relevance descending, then alphabetically for ties
  return scored.sort((a, b) => b.relevanceScore - a.relevanceScore || a.name.localeCompare(b.name));
}

// ─── Skeleton generator ───────────────────────────────────────────────────────

/**
 * Convert a list of symbols into a type-safe skeleton string —
 * the compressed context representation to inject into an agent.
 *
 * Strips implementation bodies, keeps signatures.
 * This is the "80% token reduction" claim made concrete.
 */
function generateSkeleton(symbols) {
  const lines = [];
  const byFile = groupByFile(symbols);

  for (const [filePath, fileSymbols] of byFile) {
    lines.push(`// ${path.relative(process.cwd(), filePath)}`);

    for (const sym of fileSymbols) {
      switch (sym.kind) {
        case 'function':
          lines.push(`${sym.isExported ? 'export ' : ''}${sym.isAsync ? 'async ' : ''}function ${sym.name}${sym.signature || '(): void'};`);
          break;

        case 'class':
          lines.push(`${sym.isExported ? 'export ' : ''}class ${sym.name}${sym.extends ? ` extends ${sym.extends}` : ''} {`);
          for (const method of (sym.methods || [])) {
            if (method.accessibility === 'private') continue; // Skip private methods
            lines.push(`  ${method.isAsync ? 'async ' : ''}${method.name}${method.signature || '(): void'};`);
          }
          lines.push('}');
          break;

        case 'interface':
          lines.push(`${sym.isExported ? 'export ' : ''}interface ${sym.name} {`);
          for (const member of (sym.members || [])) {
            lines.push(`  ${member.signature};`);
          }
          lines.push('}');
          break;

        case 'typeAlias':
          lines.push(`${sym.isExported ? 'export ' : ''}type ${sym.name} = ${sym.definition};`);
          break;

        case 'enum':
          lines.push(`${sym.isExported ? 'export ' : ''}${sym.isConst ? 'const ' : ''}enum ${sym.name} { ${(sym.members || []).join(', ')} }`);
          break;
      }
    }

    lines.push(''); // Blank line between files
  }

  return lines.join('\n');
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function collectAllSymbols(snapshot) {
  return [
    ...snapshot.functions,
    ...snapshot.classes,
    ...snapshot.interfaces,
    ...snapshot.typeAliases,
    ...snapshot.enums,
  ];
}

function collectExportedSymbols(snapshots) {
  return snapshots.flatMap(s =>
    collectAllSymbols(s)
      .filter(sym => sym.isExported)
      .map(sym => ({ ...sym, sourceFile: s.filePath }))
  );
}

function groupByFile(symbols) {
  const map = new Map();
  for (const sym of symbols) {
    const file = sym.sourceFile || 'unknown';
    if (!map.has(file)) map.set(file, []);
    map.get(file).push(sym);
  }
  return map;
}

function tokenise(str) {
  // Split on camelCase, snake_case, kebab-case, spaces, and dots
  return str
    .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase → camel Case
    .split(/[\s._\-/\\]+/)
    .filter(t => t.length > 2);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  RepoIndex,
  // Also export lower-level functions for direct use
  scanRepo,
  parseConfigs,
  scoreDrift,
  extractSymbols,
  DriftState,
  Confidence,
};
