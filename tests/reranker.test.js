const assert = require('node:assert/strict');
const test = require('node:test');
const { rerank, resolveSelection } = require('../server/providers/groq-rerank');
const { evaluateRerank } = require('../server/rerank-service');
const input = {
  transcript: '10 atova 20mg', quantity: 10, namePart: 'atova', strength: '20mg',
  candidates: [{ index: 1, code: '101', name: 'Atorva 20mg', strength: '20mg' },
    { index: 2, code: '102', name: 'Atorva 40mg', strength: '40mg' }]
};
const logger = { info() {}, error() {} };
const options = (content, finish = 'stop') => ({ apiKey: 'unit-test-placeholder', model: 'openai/gpt-oss-20b',
  fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.ok(body.max_completion_tokens >= 128);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.temperature, 0);
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage: { completion_tokens: 36 } }));
  }
});

test('valid closed-choice answer is returned with completion diagnostics', async () => {
  const result = await rerank(input, options('1'));
  assert.equal(result.selectedIndex, 1);
  assert.equal(result.status, 'ok');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.completionTokens, 36);
});
test('prompt frames reranking as pharmacy catalog-only medicine resolution', async () => {
  const seen = {};
  await rerank(input, { ...options('1'), fetchImpl: async (_url, request) => {
    Object.assign(seen, JSON.parse(request.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '1' }, finish_reason: 'stop' }], usage: { completion_tokens: 12 } }));
  } });
  const prompt = seen.messages.map(message => message.content).join('\n');
  assert.match(prompt, /pharmacy product-name resolver/i);
  assert.match(prompt, /medicine\/pharmacy products/i);
  assert.match(prompt, /Apply medicine-name phonetic reasoning to every provided candidate/i);
  assert.match(prompt, /final sounds dropped or changed/i);
  assert.match(prompt, /c\/k\/q sounds interchanged/i);
  assert.match(prompt, /v\/w sounds interchanged/i);
  assert.match(prompt, /"losaka", "los aguas", or similar may refer to "Losacar"/i);
  assert.match(prompt, /ONLY products you may choose from/i);
  assert.match(prompt, /Do NOT invent another medicine/i);
  assert.match(prompt, /OPTION_INDEX=1 \| PRODUCT_NAME=Atorva 20mg \| POS_CODE=101/i);
  assert.match(prompt, /Do NOT return the POS_CODE/i);
  assert.match(prompt, /Return ONLY the OPTION_INDEX, or 0/i);
});
test('candidate POS code is rejected because only option indexes are valid', async () => {
  const result = await rerank(input, options('101'));
  assert.equal(result.selectedIndex, 0);
  assert.equal(result.status, 'invalid_response');
  assert.equal(result.selectedBy, 'invalid');
});
test('candidate POS code is not accepted by resolveSelection', () => {
  assert.deepEqual(resolveSelection('23799', [
    { index: 1, code: '23799', name: 'Losacar 50mg' },
    { index: 2, code: '555', name: 'Losacar 25mg' }
  ]), { selectedIndex: 0, valid: false, selectedBy: 'invalid' });
  assert.deepEqual(resolveSelection('23799', [
    { index: 1, code: '23799', name: 'Losacar 50mg' },
    { index: 2, code: '23799', name: 'Different duplicate code' }
  ]), { selectedIndex: 0, valid: false, selectedBy: 'invalid' });
});
for (const answer of ['Candidate 1', 'I think 1', 'Atorva', '3', '-1', '01', '', null]) {
  test(`rejects malformed or out-of-range answer ${JSON.stringify(answer)}`, async () => {
    const result = await rerank(input, options(answer));
    assert.equal(result.selectedIndex, 0);
    assert.equal(result.status, 'invalid_response');
  });
}
test('a truncated numeric answer is not accepted', async () => {
  const result = await rerank(input, options('1', 'length'));
  assert.equal(result.selectedIndex, 0);
  assert.equal(result.status, 'truncated');
});
test('genuine uncertainty remains distinct from failures', async () => {
  const result = await rerank(input, options('0'));
  assert.equal(result.status, 'uncertain');
});
test('backend derives strength from product name and rejects spoofed metadata', async () => {
  const request = { ...input, candidates: input.candidates.map(c => ({ ...c, strength: '20mg' })) };
  const result = await evaluateRerank(request, async () => ({ status: 'ok', selectedIndex: 2 }), logger);
  assert.deepEqual(result, { selectedIndex: 0, status: 'strength_rejected' });
});
test('backend enforces decimal, unit, and combination gates', async () => {
  for (const [strength, name] of [['2.5mg', 'Sample 2mg'], ['5ml', 'Sample 50ml'], ['50mg', 'Sample 50mg/12.5mg']]) {
    const request = { ...input, strength, candidates: [{ index: 1, code: '1', name, strength }] };
    assert.equal((await evaluateRerank(request, async () => ({ status: 'ok', selectedIndex: 1 }), logger)).status, 'strength_rejected');
  }
});
test('backend allows omitted topical concentration when pack size matches', async () => {
  const request = {
    transcript: '7 Loseryl Cream 30 grams',
    quantity: 7,
    namePart: 'loceryl cream',
    strength: '30g',
    candidates: [{ index: 1, code: '23568', name: 'Loceryl Cream 0.25% 30g', strength: '0.25%+30g' }]
  };
  const result = await evaluateRerank(request, async () => ({ status: 'ok', selectedIndex: 1 }), logger);
  assert.deepEqual(result, { selectedIndex: 1, status: 'ok' });
});
test('backend preserves the complete discovered candidate list', async () => {
  const candidates = Array.from({ length: 12 }, (_, i) => ({ index: i + 1, code: String(i), name: `Sample ${20 + i}mg` }));
  const result = await evaluateRerank({ ...input, strength: '31mg', candidates }, async request => {
    assert.equal(request.candidates.length, 12);
    return { selectedIndex: 12, status: 'ok' };
  }, logger);
  assert.equal(result.selectedIndex, 12);
});
test('timeout and rate limit are reported distinctly and never select a candidate', async () => {
  for (const [error, status] of [[Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 'timeout'],
    [Object.assign(new Error('limited'), { code: 'rate_limited' }), 'rate_limited']]) {
    const result = await evaluateRerank(input, async () => { throw error; }, logger);
    assert.deepEqual(result, { selectedIndex: 0, status });
  }
});
test('empty candidates cannot produce a model selection', async () => {
  const result = await evaluateRerank({ ...input, candidates: [] }, async () => { throw new Error('must not call provider with no choices'); }, logger);
  assert.equal(result.status, 'no_candidates');
});
