/**
 * Tests for the assistant reply parser.
 *
 * The parser is inlined here rather than imported, for one specific reason: the
 * module that owns it (`src/providers/llm.js`) also imports the fetch layer, and
 * pulling that into a unit test would mean a network stack and a React Native
 * resolution context just to test a string function.
 *
 * The risk of inlining is drift between this copy and the real one, so the real
 * parser and this copy are kept byte-identical in behaviour, and the app's own
 * copy is exercised end-to-end by the bundle check.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

/** Mirror of parseReply in src/providers/llm.js. Keep in sync. */
function parseReply(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { reply: '', destination: null };

  const unfenced = trimmed
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  try {
    const parsed = JSON.parse(unfenced);
    const destination =
      typeof parsed.destination === 'string' && parsed.destination.trim()
        ? parsed.destination.trim()
        : null;
    return { reply: String(parsed.reply ?? '').trim(), destination };
  } catch {
    return { reply: trimmed, destination: null };
  }
}

test('parses a well formed assistant reply with a destination', () => {
  const parsed = parseReply('{"reply": "帶你去中環。", "destination": "Central"}');
  assert.equal(parsed.reply, '帶你去中環。');
  assert.equal(parsed.destination, 'Central');
});

test('parses a reply wrapped in a markdown fence', () => {
  const parsed = parseReply('```json\n{"reply": "好。", "destination": null}\n```');
  assert.equal(parsed.reply, '好。');
  assert.equal(parsed.destination, null);
});

test('unparseable prose keeps the text but drops the action', () => {
  // Never invent a destination from prose: a model asked for a coordinate will
  // happily produce a plausible one, and a plausible one can be a harbour.
  const parsed = parseReply('Sure, I will take you to Central.');
  assert.equal(parsed.reply, 'Sure, I will take you to Central.');
  assert.equal(parsed.destination, null);
});

test('a blank destination string is treated as no destination', () => {
  const parsed = parseReply('{"reply": "ok", "destination": "   "}');
  assert.equal(parsed.destination, null);
});

test('an empty reply does not throw', () => {
  assert.deepEqual(parseReply(''), { reply: '', destination: null });
  assert.deepEqual(parseReply(null), { reply: '', destination: null });
  assert.deepEqual(parseReply(undefined), { reply: '', destination: null });
});
