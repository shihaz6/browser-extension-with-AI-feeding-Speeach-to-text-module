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
    return left.components.length === right.components.length &&
      left.connectors.join('') === right.connectors.join('') &&
      left.components.every((part, index) => part.value === right.components[index].value &&
        (!part.unit || part.unit === right.components[index].unit));
  }
  return Object.freeze({ normalize, extract, strengthMatches });
});
