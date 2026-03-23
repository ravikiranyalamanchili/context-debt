/**
 * scorer.js
 *
 * The drift scorer. Takes two inputs:
 *   1. The claimed symbols — what an AI config says about the codebase
 *   2. The actual symbols — what the AST found in the codebase today
 *
 * Produces a drift report: score 0–100, findings per symbol,
 * confidence on each finding, and a summary.
 */

'use strict';

const path = require('path');

// ─── Drift states ─────────────────────────────────────────────────────────────

const DriftState = {
  FRESH: 'fresh',           // Symbol exists, signature matches
  DRIFTED: 'drifted',       // Symbol exists but signature changed
  STALE: 'stale',           // Symbol not found anywhere in codebase
  MISSING: 'missing',       // Symbol exists in codebase but not in any AI config
};

const Confidence = {
  HIGH: 'high',             // Exact name match — very reliable finding
  MEDIUM: 'medium',         // Fuzzy match — possible rename or refactor
  LOW: 'low',               // Weak signal — don't surface unless asked
};

// ─── Main scorer ─────────────────────────────────────────────────────────────

/**
 * Score drift between what an AI config claims and what the AST says.
 *
 * @param {ClaimedSymbol[]} claimedSymbols  Parsed from .cursorrules / AI config
 * @param {FileSymbols[]}   astSnapshots    One per file, from extractor.js
 * @returns {DriftReport}
 */
function scoreDrift(claimedSymbols, astSnapshots, opts = {}) {
  const { externalImports = new Set() } = opts;

  // Flatten all actual symbols into a single lookup map
  // Key: symbol name (lowercased for fuzzy matching)
  // Value: array of ActualSymbol (same name can exist in multiple files)
  const actualByName = buildActualIndex(astSnapshots);

  const findings = [];

  for (const claimed of claimedSymbols) {
    const finding = assessSymbol(claimed, actualByName, externalImports);
    findings.push(finding);
  }

  // Also surface high-value symbols that exist in the codebase
  // but are completely absent from any AI config (MISSING state)
  const missingFindings = findMissingSymbols(claimedSymbols, astSnapshots);

  const allFindings = [...findings, ...missingFindings];

  return buildReport(claimedSymbols, allFindings, astSnapshots);
}

// ─── Per-symbol assessment ────────────────────────────────────────────────────

function assessSymbol(claimed, actualByName, externalImports = new Set()) {
  const exactKey = normaliseKey(claimed.name);
  const exactMatches = actualByName.get(exactKey) || [];

  // Case 1: Exact name match found
  if (exactMatches.length > 0) {
    const best = pickBestMatch(claimed, exactMatches);

    // Check if the signature has drifted — only when claimed has type annotations.
    // A bare signature like "(userId)" has no types, so we can't meaningfully diff.
    if (claimed.signature && best.signature && hasTypeAnnotations(claimed.signature)) {
      const sigMatch = signaturesMatch(claimed.signature, best.signature);
      if (!sigMatch) {
        return {
          state: DriftState.DRIFTED,
          confidence: Confidence.HIGH,
          claimed,
          actual: best,
          detail: `Signature changed: was "${claimed.signature}", now "${best.signature}"`,
        };
      }
    }

    return {
      state: DriftState.FRESH,
      confidence: Confidence.HIGH,
      claimed,
      actual: best,
      detail: null,
    };
  }

  // Case 2: No exact match — look for a fuzzy rename candidate
  const renameCandidate = findRenameCandidate(claimed, actualByName);
  if (renameCandidate) {
    return {
      state: DriftState.STALE,
      confidence: Confidence.MEDIUM,
      claimed,
      actual: renameCandidate,
      detail: `Possible rename: "${claimed.name}" → "${renameCandidate.name}" (similar signature)`,
    };
  }

  // Case 3: Completely gone — check if it's an external package symbol first
  if (externalImports.has(claimed.name)) {
    return {
      state: DriftState.STALE,
      confidence: Confidence.LOW,   // Low = filtered from default report view
      claimed,
      actual: null,
      detail: `"${claimed.name}" not found in local files — likely from a dependency`,
    };
  }

  return {
    state: DriftState.STALE,
    confidence: Confidence.HIGH,
    claimed,
    actual: null,
    detail: `"${claimed.name}" not found anywhere in the codebase`,
  };
}

// ─── Rename detection ─────────────────────────────────────────────────────────

/**
 * If a claimed symbol is missing, look for a symbol in the codebase with
 * a similar signature — strong signal that it was renamed.
 * Only returns HIGH or MEDIUM confidence candidates.
 */
function findRenameCandidate(claimed, actualByName) {
  if (!claimed.signature) return null;

  const normClaimed = normaliseSignature(claimed.signature);

  for (const [, actuals] of actualByName) {
    for (const actual of actuals) {
      if (!actual.signature) continue;
      const normActual = normaliseSignature(actual.signature);

      // Signatures are meaningfully similar — treat as rename
      const similarity = signatureSimilarity(normClaimed, normActual);
      if (similarity >= 0.75) {
        return actual;
      }
    }
  }

  return null;
}

// ─── Missing symbols (in codebase but not in any AI config) ──────────────────

/**
 * Find exported symbols that exist in the codebase but aren't
 * referenced in any AI config at all. These are the blind spots —
 * new functionality the AI agents don't know about.
 *
 * Only surfaces the most "important" ones: exported, public, non-trivial.
 */
function findMissingSymbols(claimedSymbols, astSnapshots) {
  const claimedNames = new Set(claimedSymbols.map(s => normaliseKey(s.name)));
  const seenMissing = new Set();
  const missing = [];

  for (const snapshot of astSnapshots) {
    const allSymbols = collectAllSymbols(snapshot);

    for (const sym of allSymbols) {
      if (!sym.isExported) continue;                        // Only care about exported symbols
      if (normaliseKey(sym.name).startsWith('_')) continue; // Skip private-convention symbols
      if (sym.name.length < 3) continue;                    // Skip trivially short names

      const key = normaliseKey(sym.name);
      if (claimedNames.has(key)) continue;
      if (seenMissing.has(key)) continue;                   // Deduplicate across files
      seenMissing.add(key);

      missing.push({
        state: DriftState.MISSING,
        confidence: Confidence.MEDIUM,
        claimed: null,
        actual: sym,
        detail: `"${sym.name}" exists in ${path.basename(snapshot.filePath)} but is absent from your AI config`,
      });
    }
  }

  // Cap missing findings at 10 — don't overwhelm the report on first audit
  return missing.slice(0, 10);
}

// ─── Report builder ───────────────────────────────────────────────────────────

function buildReport(claimedSymbols, findings, astSnapshots) {
  const stale = findings.filter(f => f.state === DriftState.STALE && f.confidence !== Confidence.LOW);
  const drifted = findings.filter(f => f.state === DriftState.DRIFTED && f.confidence !== Confidence.LOW);
  const missing = findings.filter(f => f.state === DriftState.MISSING);
  const fresh = findings.filter(f => f.state === DriftState.FRESH);

  const totalClaimed = claimedSymbols.length;
  const problemCount = stale.length + drifted.length;
  const driftScore = totalClaimed > 0
    ? Math.round((problemCount / totalClaimed) * 100)
    : 0;

  // Severity band
  let severity;
  if (driftScore === 0) severity = 'clean';
  else if (driftScore <= 15) severity = 'low';
  else if (driftScore <= 35) severity = 'degraded';
  else if (driftScore <= 60) severity = 'high';
  else severity = 'critical';

  return {
    driftScore,
    severity,
    summary: {
      totalClaimed,
      fresh: fresh.length,
      stale: stale.length,
      drifted: drifted.length,
      missing: missing.length,
      filesScanned: astSnapshots.length,
      totalSymbolsFound: astSnapshots.reduce((n, s) => n + collectAllSymbols(s).length, 0),
    },
    findings: {
      stale,
      drifted,
      missing,
      fresh,
    },
    generatedAt: new Date().toISOString(),
  };
}

// ─── Index builders ───────────────────────────────────────────────────────────

function buildActualIndex(astSnapshots) {
  const index = new Map();

  for (const snapshot of astSnapshots) {
    const allSymbols = collectAllSymbols(snapshot);
    for (const sym of allSymbols) {
      const key = normaliseKey(sym.name);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ ...sym, sourceFile: snapshot.filePath });
    }
  }

  return index;
}

function collectAllSymbols(snapshot) {
  const all = [];
  all.push(...snapshot.functions);
  all.push(...snapshot.interfaces);
  all.push(...snapshot.typeAliases);
  all.push(...snapshot.enums);

  for (const cls of snapshot.classes) {
    all.push(cls);
    all.push(...(cls.methods || []).map(m => ({
      ...m,
      name: `${cls.name}.${m.name}`,  // Qualify method names with class
      parentClass: cls.name,
    })));
  }

  return all;
}

function pickBestMatch(claimed, actuals) {
  // If only one match, use it
  if (actuals.length === 1) return actuals[0];

  // If claimed has a class context (UserService.createUser), prefer class-qualified
  if (claimed.name.includes('.')) {
    const [className] = claimed.name.split('.');
    const classMatch = actuals.find(a => a.parentClass === className);
    if (classMatch) return classMatch;
  }

  // Prefer exported symbols
  const exported = actuals.filter(a => a.isExported);
  if (exported.length > 0) return exported[0];

  return actuals[0];
}

// ─── Signature comparison ─────────────────────────────────────────────────────

function hasTypeAnnotations(sig) {
  // A signature has type info if it contains a colon (param types / return type)
  // or generic brackets. Bare sigs like "(userId, email)" have none.
  return sig.includes(':') || sig.includes('<') || sig.includes('=>');
}

function signaturesMatch(a, b) {
  return normaliseSignature(a) === normaliseSignature(b);
}

/**
 * Normalise a signature for comparison:
 * - Lowercase
 * - Remove whitespace
 * - Remove optional markers (?)
 * - Collapse generic params (they change too often to be reliable drift signal)
 */
function normaliseSignature(sig) {
  return sig
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\?/g, '')
    .replace(/<[^>]*>/g, '<>'); // Collapse generics
}

/**
 * Very simple token overlap similarity between two normalised signatures.
 * Used only for rename detection — not shown to users directly.
 */
function signatureSimilarity(a, b) {
  const tokensA = tokenise(a);
  const tokensB = tokenise(b);
  const setB = new Set(tokensB);
  const overlap = tokensA.filter(t => setB.has(t)).length;
  return overlap / Math.max(tokensA.length, tokensB.length, 1);
}

function tokenise(sig) {
  return sig.split(/[^a-z0-9]+/).filter(Boolean);
}

function normaliseKey(name) {
  // Strip class qualification for index lookup (UserService.createUser → createuser)
  const baseName = name.includes('.') ? name.split('.').pop() : name;
  return baseName.toLowerCase();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { scoreDrift, DriftState, Confidence };
