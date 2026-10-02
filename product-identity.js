(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.VoicePOSProductIdentity = api;
})(globalThis, function () {
  'use strict';
  function normalize(text) {
    return String(text ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/\bmilligram(?:me)?s?\b/g, 'mg')
      .replace(/\bmillilit(?:er|re)s?\b/g, 'ml')
      .replace(/\bmicrograms?\b/g, 'mcg')
      .replace(/\b(?:grams?|grammes?|gms?)\b/g, 'g')
      .replace(/μg|µg/g, 'mcg')
      .replace(/(?<=\d)\s*(milligram(?:me)?s?|millilit(?:er|re)s?)/g, unit => unit.trim().startsWith('millil') ? 'ml' : 'mg')
      .replace(/(?<![a-z0-9])\.(?=\d)/g, '0.')
      .replace(/\.(?!\d)|(?<!\d)\./g, ' ')
      .replace(/[^a-z0-9.\s/+%]/g, ' ')
      .replace(/(\d)\s+(mcg|mg|kg|ml|iu|g|l)\b/g, '$1$2')
      .replace(/\s+/g, ' ').trim();
  }
  function decimal(value) {
    const [integer, fraction = ''] = value.split('.');
    const whole = integer.replace(/^0+(?=\d)/, '');
    const tail = fraction.replace(/0+$/, '');
    return tail ? `${whole}.${tail}` : whole;
  }
  function extract(text) {
    const full = normalize(text);
    const components = [];
    const connectors = [];
    let end = 0;
    const name = full.replace(/\b(\d+(?:\.\d+)?)\s*(mcg|mg|kg|ml|iu|g|l|%)?(?![a-z0-9.])/g, (match, value, unit, offset) => {
      if (components.length) connectors.push(full.slice(end, offset).includes('/') ? '/' : '+');
      components.push({ value: decimal(value), unit: unit || '' });
      end = offset + match.length;
      return ' ';
    });
    const namePart = name.replace(/[+/]/g, ' ').replace(/\s+/g, ' ').trim();
    const strength = components.map((part, index) => `${index ? connectors[index - 1] : ''}${part.value}${part.unit}`).join('');
    return { full, namePart, words: namePart.split(' ').filter(Boolean), components, connectors, strength,
      numericStrength: components[0]?.value || '', valid: !/(?:^|\s)\d|[.%]/.test(namePart) };
  }
  function strengthMatches(query, candidate) {
    const left = extract(query);
    const right = extract(candidate);
    if (!left.valid || !right.valid) return false;
    if (!left.components.length) return true;
    if (omittedTopicalConcentrationMatches(left, right)) return true;
    return left.components.length === right.components.length &&
      left.connectors.join('') === right.connectors.join('') &&
      left.components.every((part, index) => part.value === right.components[index].value &&
        (!part.unit || part.unit === right.components[index].unit));
  }
  function omittedTopicalConcentrationMatches(queryParts, candidateParts) {
    if (!/\b(?:cream|gel|ointment|oinment|lotion|solution|spray|drops?)\b/.test(queryParts.namePart)) return false;
    if (queryParts.namePart !== candidateParts.namePart) return false;
    if (queryParts.components.length !== 1 || candidateParts.components.length < 2) return false;
    const requestedPack = queryParts.components[0];
    if (!['g', 'ml'].includes(requestedPack.unit)) return false;
    const candidateHasConcentration = candidateParts.components.slice(0, -1).some(part => part.unit === '%');
    const candidatePack = candidateParts.components[candidateParts.components.length - 1];
    return candidateHasConcentration && candidatePack.value === requestedPack.value && candidatePack.unit === requestedPack.unit;
  }
  return Object.freeze({ normalize, extract, strengthMatches });
});
