import assert from "node:assert";
import { test } from "node:test";

import {
  bytesLabel,
  confidenceLabel,
  distanceLabel,
  formatTime,
  msLabel,
  secondsLabel,
  stampFor,
} from "../src/format.js";

test("formatTime renders a clock time, not a locale surprise", () => {
  assert.equal(formatTime("2026-11-21T14:32:00Z"), "14:32");
  assert.equal(formatTime("not a date"), "—");
});

test("secondsLabel never goes negative", () => {
  assert.equal(secondsLabel(28), "28s");
  assert.equal(secondsLabel(-4), "0s");
  assert.equal(secondsLabel(undefined), "0s");
});

test("stampFor names every state the workflow can end in", () => {
  assert.equal(stampFor("approved"), "approved");
  assert.equal(stampFor("declined"), "declined");
  assert.equal(stampFor("expired"), "no answer");
  assert.equal(stampFor("pending_decision"), "awaiting signature");
});

test("confidenceLabel is a percentage", () => {
  assert.equal(confidenceLabel(0.86), "86%");
  assert.equal(confidenceLabel(Number.NaN), "—");
});

test("distanceLabel is honest when no face matched", () => {
  assert.equal(distanceLabel(0.31), "0.31");
  assert.equal(distanceLabel(null), "no match");
});

test("bytesLabel shows the audio size the workflow reported", () => {
  assert.equal(bytesLabel(88364), "88,364 bytes");
  assert.equal(bytesLabel(0), "—");
});

test("msLabel switches to seconds once a wait is long enough to feel", () => {
  assert.equal(msLabel(1062.7), "1.06 s");
  assert.equal(msLabel(257), "257 ms");
  assert.equal(msLabel(null), "—");
});
