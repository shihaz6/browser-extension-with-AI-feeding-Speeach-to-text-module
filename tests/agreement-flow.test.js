const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function loadAgreement(response) {
  const panels = [];
  const requests = [];
  function element() {
    return { children: [], handlers: {}, setAttribute() {}, remove() {},
      append(...nodes) { this.children.push(...nodes); },
      addEventListener(name, fn) { this.handlers[name] = fn; } };
  }
  const sandbox = {
    console: { log() {}, info() {}, warn() {} }, window: {},
    document: { readyState: 'loading', addEventListener() {}, querySelector: () => null,
      createElement: element, body: { append: panel => panels.push(panel) } },
    AbortSignal: { timeout: () => ({}) },
    fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => response }; }
  };
  vm.createContext(sandbox);
  for (const file of ['product-identity.js', 'phonetic.js', 'content.js']) {
    let source = fs.readFileSync(file, 'utf8');
    if (file === 'content.js') source = source.replace('window.VoicePOS = Object.freeze({', 'window.VoicePOS = Object.freeze({ resolveVoiceCandidateAgreement,');
    vm.runInContext(source, sandbox);
  }
  return { api: sandbox.window.VoicePOS, panels, requests };
}
const a = { code: '1', name: 'Atorva 20mg' };
const b = { code: '2', name: 'Atorwa 20mg' };
function request(det = a) {
  return { deterministicMatch: det ? { product: det, score: 1 } : null, candidates: [a, b],
    transcript: '10 atorva 20mg', productName: 'atorva 20mg', quantity: 10 };
}
function buttons(panel) { return panel.children.at(-1).children; }

test('agreement calls reranker even for an exact deterministic match and needs no confirmation', async () => {
  const { api, panels, requests } = loadAgreement({ selectedIndex: 1, status: 'ok' });
  assert.equal((await api.resolveVoiceCandidateAgreement(request())).code, '1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].candidates.length, 2);
  assert.equal(panels.length, 0);
});
test('disagreement waits for explicit human choice and permits either answer', async () => {
  for (const selectedButton of [0, 1]) {
    const { api, panels } = loadAgreement({ selectedIndex: 2, status: 'ok' });
    let settled = false;
    const pending = api.resolveVoiceCandidateAgreement(request()).then(result => { settled = true; return result; });
    await new Promise(setImmediate);
    assert.equal(settled, false);
    assert.equal(buttons(panels[0]).length, 3);
    buttons(panels[0])[selectedButton].handlers.click();
    assert.equal((await pending).code, selectedButton ? '2' : '1');
  }
});
test('AI alone cannot auto-select when deterministic matching is uncertain', async () => {
  const { api, panels } = loadAgreement({ selectedIndex: 1, status: 'ok' });
  const pending = api.resolveVoiceCandidateAgreement(request(null));
  await new Promise(setImmediate);
  assert.equal(panels.length, 1);
  const rejected = assert.rejects(pending, /canceled/);
  buttons(panels[0]).at(-1).handlers.click();
  await rejected;
});
test('both uncertain add nothing', async () => {
  const { api, panels } = loadAgreement({ selectedIndex: 0, status: 'uncertain' });
  await assert.rejects(api.resolveVoiceCandidateAgreement(request(null)), /Could not confidently identify/);
  assert.equal(panels.length, 0);
});
test('provider failures show their actual status and cannot auto-proceed', async () => {
  const { api, panels } = loadAgreement({ selectedIndex: 0, status: 'truncated' });
  const pending = api.resolveVoiceCandidateAgreement(request());
  await new Promise(setImmediate);
  assert.match(panels[0].children[2].textContent, /truncated/);
  const rejected = assert.rejects(pending, /canceled/);
  buttons(panels[0]).at(-1).handlers.click();
  await rejected;
});
test('client rejects a strength conflict even if backend claims agreement', async () => {
  const wrong = { code: '3', name: 'Atorva 40mg' };
  const { api, panels } = loadAgreement({ selectedIndex: 1, status: 'ok' });
  await assert.rejects(api.resolveVoiceCandidateAgreement({ ...request(null), candidates: [wrong] }), /Could not confidently identify/);
  assert.equal(panels.length, 0);
});
