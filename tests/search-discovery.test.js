const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function loadSearch(results, options = {}) {
  let now = 0;
  let query = null;
  let submittedAt = 0;
  const bodyChildren = [];
  class Input {
    get value() { return this.current || ''; }
    set value(value) { this.current = value; }
    dispatchEvent(event) {
      if (event.type === 'keyup') { query = this.value; submittedAt = now; }
    }
  }
  class Event { constructor(type) { this.type = type; } }
  const body = { append(node) { bodyChildren.push(node); }, querySelector() { return null; } };
  const sandbox = {
    console: { log() {}, info() {}, warn() {} }, window: {},
    document: {
      readyState: options.readyState || 'loading',
      body,
      documentElement: body,
      addEventListener() {},
      createElement(tag) {
        return {
          tagName: tag.toUpperCase(), children: [], style: {}, className: '', disabled: false,
          hidden: false,
          setAttribute() {}, addEventListener() {}, append(...nodes) { this.children.push(...nodes); },
          querySelector() { return null; }, remove() {}, click() {}
        };
      },
      querySelector() { return null; },
      querySelectorAll() { return results(query, now - submittedAt); }
    },
    HTMLInputElement: Input, HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, Event, KeyboardEvent: Event,
    Date: { now: () => now }, setTimeout(fn, delay) { now += delay; queueMicrotask(fn); }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('product-identity.js', 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync('content.js', 'utf8'), sandbox);
  return { api: sandbox.window.VoicePOS, input: new Input(), bodyChildren };
}

function loadCatalogFallbackTest() {
  const stored = { catalog: { harvestedAt: '', items: [] } };
  const saved = [];
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    window: {},
    document: { readyState: 'loading', addEventListener() {} },
    chrome: {
      runtime: { getURL: file => `chrome-extension://test/${file}` },
      storage: {
        local: {
          get(defaults, callback) { callback({ ...defaults, ...stored }); },
          set(payload, callback) { saved.push(payload.catalog); stored.catalog = payload.catalog; callback?.(); }
        }
      }
    },
    fetch: async url => {
      assert.equal(url, 'chrome-extension://test/pos_catalog.json');
      return { ok: true, json: async () => ({ harvestedAt: 'fixture', items: [{ code: '42', name: 'Zaart 50mg', price: '10' }] }) };
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('product-identity.js', 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync('content.js', 'utf8'), sandbox);
  return { api: sandbox.window.VoicePOS, saved };
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

test('catalog harvest searches single letters and two-letter combinations only', () => {
  const { api } = loadSearch(() => []);
  const prefixes = Array.from(api.catalogSeedPrefixes());
  assert.equal(prefixes.length, 26 + (26 * 26));
  assert.deepEqual(prefixes.slice(0, 3), ['a', 'b', 'c']);
  assert.deepEqual(prefixes.slice(24, 29), ['y', 'z', 'aa', 'ab', 'ac']);
  assert.deepEqual(prefixes.slice(-3), ['zx', 'zy', 'zz']);
  assert.equal(prefixes.some(prefix => prefix.length > 2), false);
});

test('catalog controls mount with the development controls', () => {
  const { bodyChildren } = loadSearch(() => [], { readyState: 'complete' });
  assert.ok(bodyChildren.some(node => node.className === 'voice-pos-catalog-toggle'));
  const panel = bodyChildren.find(node => node.className === 'voice-pos-catalog-panel');
  assert.ok(panel);
  assert.equal(panel.hidden, true);
});

test('empty stored catalog falls back to bundled local catalog and persists it', async () => {
  const { api, saved } = loadCatalogFallbackTest();
  const catalog = await api.getCatalogWithBundledFallback();
  assert.equal(catalog.items.length, 1);
  assert.equal(catalog.items[0].name, 'Zaart 50mg');
  assert.equal(catalog.items[0].strength, '50mg');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].items[0].code, '42');
});

test('phonetic confidence alone cannot terminate discovery', () => {
  const { api } = loadSearch(() => []);
  assert.equal(api.canStopDiscovery({ confident: true, rawNameSimilarity: 0.833, nameSimilarity: 0.983 }), false);
  assert.equal(api.canStopDiscovery({ confident: true, rawNameSimilarity: 1, exactNameMatch: true }), true);
  assert.deepEqual(Array.from(api.buildNamePrefixQueries('atova')), ['atova', 'atov', 'ato']);
});
