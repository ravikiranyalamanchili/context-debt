/**
 * extractor.js
 *
 * Parses a TypeScript file using tree-sitter and extracts every
 * named symbol: functions, classes, methods, interfaces, type aliases,
 * and enums — each with its full signature.
 *
 * This is the foundation of the drift detector. Everything else in
 * Context Debt is built on top of what this file produces.
 */

'use strict';

const Parser = require('tree-sitter');
const TypeScript = require('tree-sitter-typescript').typescript;
const fs = require('fs');
const path = require('path');

// ─── Parser singleton ────────────────────────────────────────────────────────

const parser = new Parser();
parser.setLanguage(TypeScript);

// ─── Main extract function ───────────────────────────────────────────────────

/**
 * Extract all named symbols from a TypeScript source file.
 *
 * @param {string} filePath  Absolute or relative path to the .ts file
 * @returns {FileSymbols}    Structured symbol inventory for this file
 */
function extractSymbols(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const tree = parser.parse(source);

  const symbols = {
    filePath: path.resolve(filePath),
    functions: [],
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    externalImports: [],   // Names imported from non-local packages
    extractedAt: new Date().toISOString(),
  };

  walkNode(tree.rootNode, source, symbols, null);

  return symbols;
}

// ─── Tree walker ─────────────────────────────────────────────────────────────

/**
 * Recursively walks the AST, collecting symbols.
 * currentClass tracks whether we're inside a class body so
 * methods get attached to their parent class correctly.
 */
function walkNode(node, source, symbols, currentClass) {
  switch (node.type) {

    case 'function_declaration':
    case 'function_signature': {
      const fn = extractFunction(node, source);
      if (fn) symbols.functions.push(fn);
      break;
    }

    case 'class_declaration': {
      const cls = extractClass(node, source);
      if (cls) {
        symbols.classes.push(cls);
        // Walk children with this class as context so methods attach
        for (const child of node.children) {
          walkNode(child, source, symbols, cls);
        }
        return; // Already walked children — don't double-walk below
      }
      break;
    }

    case 'interface_declaration': {
      const iface = extractInterface(node, source);
      if (iface) symbols.interfaces.push(iface);
      break;
    }

    case 'type_alias_declaration': {
      const alias = extractTypeAlias(node, source);
      if (alias) symbols.typeAliases.push(alias);
      break;
    }

    case 'enum_declaration': {
      const enm = extractEnum(node, source);
      if (enm) symbols.enums.push(enm);
      break;
    }

    case 'method_definition':
    case 'method_signature':
    case 'public_field_definition': {
      // Method inside a class — attach to the current class
      if (currentClass) {
        const method = extractMethod(node, source);
        if (method) currentClass.methods.push(method);
      }
      break;
    }

    case 'import_statement': {
      const imports = extractExternalImports(node, source);
      symbols.externalImports.push(...imports);
      break;
    }

    case 'lexical_declaration':
    case 'variable_declaration': {
      // Catches: export const myFn = () => {} and export const myFn = async function() {}
      const arrowFns = extractArrowFunctions(node, source);
      symbols.functions.push(...arrowFns);
      break;
    }
  }

  // Walk all children for node types we didn't handle with early returns
  for (const child of node.children) {
    walkNode(child, source, symbols, currentClass);
  }
}

// ─── Symbol extractors ───────────────────────────────────────────────────────

function extractFunction(node, source) {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;

  return {
    kind: 'function',
    name: nameNode.text,
    signature: extractFunctionSignature(node, source),
    isExported: isExported(node),
    isAsync: hasChild(node, 'async'),
    line: node.startPosition.row + 1,
  };
}

function extractClass(node, source) {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;

  const heritage = extractHeritage(node, source);

  return {
    kind: 'class',
    name: nameNode.text,
    extends: heritage.extends,
    implements: heritage.implements,
    isExported: isExported(node),
    isAbstract: hasChild(node, 'abstract'),
    methods: [],   // Populated as walker descends into class body
    line: node.startPosition.row + 1,
  };
}

function extractMethod(node, source) {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;

  const accessibility = getAccessibility(node);

  return {
    kind: 'method',
    name: nameNode.text,
    signature: extractFunctionSignature(node, source),
    accessibility,                         // public / private / protected
    isStatic: hasChild(node, 'static'),
    isAsync: hasChild(node, 'async'),
    isAbstract: hasChild(node, 'abstract'),
    line: node.startPosition.row + 1,
  };
}

function extractInterface(node, source) {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;

  // Collect interface members (method signatures and property signatures)
  const members = [];
  const body = node.childForFieldName('body');
  if (body) {
    for (const child of body.children) {
      if (child.type === 'method_signature' || child.type === 'property_signature') {
        const memberName = child.childForFieldName('name');
        if (memberName) {
          members.push({
            name: memberName.text,
            signature: extractRawText(child, source).trim(),
            optional: hasChild(child, '?'),
          });
        }
      }
    }
  }

  return {
    kind: 'interface',
    name: nameNode.text,
    isExported: isExported(node),
    members,
    line: node.startPosition.row + 1,
  };
}

function extractTypeAlias(node, source) {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;

  const typeNode = node.childForFieldName('value');

  return {
    kind: 'typeAlias',
    name: nameNode.text,
    definition: typeNode ? extractRawText(typeNode, source).trim() : 'unknown',
    isExported: isExported(node),
    line: node.startPosition.row + 1,
  };
}

function extractEnum(node, source) {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;

  const members = [];
  const body = node.childForFieldName('body');
  if (body) {
    for (const child of body.children) {
      if (child.type === 'enum_assignment' || child.type === 'property_identifier') {
        members.push(child.text);
      }
    }
  }

  return {
    kind: 'enum',
    name: nameNode.text,
    isExported: isExported(node),
    isConst: hasChild(node, 'const'),
    members,
    line: node.startPosition.row + 1,
  };
}

function extractArrowFunctions(node, source) {
  const results = [];

  for (const declarator of node.children) {
    if (declarator.type !== 'variable_declarator') continue;

    const nameNode = declarator.childForFieldName('name');
    const valueNode = declarator.childForFieldName('value');

    if (!nameNode || !valueNode) continue;

    const isArrow = valueNode.type === 'arrow_function';
    const isFunc = valueNode.type === 'function' || valueNode.type === 'function_expression';

    if (!isArrow && !isFunc) continue;

    results.push({
      kind: 'function',
      name: nameNode.text,
      signature: `${nameNode.text}${extractFunctionSignature(valueNode, source)}`,
      isExported: isExported(node),
      isAsync: hasChild(valueNode, 'async'),
      isArrow,
      line: node.startPosition.row + 1,
    });
  }

  return results;
}

// ─── Signature helpers ───────────────────────────────────────────────────────

/**
 * Extracts the type-safe signature of a function/method/arrow:
 * (param: Type, param2: Type): ReturnType
 *
 * Drops the body entirely — this is the skeleton output.
 */
function extractFunctionSignature(node, source) {
  const params = node.childForFieldName('parameters') || node.childForFieldName('formal_parameters');
  const returnType = node.childForFieldName('return_type');
  const typeParams = node.childForFieldName('type_parameters');

  const typeParamsStr = typeParams ? extractRawText(typeParams, source) : '';
  const paramsStr = params ? extractRawText(params, source) : '()';
  const returnStr = returnType ? `: ${extractRawText(returnType, source).replace(/^:\s*/, '')}` : '';

  return `${typeParamsStr}${paramsStr}${returnStr}`;
}

function extractHeritage(node, source) {
  let extendsClause = null;
  const implementsClauses = [];

  for (const child of node.children) {
    if (child.type === 'class_heritage') {
      for (const heritageChild of child.children) {
        if (heritageChild.type === 'extends_clause') {
          extendsClause = extractRawText(heritageChild, source)
            .replace(/^extends\s+/, '').trim();
        }
        if (heritageChild.type === 'implements_clause') {
          implementsClauses.push(
            extractRawText(heritageChild, source)
              .replace(/^implements\s+/, '').trim()
          );
        }
      }
    }
  }

  return { extends: extendsClause, implements: implementsClauses };
}

function getAccessibility(node) {
  for (const child of node.children) {
    if (child.type === 'accessibility_modifier') {
      return child.text; // 'public', 'private', 'protected'
    }
  }
  return 'public'; // TypeScript default
}

// ─── Utility helpers ─────────────────────────────────────────────────────────

function isExported(node) {
  // Check if the node itself or its parent has an export keyword
  if (node.parent && node.parent.type === 'export_statement') return true;
  for (const child of node.children) {
    if (child.type === 'export') return true;
  }
  return false;
}

function hasChild(node, type) {
  return node.children.some(c => c.type === type);
}

function extractRawText(node, source) {
  return source.slice(node.startIndex, node.endIndex);
}

// ─── External import extraction ──────────────────────────────────────────────

/**
 * Collect names imported from external packages (non-relative imports).
 * Called during the same tree-sitter parse as symbol extraction — no extra I/O.
 *
 * import { createTRPCRouter } from '@trpc/server'  →  ['createTRPCRouter']
 * import { z } from 'zod'                          →  ['z']
 * import React from 'react'                        →  ['React']
 */
function extractExternalImports(node, source) {
  const sourceNode = node.children.find(c => c.type === 'string');
  if (!sourceNode) return [];

  const modulePath = sourceNode.text.replace(/['"]/g, '');
  // Skip relative and absolute local imports
  if (modulePath.startsWith('.') || modulePath.startsWith('/')) return [];

  const names = [];
  const importClause = node.children.find(c => c.type === 'import_clause');
  if (!importClause) return names;

  for (const child of importClause.children) {
    if (child.type === 'identifier') {
      // Default import: import React from 'react'
      names.push(child.text);
    } else if (child.type === 'named_imports') {
      // Named imports: import { Foo, Bar as Baz } from 'pkg'
      for (const spec of child.children) {
        if (spec.type === 'import_specifier') {
          const nameNode = spec.childForFieldName('name');
          if (nameNode) names.push(nameNode.text);
        }
      }
    }
  }

  return names;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = { extractSymbols };
