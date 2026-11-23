import assert from "node:assert/strict";
import { test } from "node:test";
import { posterLines } from "../app/features/item/poster-client.ts";

test("poster text wraps CJK, Latin and supplementary characters at the measured width", () => {
  const value = "测试 title 😀 与 mixed words", measure = (text: string) => [...text].reduce((n, c) => n + (/[a-z ]/.test(c) ? 1 : 2), 0);
  const lines = posterLines(value, 10, measure);
  assert.equal(lines.join(""), value);
  assert.ok(lines.every((line) => measure(line) <= 10));
  assert.ok(lines.every((line) => !/[\uD800-\uDFFF]/u.test(line)));
  assert.deepEqual(posterLines("", 10, measure), []);
});
