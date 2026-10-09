import test from "node:test";
import assert from "node:assert/strict";
import { LanguageEvidence } from "../src/content/language-evidence";

const confirm = (
  evidence: LanguageEvidence,
  language = "vi",
): string | null => {
  assert.equal(evidence.observe(language, 0.9, true), null);
  assert.equal(evidence.observe(language, 0.9, true), null);
  return evidence.observe(language, 0.9, true);
};

test("three consecutive confident voiced samples confirm a language", () => {
  assert.equal(confirm(new LanguageEvidence()), "vi");
});

test("silence neither triggers a notice nor erases speech evidence", () => {
  const evidence = new LanguageEvidence();
  for (let i = 0; i < 20; i++)
    assert.equal(evidence.observe("vi", 0.99, false), null);
  assert.equal(evidence.observe("vi", 0.9, true), null);
  assert.equal(evidence.observe("en", 0.99, false), null);
  assert.equal(evidence.observe("vi", 0.9, true), null);
  assert.equal(evidence.observe("vi", 0.1, false), null);
  assert.equal(evidence.observe("vi", 0.9, true), "vi");
});

test("English speech resets the non-English candidate", () => {
  const evidence = new LanguageEvidence();
  evidence.observe("vi", 0.9, true);
  evidence.observe("vi", 0.9, true);
  assert.equal(evidence.observe("en", 0.9, true), null);
  assert.equal(confirm(evidence), "vi");
});

test("a changed candidate starts a new confirmation sequence", () => {
  const evidence = new LanguageEvidence();
  evidence.observe("vi", 0.9, true);
  evidence.observe("vi", 0.9, true);
  assert.equal(confirm(evidence, "ja"), "ja");
});

test("weak voiced evidence cannot combine separated confident samples", () => {
  const evidence = new LanguageEvidence();
  evidence.observe("vi", 0.9, true);
  evidence.observe("vi", 0.9, true);
  assert.equal(evidence.observe("vi", 0.79, true), null);
  assert.equal(confirm(evidence), "vi");
});

for (const probability of [NaN, Infinity, -1, 1.01]) {
  test(`invalid probability ${probability} resets evidence`, () => {
    const evidence = new LanguageEvidence();
    evidence.observe("vi", 0.9, true);
    evidence.observe("vi", 0.9, true);
    assert.equal(evidence.observe("vi", probability, true), null);
    assert.equal(confirm(evidence), "vi");
  });
}

test("reset discards evidence from the previous source", () => {
  const evidence = new LanguageEvidence();
  evidence.observe("vi", 0.9, true);
  evidence.observe("vi", 0.9, true);
  evidence.reset();
  assert.equal(confirm(evidence, "ko"), "ko");
});

test("invalid language codes cannot trigger notices", () => {
  for (const language of ["", "english", "en-US", "<script>"]) {
    const evidence = new LanguageEvidence();
    for (let i = 0; i < 5; i++)
      assert.equal(evidence.observe(language, 0.99, true), null);
  }
});
