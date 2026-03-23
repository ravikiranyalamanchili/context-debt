# Context Debt — Project Context for Claude Code

## What this project is

Context Debt is an AST-native drift detector for AI coding tools. It solves one specific problem: AI agents (Cursor, Copilot, Claude Code) operate on a snapshot of a codebase that was built at a point in time. As the codebase changes, that snapshot goes stale. Agents then hallucinate — calling renamed functions, referencing deleted interfaces, missing new exports. We call this **Context Drift**.

The product parses the actual TypeScript AST of a repository and compares it against whatever AI config files exist (.cursorrules, CLAUDE.md, copilot-instructions.md). It produces a **drift score** — the percentage of claimed symbols that are stale, renamed, or deleted — and a list of specific findings.

This is the v0.1.0 release. The goal is to produce a real drift score on real TypeScript repos.

---

## Architecture — how the files connect

```
cli.js
  └── calls scanner.js      → walks the repo, finds all .ts files
  └── calls config-parser.js → reads .cursorrules / CLAUDE.md / etc
  └── calls scorer.js        → compares claimed vs actual symbols
        └── uses extractor.js (called by scanner.js per file)

index.js
  └── public SDK wrapper (RepoIndex class)
  └── wraps all of the above into a clean API
  └── also contains: skeleton generator, relevance scorer
```

**Data flow:**

1. `config-parser.js` reads AI config files → produces `ClaimedSymbol[]`
2. `scanner.js` walks the repo → calls `extractor.js` per file → produces `FileSymbols[]`
3. `scorer.js` compares the two → produces `DriftReport`
4. `cli.js` prints the report to the terminal

---

## File responsibilities

### `src/extractor.js`
- Uses **tree-sitter** + **tree-sitter-typescript** to parse `.ts` files
- Extracts: functions, classes (with methods), interfaces, type aliases, enums
- Each symbol gets: name, signature (params + return type), isExported, line number
- Does NOT use an LLM — purely deterministic AST traversal
- Key function: `extractSymbols(filePath)` → returns `FileSymbols`

### `src/config-parser.js`
- Reads AI config files: `.cursorrules`, `CLAUDE.md`, `.github/copilot-instructions.md`, etc.
- Uses regex patterns to extract symbol references from free-form text
- Intentionally conservative — errs toward precision over recall
- Handles markdown code blocks separately (higher confidence than prose)
- Key function: `parseConfigs(repoRoot)` → returns `{ configFiles, claimedSymbols }`

### `src/scorer.js`
- Compares `ClaimedSymbol[]` against `FileSymbols[]`
- Three states per symbol: FRESH (exact match), DRIFTED (signature changed), STALE (not found)
- Also surfaces MISSING symbols: exported but absent from all AI configs
- Rename detection: if a claimed symbol is gone but a similar signature exists elsewhere, flags it as a possible rename with MEDIUM confidence
- Key function: `scoreDrift(claimedSymbols, astSnapshots)` → returns `DriftReport`

### `src/scanner.js`
- Walks a directory recursively, skips: node_modules, dist, .git, build, .next, etc.
- Calls `extractSymbols` per file, recovers gracefully from parse errors
- Supports incremental mode: only re-parses files changed since last git commit
- Key function: `scanRepo(repoRoot, opts)` → returns `{ snapshots, filesScanned, errors }`

### `src/cli.js`
- Entry point for `npx context-debt audit [path]`
- Orchestrates scanner → config-parser → scorer → formatted terminal output
- Colour-coded output: green (fresh), red (stale), yellow (drifted), cyan (missing)
- No dependencies beyond the other src files

### `src/index.js`
- Public SDK surface: `RepoIndex` class
- `index.audit()` — runs full drift audit, returns DriftReport
- `index.getContext({ task })` — returns a freshness-guaranteed context slice for an agent task
- `index.getFileSymbols(filePath)` — raw symbol access for a single file
- Also contains: skeleton generator (strips function bodies, keeps signatures), relevance scorer (keyword overlap between task description and symbol names)

---

## Key concepts to keep in mind

**Why AST and not text/RAG:**
AST parsing is deterministic — if `UserService.createUser` was renamed to `AuthService.registerUser`, the AST knows this with certainty. Text-based approaches (RAG, vector search, LLM summarisation) would approximate it. Our drift score is a hard fact, not a probability.

**Why local-first matters:**
Enterprise customers will not send their code to a third-party server. All AST parsing must happen on the customer's machine. The SDK is designed to run entirely locally. Cloud features (dashboard, cross-repo graph) are opt-in only and only receive aggregated metadata, never source code.

**Why precision over recall:**
A false positive (flagging a symbol as stale when it isn't) destroys trust immediately. We only surface findings we're highly confident about. The `confidence` field on each finding is HIGH / MEDIUM / LOW — the CLI only shows HIGH and MEDIUM by default.

**The skeleton generator:**
`index.js` contains a function that takes a list of symbols and generates a TypeScript skeleton — function signatures and type definitions with bodies stripped. This is the "80% token reduction" claim. A 500-line class becomes a 20-line skeleton. Used by `getContext()` to produce compressed, freshness-guaranteed context for agents.

---

## Known limitations of the PoC

- **TypeScript only** right now. Python and Go are next (tree-sitter grammars exist for both).
- **Monorepo support is partial.** Path aliases (e.g. `@/components/...`) are not yet resolved. Barrel file re-exports (index.ts re-exporting from 10 files) may cause symbols to appear duplicated.
- **Config parser is heuristic.** It uses regex on free-form text. It will miss some references and occasionally flag noise. Treat it as 80% recall, 90% precision.
- **No caching to disk yet.** The AST scan results are cached in memory per `RepoIndex` instance but not persisted. Large repos (2000+ files) will re-scan on every run.
- **Relevance scoring is keyword overlap.** The `getContext()` method scores relevance by matching task description tokens against symbol names. This works fine for explicit task descriptions ("refactor the auth module") but is naive for vague ones. Replace with embeddings in v2.

---

## How to run

```bash
# Install dependencies (one time)
npm install

# Run a drift audit on the current directory
node src/cli.js audit .

# Run on a specific repo
node src/cli.js audit /path/to/typescript/repo

# Use the SDK programmatically
const { RepoIndex } = require('./src/index');
const index = new RepoIndex({ repoPath: '/path/to/repo' });
const report = await index.audit();
console.log(report.driftScore); // e.g. 34
```

---

## What to work on next (priority order)

1. **Test on real repos** — clone tRPC, Prisma, or create-t3-app. Run the audit. Record the drift scores. This is the demo.
2. **Fix monorepo path alias resolution** — parse `tsconfig.json` `paths` field and resolve aliases before extracting symbols.
3. **Handle barrel file re-exports** — detect `export * from './user'` patterns and deduplicate symbols that appear through multiple re-export chains.
4. **Add disk caching** — write AST snapshots to `.context-debt/cache/` so large repos don't re-scan from scratch every run.
5. **Python support** — add `tree-sitter-python`, handle dynamic typing (no explicit type annotations, so extract docstrings and default values instead).
6. **MCP server wrapper** — expose `audit_drift` and `get_repo_context` as MCP tools so any MCP-compatible agent can call them natively.

---

## What NOT to do

- Do not add an LLM to the core drift detection pipeline. The value of this tool is determinism — a score that is provably correct, not probabilistically estimated.
- Do not send source code to any external API without explicit user consent.
- Do not add dependencies without a strong reason. The fewer dependencies, the easier the enterprise security review.
- Do not change the public API surface of `RepoIndex` without updating this file.

---

## Dependencies

- `tree-sitter` — C-based parser framework with Node.js bindings
- `tree-sitter-typescript` — TypeScript grammar for tree-sitter
- No other runtime dependencies. Keep it that way for now.
