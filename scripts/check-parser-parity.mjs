/**
 * Parity check: the parser copy in tests/reply.test.mjs must match the real one
 * in src/providers/llm.js.
 *
 * The test file inlines the parser so it does not have to pull in the fetch layer
 * and a React Native resolution context just to test a string function. That
 * duplication is a drift risk, and this parser is the gate that decides whether
 * an untrusted model response is allowed to produce a navigation action — so
 * drift here is a safety bug, not a cosmetic one.
 *
 * This script compares the two function bodies ignoring comments and whitespace,
 * and exits non-zero if they diverge.
 *
 * Run:  node scripts/check-parser-parity.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** Pull `function parseReply(...) { ... }` out of a source file by brace walking. */
function extractParser(source, label) {
  const start = source.indexOf('function parseReply(');
  assert.notEqual(start, -1, `could not find parseReply in ${label}`);

  let depth = 0;
  let i = source.indexOf('{', start);
  assert.notEqual(i, -1, `could not find body of parseReply in ${label}`);

  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }

  return source.slice(start, i);
}

/** Strip comments and collapse all whitespace so only behaviour is compared. */
function normalise(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const appSource = readFileSync(join(root, 'src/providers/llm.js'), 'utf8');
const testSource = readFileSync(join(root, 'tests/reply.test.mjs'), 'utf8');

const appParser = normalise(extractParser(appSource, 'src/providers/llm.js'));
const testParser = normalise(extractParser(testSource, 'tests/reply.test.mjs'));

if (appParser !== testParser) {
  console.error('parseReply has DRIFTED between the app and its test copy.\n');
  console.error('--- src/providers/llm.js ---\n' + appParser + '\n');
  console.error('--- tests/reply.test.mjs ---\n' + testParser + '\n');
  console.error('Update tests/reply.test.mjs to match, then re-run.');
  process.exit(1);
}

console.log(`parseReply parity OK (${appParser.length} chars, comments ignored)`);
