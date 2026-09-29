const identity = require('../product-identity');
const { rerankProducts } = require('./rerank-provider');

async function evaluateRerank(body, provider = rerankProducts, logger = console) {
  const invalid = { selectedIndex: 0, status: 'invalid_request' };
  if (!body || !Number.isSafeInteger(body.quantity) || body.quantity < 1 ||
      typeof body.transcript !== 'string' || body.transcript.length > 4000 ||
      typeof body.namePart !== 'string' || body.namePart.length > 300 ||
      typeof body.strength !== 'string' || body.strength.length > 100 ||
      !identity.extract(body.strength).valid || !Array.isArray(body.candidates)) return invalid;
  if (!body.candidates.length) return { selectedIndex: 0, status: 'no_candidates' };
  if (body.candidates.some((candidate, i) => !candidate || candidate.index !== i + 1 ||
      typeof candidate.name !== 'string' || !candidate.name.trim() || candidate.name.length > 300 ||
      typeof candidate.code !== 'string' || candidate.code.length > 80)) return invalid;
  const candidates = body.candidates.map(({ code, name }, i) => ({
    index: i + 1, code, name, strength: identity.extract(name).strength
  }));
  try {
    const result = await provider({ transcript: body.transcript, quantity: body.quantity,
      namePart: body.namePart, strength: body.strength, candidates });
    logger.info('[VoicePOS Server] Raw reranker response:', JSON.stringify(String(result.rawResponse || '').slice(0, 200)),
      { status: result.status, finishReason: result.finishReason, selectedBy: result.selectedBy,
        completionTokens: result.completionTokens });
    if (result.status !== 'ok') return { selectedIndex: 0, status: result.status || 'invalid_response' };
    if (!Number.isSafeInteger(result.selectedIndex) || result.selectedIndex < 1 || result.selectedIndex > candidates.length) {
      return { selectedIndex: 0, status: 'invalid_response' };
    }
    if (!identity.strengthMatches(body.strength, candidates[result.selectedIndex - 1].name)) {
      return { selectedIndex: 0, status: 'strength_rejected' };
    }
    return { selectedIndex: result.selectedIndex, status: 'ok' };
  } catch (error) {
    const status = ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' :
      ['not_configured', 'rate_limited', 'provider_error'].includes(error.code) ? error.code : 'unavailable';
    logger.error('[VoicePOS Server] Reranker failed:', status, { httpStatus: error.statusCode || null });
    return { selectedIndex: 0, status };
  }
}

module.exports = { evaluateRerank };
