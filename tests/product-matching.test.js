const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadVoicePOS() {
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    window: {},
    document: { readyState: "loading", addEventListener() {} }
  };
  vm.createContext(sandbox);
  const root = path.resolve(__dirname, "..");
  vm.runInContext(fs.readFileSync(path.join(root, "product-identity.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "phonetic.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "content.js"), "utf8"), sandbox);
  return sandbox.window.VoicePOS;
}

const voicePOS = loadVoicePOS();

test("exact Zaart name has strong text similarity and a phonetic match", () => {
  const result = voicePOS.findBestProductMatch("zaart", ["Zaart"]);
  assert.equal(result.confident, true);
  assert.equal(result.rawNameSimilarity, 1);
  assert.equal(result.phoneticMatch, true);
});

test("plausible Zaart transcription variant receives a gated phonetic boost", () => {
  const result = voicePOS.findBestProductMatch("zort", ["Zaart"]);
  assert.equal(result.phoneticMatch, true);
  assert.equal(result.phoneticBonusApplied, true);
  assert.ok(result.rawNameSimilarity >= 0.5);
  assert.ok(result.effectiveNameSimilarity > result.rawNameSimilarity);
});

test("Inozart is not selected for zart merely because its strength matches", () => {
  const result = voicePOS.findBestProductMatch("zart 50mg", ["Inozart 50mg"]);
  assert.equal(result.strengthMatch, true);
  assert.ok(result.rawNameSimilarity < voicePOS.CONFIG.minimumNameSimilarity);
  assert.equal(result.confident, false);
});

test("Losacar exact name matching continues to work", () => {
  const result = voicePOS.findBestProductMatch("losacar", ["Losacar"]);
  assert.equal(result.confident, true);
  assert.equal(result.phoneticMatch, true);
});

test("an unrelated medicine with the same strength is rejected", () => {
  const result = voicePOS.findBestProductMatch("losacar 500mg", ["Panadol 500mg"]);
  assert.equal(result.strengthMatch, true);
  assert.equal(result.confident, false);
  assert.ok(result.rawNameSimilarity < voicePOS.CONFIG.minimumNameSimilarity);
});

test("phonetic matching never treats two empty codes as equal", () => {
  assert.equal(voicePOS.phoneticCodesMatch(["", ""], ["", ""]), false);
});

test('a lone Atorwa cannot become confident for Atorva through its phonetic bonus', () => {
  const result = voicePOS.findBestProductMatch('atorva 20mg', ['Atorwa 20mg']);
  assert.equal(result.phoneticMatch, true);
  assert.equal(result.confident, false);
  assert.ok(result.score < voicePOS.CONFIG.highConfidenceNameThreshold);
});

test('exact Atorva outranks its phonetic neighbour with a sufficient margin', () => {
  const result = voicePOS.findBestProductMatch('atorva 20mg', ['Atorwa 20mg', 'Atorva 20mg']);
  assert.equal(result.product, 'Atorva 20mg');
  assert.equal(result.confident, true);
});

test('long common prefixes never produce scores above one', () => {
  const result = voicePOS.findBestProductMatch('atorvastatin 20mg', ['Atorvastatinxyz 20mg']);
  assert.ok(result.score <= 1);
  assert.equal(result.confident, false);
});

test('decimal strengths survive quantity-first parsing', () => {
  const [item] = voicePOS.parseOrder('10 Sample 2.5mg.');
  assert.equal(item.quantity, 10);
  assert.equal(item.product, 'sample 2.5mg');
});

for (const [query, candidate] of [
  ['Sample 5ml', 'Sample 50ml'], ['Sample 2.5mg', 'Sample 2mg'],
  ['Sample 50mg', 'Sample 50mg/12.5mg'], ['Sample 5mg', 'Sample 5ml'],
  ['Sample 250mg/5ml', 'Sample 250mg/10ml']
]) test(`strict strength rejects ${query} versus ${candidate}`, () => {
  const result = voicePOS.findBestProductMatch(query, [candidate]);
  assert.equal(result.strengthMatch, false);
  assert.equal(result.confident, false);
});

test('matching decimals, units and complete combination strengths are accepted', () => {
  for (const [query, candidate] of [
    ['Sample 2.50 mg', 'Sample 2.5mg'], ['Sample 5 ml', 'Sample 5ml'],
    ['Sample 50mg/12.5mg', 'Sample 50mg/12.5mg'], ['Sample 50', 'Sample 50mg']
  ]) assert.equal(voicePOS.findBestProductMatch(query, [candidate]).confident, true);
});

test('leading decimal and alphanumeric product words are preserved', () => {
  const [item] = voicePOS.parseOrder('2 Sample B12 .5mg');
  assert.equal(item.product, 'sample b12 0.5mg');
  assert.equal(item.needsCorrection, false);
  assert.equal(voicePOS.findBestProductMatch(item.product, ['Sample B12 0.50mg']).confident, true);
});
