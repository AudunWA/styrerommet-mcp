import test from "node:test";
import assert from "node:assert/strict";
import { decodeQueryText } from "./registry.ts";

test("query decoding handles extracted escapes without decoding their output again", () => {
  assert.equal(decodeQueryText(String.raw`line\n\t\"value\"`), 'line\n  "value"');
  assert.equal(decodeQueryText(String.raw`\\\"`), '\\"');
  assert.equal(decodeQueryText(String.raw`\\n`), String.raw`\n`);
  assert.equal(decodeQueryText(String.raw`\q`), String.raw`\q`);
});
