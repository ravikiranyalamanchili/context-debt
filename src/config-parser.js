/**
 * config-parser.js
 *
 * Extracts "claimed" symbols from AI config files:
 *   - .cursorrules
 *   - CLAUDE.md
 *   - .github/copilot-instructions.md
 *   - Any plain text system prompt file
 *
 * These are the symbols the AI config *claims* to know about.
 * We compare them against the AST to find drift.
 *
 * This is intentionally heuristic — we're doing NLP-lite on
 * free-form text, so we err on the side of precision over recall.
 * Better to miss a reference than to generate false positives.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Supported config file names ─────────────────────────────────────────────

const CONFIG_FILE_NAMES = [
  '.cursorrules',
  'CLAUDE.md',
  '.claude',
  '.github/copilot-instructions.md',
  'copilot-instructions.md',
  '.ai-context',
  'AI_CONTEXT.md',
  'AGENTS.md',
];

// ─── Patterns that identify symbol references in config text ─────────────────

// Matches: functionName(), MyClass.method(), service.doThing()
const FUNCTION_CALL_PATTERN = /\b([A-Z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9]{2,})\s*\(/g;

// Matches: MyClassName, UserService, PaymentProcessor (PascalCase identifiers)
const CLASS_NAME_PATTERN = /\b([A-Z][a-zA-Z0-9]{2,})\b/g;

// Matches: TypeName, InterfaceName used after : or implements or extends
const TYPE_ANNOTATION_PATTERN = /(?::\s*|implements\s+|extends\s+|<)([A-Z][a-zA-Z0-9]{2,})(?:[,>\s]|$)/g;

// Matches: `functionName` or `ClassName.method` in backtick code spans
const BACKTICK_SYMBOL_PATTERN = /`([a-zA-Z][a-zA-Z0-9.]{2,})`/g;

// Matches explicit "use X", "call X", "the X function/method/class/interface"
const EXPLICIT_REF_PATTERN = /\b(?:use|call|invoke|import|from|the)\s+[`"]?([a-zA-Z][a-zA-Z0-9.]{2,})[`"]?\s*(?:function|method|class|interface|type|hook|service|util|helper)?/gi;

// ─── Noise filters ────────────────────────────────────────────────────────────

// Common English words that look like symbols but aren't
const NOISE_WORDS = new Set([
  // Pronouns / articles / conjunctions
  'The', 'This', 'That', 'When', 'Where', 'What', 'With', 'From',
  'Into', 'Upon', 'Over', 'Under', 'After', 'Before', 'Since',
  // Common imperative / instructional verbs (frequent in AI config prose)
  'Use', 'Call', 'Import', 'Export', 'Always', 'Never', 'Avoid',
  'Make', 'Keep', 'Note', 'Ensure', 'Check', 'Handle', 'Return',
  // English words that look like symbols but aren't code
  'initialises', 'initializes', 'returns', 'creates', 'handles',
  // Standalone structural words unlikely to be a real symbol name
  'Module', 'Old', 'New', 'And', 'For',
  // JS built-ins and primitive types
  'True', 'False', 'Null', 'None', 'Undefined',
  'String', 'Number', 'Boolean', 'Object', 'Array', 'Promise',
  'Error', 'Date', 'Math', 'JSON', 'URL', 'Map', 'Set',
  // Common framework / runtime names (not local symbols)
  'API', 'HTTP', 'HTML', 'CSS', 'DOM',
  'Node', 'React', 'Next', 'Vue', 'Angular', 'Express', 'Fastify',
  // Package managers and CLI tools
  'pnpm', 'yarn', 'npm', 'npx', 'bun', 'node', 'deno',
  // File and directory names
  'src', 'dist', 'build', 'out', 'lib', 'bin', 'scripts',
  // Config file names (appear in prose constantly)
  'CLAUDE', 'AGENTS', 'GEMINI', 'README', 'LICENSE', 'CHANGELOG',
  // Common prose words that slip through
  'server', 'client', 'providers', 'guards', 'components',
  'services', 'modules', 'controllers', 'middleware', 'utils',
  'helpers', 'hooks', 'types', 'interfaces', 'models', 'schemas',
  'existing', 'following', 'above', 'below', 'current', 'previous',
  'production', 'development', 'staging', 'testing',
]);

// ─── Main parser ──────────────────────────────────────────────────────────────

/**
 * Find and parse all AI config files in a repo directory.
 *
 * @param {string} repoRoot  Path to the root of the repository
 * @returns {ParsedConfig}
 */
function parseConfigs(repoRoot) {
  const foundFiles = [];
  const claimed = [];
  const seenNames = new Set();

  for (const fileName of CONFIG_FILE_NAMES) {
    const fullPath = path.join(repoRoot, fileName);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      foundFiles.push(fullPath);
      const symbols = parseConfigFile(fullPath);

      for (const sym of symbols) {
        // Deduplicate by name
        if (!seenNames.has(sym.name)) {
          seenNames.add(sym.name);
          claimed.push({ ...sym, sourceFile: fullPath });
        }
      }
    }
  }

  return {
    configFiles: foundFiles,
    claimedSymbols: claimed,
  };
}

/**
 * Parse a single config file and extract all symbol references.
 *
 * @param {string} filePath
 * @returns {ClaimedSymbol[]}
 */
function parseConfigFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lineCount = content.split('\n').length;
  const symbols = new Map(); // name → ClaimedSymbol

  const { prose, codeBlocks } = separateCodeBlocks(content);

  // Large config files (>100 lines) are overwhelmingly narrative text.
  // Only trust backtick spans and code blocks — prose extraction generates
  // too many false positives in long architectural documents.
  if (lineCount > 100) {
    extractWithPattern(prose, BACKTICK_SYMBOL_PATTERN, symbols, 'prose', 'high');
  } else {
    extractFromProse(prose, symbols, 'prose');
  }

  for (const block of codeBlocks) {
    extractFromCode(block, symbols, 'code');
  }

  return [...symbols.values()];
}

// ─── Extraction from prose ────────────────────────────────────────────────────

function extractFromProse(text, symbols, source) {
  // Backtick spans are the highest-signal references in prose
  extractWithPattern(text, BACKTICK_SYMBOL_PATTERN, symbols, source, 'high');

  // Explicit "use X" / "call X" references
  extractWithPattern(text, EXPLICIT_REF_PATTERN, symbols, source, 'medium');

  // Function call patterns: functionName(
  extractWithPattern(text, FUNCTION_CALL_PATTERN, symbols, source, 'medium');

  // Type annotations after colons
  extractWithPattern(text, TYPE_ANNOTATION_PATTERN, symbols, source, 'low');

  // PascalCase identifiers (classes, interfaces) — lower confidence in prose
  extractWithPattern(text, CLASS_NAME_PATTERN, symbols, source, 'low');
}

// ─── Extraction from code blocks ──────────────────────────────────────────────

function extractFromCode(code, symbols, source) {
  // In code blocks, function calls and type references are high confidence
  extractWithPattern(code, FUNCTION_CALL_PATTERN, symbols, source, 'high');
  extractWithPattern(code, TYPE_ANNOTATION_PATTERN, symbols, source, 'high');
  extractWithPattern(code, CLASS_NAME_PATTERN, symbols, source, 'high');

  // Also extract import paths: import { X } from '...'
  const importPattern = /import\s*\{([^}]+)\}/g;
  let match;
  while ((match = importPattern.exec(code)) !== null) {
    const imports = match[1].split(',').map(s => s.trim().split(' as ')[0].trim());
    for (const imp of imports) {
      if (isValidSymbolName(imp)) {
        upsertSymbol(symbols, imp, null, source, 'high');
      }
    }
  }
}

// ─── Pattern extractor ────────────────────────────────────────────────────────

function extractWithPattern(text, pattern, symbols, source, confidence) {
  // Reset lastIndex since we reuse compiled patterns
  pattern.lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const rawName = match[1];
    if (!rawName || !isValidSymbolName(rawName)) continue;

    // Try to extract a signature hint if followed by parameters
    const afterMatch = text.slice(match.index + match[0].length);
    const sig = tryExtractSignature(rawName, afterMatch);

    upsertSymbol(symbols, rawName, sig, source, confidence);
  }
}

// ─── Signature hint extraction ────────────────────────────────────────────────

/**
 * If a symbol reference is followed by a parameter list, capture it as
 * a signature hint. This improves drift detection accuracy.
 *
 * e.g. "createUser(payload: UserInput)" → signature: "(payload: UserInput)"
 */
function tryExtractSignature(name, textAfter) {
  if (!textAfter.startsWith('(')) return null;

  let depth = 0;
  let i = 0;
  for (; i < Math.min(textAfter.length, 200); i++) {
    if (textAfter[i] === '(') depth++;
    else if (textAfter[i] === ')') {
      depth--;
      if (depth === 0) return textAfter.slice(0, i + 1);
    }
  }

  return null;
}

// ─── Symbol validation ────────────────────────────────────────────────────────

function isValidSymbolName(name) {
  if (!name || name.length < 3 || name.length > 80) return false;
  if (NOISE_WORDS.has(name)) return false;
  if (/^\d/.test(name)) return false;           // Starts with a digit
  if (/^[A-Z]{2,}$/.test(name)) return false;  // All-caps acronym (HTTP, API, CSS)
  if (name.endsWith('.')) return false;         // Trailing dot — not a valid symbol
  if (/\.(md|js|ts|json|yaml|yml|txt|sh)$/i.test(name)) return false; // File names
  if (name.split('.').length > 3) return false; // Too many dots
  // Dotted names must start with PascalCase (e.g. UserService.create)
  // Filter out instance method chains like prisma.user.findUnique, db.query
  if (name.includes('.') && /^[a-z]/.test(name)) return false;
  // Reject plain lowercase words — "following", "existing", "server" etc.
  // Real TypeScript symbols are camelCase, PascalCase, or contain dots/underscores
  if (/^[a-z][a-z]+$/.test(name)) return false;
  return true;
}

// ─── Map helpers ──────────────────────────────────────────────────────────────

function upsertSymbol(symbols, name, signature, source, confidence) {
  const existing = symbols.get(name);

  // If we already have this symbol, upgrade confidence if new finding is stronger
  const confidenceRank = { high: 3, medium: 2, low: 1 };
  if (existing) {
    if (confidenceRank[confidence] > confidenceRank[existing.confidence]) {
      existing.confidence = confidence;
    }
    if (!existing.signature && signature) {
      existing.signature = signature;
    }
    return;
  }

  symbols.set(name, { name, signature, source, confidence, kind: inferKind(name) });
}

function inferKind(name) {
  if (name.includes('.')) return 'method';
  if (/^[A-Z]/.test(name)) return 'class_or_interface';
  return 'function';
}

// ─── Code block separator ─────────────────────────────────────────────────────

function separateCodeBlocks(content) {
  const codeBlocks = [];
  const prose = content.replace(/```[\s\S]*?```/g, (block) => {
    // Strip the fence and language tag
    const code = block.replace(/^```\w*\n?/, '').replace(/```$/, '');
    codeBlocks.push(code);
    return ' '; // Replace with space so surrounding prose stays connected
  });

  return { prose, codeBlocks };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { parseConfigs, parseConfigFile, CONFIG_FILE_NAMES };
