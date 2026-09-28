const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function loadSearch(results) {
  let now = 0;
  let query = null;
  let submittedAt = 0;
  class Input {
    get value() { return this.current || ''; }
    set value(value) { this.current = value; }
    dispatchEvent(event) {
      if (event.type === 'keyup') { query = this.value; submittedAt = now; }
    }
  }
  class Event { constructor(type) { this.type = type; } }
  const sandbox = {
    console: { log() {}, info() {}, warn() {} }, window: {},
    document: { readyState: 'loading', addEventListener() {}, querySelectorAll() { return results(query, now - submittedAt); } },
    HTMLInputElement: Input, HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, Event, KeyboardEvent: Event,
    Date: { now: () => now }, setTimeout(fn, delay) { now += delay; queueMicrotask(fn); }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('product-identity.js', 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync('content.js', 'utf8'), sandbox);
  return { api: sandbox.window.VoicePOS, input: new Input() };
}
const card = (code, name) => ({ innerText: `${code}\nRs. 20\n${name}`, matches: () => true, getClientRects: () => [1] });

test('unchanged old cards cannot be attributed to a new search', async () => {
  const old = card('40250', 'Zaart 50mg');
  const { api, input } = loadSearch(() => [old]);
  await assert.rejects(api.searchProductCards(input, 'atova 20mg'), /did not refresh/);
});

test('waits for delayed replacement and a stable result set', async () => {
  const old = card('40250', 'Zaart 50mg');
  const fresh = card('90001', 'Atorva 20mg');
  const { api, input } = loadSearch((query, elapsed) => query === 'atova 20mg' && elapsed >= 650 ? [fresh] : [old]);
  const results = await api.searchProductCards(input, 'atova 20mg');
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Atorva 20mg');
});

test('empty searches expire as empty, without inventing candidates', async () => {
  const { api, input } = loadSearch(() => []);
  assert.equal((await api.searchProductCards(input, 'unknown')).length, 0);
});

test('phonetic confidence alone cannot terminate discovery', () => {
  const { api } = loadSearch(() => []);
  assert.equal(api.canStopDiscovery({ confident: true, rawNameSimilarity: 0.833, nameSimilarity: 0.983 }), false);
  assert.equal(api.canStopDiscovery({ confident: true, rawNameSimilarity: 1, exactNameMatch: true }), true);
  assert.deepEqual(Array.from(api.buildNamePrefixQueries('atova')), ['atova', 'atov', 'ato']);
});
