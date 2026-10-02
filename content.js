console.log("[VoicePOS] content script loaded");

(() => {
  "use strict";

  // Replace these selectors only after inspecting the target POS page.
  const CONFIG = {
    searchInput: "#select_item",
    // IDs like #fcs_2 are dynamic. Match the stable ID prefix and inspect text.
    productCards: '[id^="fcs_"]',
    productCardName: '[id^="fcs_"]',
    calculatorModal: "#easy-numpad-frame",
    calculatorProductName: "",
    calculatorQtyDisplay: "#easy-numpad-output",
    calculatorNumberButtons: "*",
    calculatorQtyButton: "#calQty",
    calculatorConfirmButton: "#doneAdd > i",
    billRows: "#ddd > div:nth-child(2)",
    closeButton: "#bill_close_but",

    // Optional mapping: normalized spoken alias -> canonical product name.
    aliases: {
      "coke": "Coca Cola",
      "coca cola": "Coca Cola",
      "coca-cola": "Coca Cola"
    },
    minimumNameSimilarity: 0.72,
    highConfidenceNameThreshold: 0.88,
    confidenceThreshold: 0.75,
    ambiguityMargin: 0.12,
    phoneticMinStringSimilarity: 0.50,
    phoneticBonus: 0.15,
    searchResultsTimeout: 3000,
    searchSettleMs: 350,
    searchMinimumWaitMs: 500,
    catalogMinEmptyWaitMs: 3500,
    catalogSearchTimeout: 6000,
    catalogSettleMs: 600,
    catalogThrottleMinMs: 400,
    catalogThrottleMaxMs: 600,
    catalogRerankMaxCandidates: 8,
    rerankTimeoutMs: 10000,
    stageTimeout: 6000
  };

  const LOG = "[VoicePOS]";
  let mediaRecorder = null;
  let mediaStream = null;
  let recordedChunks = [];
  let microphoneRequestPending = false;
  let catalogHarvestRun = null;

  function log(...args) { console.info(LOG, ...args); }
  function warn(...args) { console.warn(LOG, ...args); }

  function normalizeProductName(text) {
    return String(text ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function normalizeSearchQuery(text) {
    return globalThis.VoicePOSProductIdentity.normalize(text);
  }

  function extractSearchParts(text) {
    return globalThis.VoicePOSProductIdentity.extract(text);
  }

  function buildSearchFallbacks(text) {
    const parts = extractSearchParts(text);
    const withoutMg = parts.numericStrength
      ? parts.full.replace(`${parts.numericStrength}mg`, parts.numericStrength)
      : "";
    const namePart = parts.words.join(" ");
    return [...new Set([
      parts.full,
      namePart,
      ...buildNamePrefixQueries(namePart),
      withoutMg,
      parts.strength,
      parts.numericStrength
    ].map(normalizeSearchQuery).filter(Boolean))];
  }

  function buildNamePrefixQueries(namePart) {
    const firstNameToken = normalizeSearchQuery(namePart).split(" ").filter(Boolean)[0] || "";
    if (firstNameToken.length < 3) return [];
    const lengths = firstNameToken.length >= 5 ? [5, 4, 3] : [3, 2];
    return [...new Set(lengths
      .filter(length => length <= firstNameToken.length && length >= 2)
      .map(length => firstNameToken.slice(0, length)))];
  }

  function getMergeQueryParts(productName) {
    const parsed = extractSearchParts(productName);
    return { namePart: parsed.namePart, strength: parsed.strength };
  }

  function generateNameMergeVariants(namePart) {
    const normalized = normalizeSearchQuery(namePart);
    const tokens = normalized.split(" ").filter(Boolean);
    if (tokens.length < 2) return [];
    const original = normalizeProductName(normalized);
    const variants = [];
    const add = value => {
      const variant = normalizeSearchQuery(value);
      if (!variant || normalizeProductName(variant) === original || variants.includes(variant)) return;
      if (variants.length < 4) variants.push(variant);
    };
    for (let index = 0; index < tokens.length - 1 && variants.length < 4; index++) {
      const merged = [...tokens.slice(0, index), `${tokens[index]}${tokens[index + 1]}`, ...tokens.slice(index + 2)];
      add(merged.join(" "));
    }
    if (variants.length < 4) add(tokens.join(""));
    return variants;
  }

  function normalizeCandidateProduct(label) {
    return normalizeSearchQuery(String(label ?? "")
      .replace(/^\s*#?\d{3,}\s*(?:[-–—|:]\s*)?/, "")
      .replace(/\b(?:rs\.?|lkr|usd|price|amount)\s*[:.]?\s*\d+(?:[.,]\d{1,2})?\b/gi, " ")
      .replace(/[$€£₹]\s*\d+(?:[.,]\d{1,2})?/g, " ")
      );
  }

  function extractProductCardData(card, discoveredFromQuery = "") {
    const nameNode = card.matches(CONFIG.productCardName) ? card : card.querySelector(CONFIG.productCardName);
    const text = String(nameNode?.innerText || nameNode?.textContent || "").trim();
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const firstLineCode = lines[0]?.match(/^#?(\d{3,})$/)?.[1];
    const leadingCode = text.match(/^\s*#?(\d{4,})\b/)?.[1]
      || text.match(/^\s*#?(\d{3,})\s*[-–—|:]\s*/)?.[1];
    const code = String(leadingCode || firstLineCode || "");
    const priceMatch = text.match(/\b(?:rs\.?|lkr|usd)\s*[:.]?\s*([\d,]+(?:\.\d{1,2})?)/i)
      || text.match(/[$€£₹]\s*([\d,]+(?:\.\d{1,2})?)/);
    const price = priceMatch?.[1]?.replace(/,/g, "") || "";
    let nameText = lines
      .filter(line => !/^(?:#?\d{3,}|(?:rs\.?|lkr|usd)\s*[:.]?\s*[\d,.]+|[$€£₹]\s*[\d,.]+)$/i.test(line))
      .join(" ");
    if (code) nameText = nameText.replace(new RegExp(`^\\s*#?${code}\\b\\s*[-–—|:]?\\s*`), "");
    nameText = nameText
      .replace(/\b(?:rs\.?|lkr|usd)\s*[:.]?\s*[\d,]+(?:\.\d{1,2})?/gi, " ")
      .replace(/[$€£₹]\s*[\d,]+(?:\.\d{1,2})?/g, " ")
      .replace(/[|•]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const name = nameText || (code ? "" : text);
    return {
      code,
      name,
      price,
      normalizedName: normalizeCandidateProduct(name),
      element: card,
      discoveredFromQuery
    };
  }

  function enrichCatalogItem(candidate, discoveredFromPrefix = candidate.discoveredFromQuery || "") {
    const parsed = extractSearchParts(candidate.name || "");
    return {
      code: String(candidate.code || "").trim(),
      name: String(candidate.name || "").trim(),
      price: String(candidate.price || "").trim(),
      normalizedName: normalizeProductName(candidate.name || ""),
      strength: parsed.strength || "",
      discoveredFromPrefix
    };
  }

  function catalogItemKey(item) {
    return item.code ? `code:${item.code}` : `name:${item.normalizedName}|strength:${item.strength}`;
  }

  function getCatalog(callback) {
    if (!globalThis.chrome?.storage?.local) return callback({ harvestedAt: "", items: [] });
    chrome.storage.local.get({ catalog: { harvestedAt: "", items: [] } }, result => {
      const catalog = result?.catalog && Array.isArray(result.catalog.items)
        ? result.catalog
        : { harvestedAt: "", items: [] };
      callback(catalog);
    });
  }

  function getCatalogAsync() {
    return new Promise(resolve => getCatalog(resolve));
  }

  function normalizeCatalogPayload(raw) {
    const sourceItems = Array.isArray(raw?.items) ? raw.items : [];
    const byKey = new Map();
    for (const rawItem of sourceItems) {
      const item = enrichCatalogItem(rawItem, rawItem?.discoveredFromPrefix || "bundled");
      if (!item.code || !item.name) continue;
      byKey.set(catalogItemKey(item), item);
    }
    return {
      harvestedAt: raw?.harvestedAt || new Date().toISOString(),
      items: [...byKey.values()]
    };
  }

  async function loadBundledCatalog() {
    if (!globalThis.chrome?.runtime?.getURL || typeof fetch !== "function") return { harvestedAt: "", items: [] };
    const response = await fetch(chrome.runtime.getURL("pos_catalog.json"), { cache: "no-store" });
    if (!response.ok) throw new Error(`Bundled catalog failed to load (HTTP ${response.status})`);
    return normalizeCatalogPayload(await response.json());
  }

  async function getCatalogWithBundledFallback() {
    const catalog = await getCatalogAsync();
    if (Array.isArray(catalog.items) && catalog.items.length) return catalog;
    const bundled = await loadBundledCatalog();
    if (bundled.items.length) await new Promise(resolve => saveCatalog(bundled, resolve));
    return bundled;
  }

  function saveCatalog(catalog, callback = () => {}) {
    const payload = {
      harvestedAt: catalog.harvestedAt || new Date().toISOString(),
      items: Array.isArray(catalog.items) ? catalog.items : []
    };
    if (!globalThis.chrome?.storage?.local) return callback(payload);
    chrome.storage.local.set({ catalog: payload }, () => callback(payload));
  }

  function upsertCatalogItems(candidates, options = {}) {
    const items = candidates
      .map(candidate => enrichCatalogItem(candidate, options.discoveredFromPrefix))
      .filter(item => item.code && item.name);
    if (!items.length) return Promise.resolve({ inserted: 0, updated: 0, catalog: null });
    return new Promise(resolve => {
      getCatalog(catalog => {
        const byKey = new Map((catalog.items || []).map(item => [catalogItemKey(item), item]));
        let inserted = 0;
        let updated = 0;
        for (const item of items) {
          const key = catalogItemKey(item);
          if (byKey.has(key)) updated += 1;
          else inserted += 1;
          byKey.set(key, { ...byKey.get(key), ...item });
        }
        const next = { harvestedAt: new Date().toISOString(), items: [...byKey.values()] };
        saveCatalog(next, saved => resolve({ inserted, updated, catalog: saved }));
      });
    });
  }

  function parseOrder(text) {
    const numberWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, tens: 10 };
    let normalized = String(text ?? "").toLowerCase().trim()
      .replace(/,\s*(?=(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|tens)\b\s+[a-z])/g, " | ")
      .replace(/,/g, " ")
      .replace(/\b(and|then)\b/g, " | ");

    return normalized.split(/\s*\|\s*/).map(segment => {
      const chunk = segment
        .replace(/(?<![a-z0-9])\.(?=\d)/g, "0.")
        .replace(/\.(?!\d)|(?<!\d)\.|[!?;:]+/g, " ")
        .replace(/[^a-z0-9.\s/+%]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!chunk) return null;

      const tokens = chunk.split(" ");
      const firstToken = tokens[0];
      const quantity = numberWords[firstToken] ?? (/^\d+$/.test(firstToken) ? Number(firstToken) : null);
      const productText = tokens.slice(1).join(" ")
        .replace(/\b(\d+)\s*(?:milligrams?|milligrammes?)\b/g, "$1mg")
        .replace(/\b(\d+)\s*(?:milliliters?|millilitres?|ml)\b/g, "$1ml")
        .replace(/\s+/g, " ")
        .trim();
      const hasProductWord = productText.split(" ").some(token => /[a-z]/.test(token) && !/^(?:mg|ml|\d+mg|\d+ml)$/.test(token));
      const validQuantity = Number.isInteger(quantity) && quantity > 0;
      const valid = validQuantity && !!productText && hasProductWord && extractSearchParts(productText).valid;
      return {
        product: productText,
        quantity: validQuantity ? quantity : null,
        needsCorrection: !valid,
        formatError: !valid
      };
    }).filter(Boolean);
  }

  function levenshteinDistance(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const old = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = old;
      }
    }
    return row[b.length];
  }

  function normalizePhoneticName(text) {
    return String(text ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getPhoneticCodes(name) {
    const normalized = normalizePhoneticName(name);
    const encoder = globalThis.VoicePOSDoubleMetaphone?.doubleMetaphone;
    if (!normalized || typeof encoder !== "function") return ["", ""];
    const codes = encoder(normalized);
    return Array.isArray(codes) ? [String(codes[0] || ""), String(codes[1] || "")] : ["", ""];
  }

  function phoneticCodesMatch(queryCodes, candidateCodes) {
    return queryCodes.some(queryCode => queryCode && candidateCodes.some(candidateCode => candidateCode && queryCode === candidateCode));
  }

  function medicinePhoneticKey(text) {
    return normalizePhoneticName(text)
      .replace(/c(?=[aou])/g, "k")
      .replace(/q/g, "k")
      .replace(/x/g, "ks")
      .replace(/ph/g, "f")
      .replace(/v/g, "w")
      .replace(/(.)\1+/g, "$1")
      .split(" ")
      .map(word => word.length > 4 ? word.replace(/ar$/, "a").replace(/er$/, "a").replace(/or$/, "a").replace(/r$/, "") : word)
      .join(" ");
  }

  function medicinePhoneticSimilarity(left, right) {
    const leftKey = medicinePhoneticKey(left).replace(/\s+/g, "");
    const rightKey = medicinePhoneticKey(right).replace(/\s+/g, "");
    if (!leftKey || !rightKey) return 0;
    if (leftKey === rightKey) return 1;
    const edit = 1 - levenshteinDistance(leftKey, rightKey) / Math.max(leftKey.length, rightKey.length, 1);
    let prefixLength = 0;
    while (prefixLength < Math.min(leftKey.length, rightKey.length) && leftKey[prefixLength] === rightKey[prefixLength]) prefixLength++;
    const prefix = prefixLength / Math.max(leftKey.length, rightKey.length, 1);
    return Math.max(edit, prefix);
  }

  function findBestProductMatch(name, products) {
    const query = extractSearchParts(name);
    const normalized = normalizeProductName(query.full);
    const alias = CONFIG.aliases[normalized];
    const aliasedQuery = alias ? extractSearchParts(alias) : query;
    if (!aliasedQuery.full || !Array.isArray(products) || !products.length) return null;

    const tokenSimilarity = (left, right) => {
      if (left === right) return 1;
      const edit = 1 - levenshteinDistance(left, right) / Math.max(left.length, right.length, 1);
      let prefixLength = 0;
      while (prefixLength < Math.min(left.length, right.length) && left[prefixLength] === right[prefixLength]) prefixLength++;
      const prefix = prefixLength / Math.max(left.length, right.length, 1);
      return Math.max(edit, prefix);
    };
    const scoreCandidate = label => {
      const candidateFull = normalizeCandidateProduct(label);
      const candidateParts = extractSearchParts(candidateFull);
      const candidateWords = candidateParts.words;
      if (!aliasedQuery.words.length) return {
        rawNameSimilarity: 0,
        effectiveNameSimilarity: 0,
        queryPhoneticCodes: ["", ""],
        candidatePhoneticCodes: ["", ""],
        phoneticMatch: false,
        phoneticBonusApplied: false,
        nameSimilarity: 0,
        strengthMatch: false,
        score: 0
      };

      const tokenMatches = aliasedQuery.words.map(word => {
        if (!candidateWords.length) return { score: 0, index: -1 };
        let best = { score: 0, index: -1 };
        candidateWords.forEach((candidate, index) => {
          const score = tokenSimilarity(word, candidate);
          if (score > best.score) best = { score, index };
        });
        return best;
      });
      const wordScores = tokenMatches.map(match => match.score);
      const rawNameScore = wordScores.reduce((sum, value) => sum + value, 0) / wordScores.length;
      const usedCandidateWords = new Set(tokenMatches.filter(match => match.index >= 0).map(match => match.index));
      const unmatchedWords = candidateWords.filter((_, index) => !usedCandidateWords.has(index)).length;
      const variantPenalty = Math.min(unmatchedWords * 0.13, 0.26);
      const rawNameSimilarity = Math.max(0, rawNameScore - variantPenalty);
      const queryName = aliasedQuery.words.join(" ");
      const candidateName = candidateWords.join(" ");
      const medicinePhoneticNameSimilarity = medicinePhoneticSimilarity(queryName, candidateName);
      const medicinePhoneticAdjustedSimilarity = rawNameSimilarity >= CONFIG.highConfidenceNameThreshold
        ? rawNameSimilarity
        : Math.max(rawNameSimilarity, Math.min(CONFIG.highConfidenceNameThreshold - 0.001, medicinePhoneticNameSimilarity));
      const queryPhoneticCodes = getPhoneticCodes(queryName);
      const candidatePhoneticCodes = getPhoneticCodes(candidateName);
      const phoneticMatch = phoneticCodesMatch(queryPhoneticCodes, candidatePhoneticCodes);
      const phoneticBonusApplied = phoneticMatch &&
        medicinePhoneticAdjustedSimilarity >= CONFIG.phoneticMinStringSimilarity &&
        medicinePhoneticAdjustedSimilarity < CONFIG.highConfidenceNameThreshold;
      const effectiveNameSimilarity = phoneticBonusApplied
        ? Math.max(medicinePhoneticAdjustedSimilarity, Math.min(CONFIG.highConfidenceNameThreshold - 0.001, 1 - CONFIG.ambiguityMargin - 0.001,
          medicinePhoneticAdjustedSimilarity + CONFIG.phoneticBonus))
        : medicinePhoneticAdjustedSimilarity;
      const strengthMatch = globalThis.VoicePOSProductIdentity.strengthMatches(aliasedQuery.full, candidateFull);
      // Strength is a filter only; it never adds to the medicine-name score.
      return {
        rawNameSimilarity,
        medicinePhoneticNameSimilarity,
        exactNameMatch: queryName === candidateName,
        effectiveNameSimilarity,
        queryPhoneticCodes,
        candidatePhoneticCodes,
        phoneticMatch,
        phoneticBonusApplied,
        nameSimilarity: effectiveNameSimilarity,
        strengthMatch,
        score: effectiveNameSimilarity
      };
    };

    const scored = [];
    for (const product of products) {
      const label = typeof product === "string" ? product : product?.name;
      if (!label) continue;
      scored.push({ product, ...scoreCandidate(label) });
    }
    scored.sort((a, b) => b.score - a.score || Number(b.exactNameMatch) - Number(a.exactNameMatch));
    if (!scored.length) return null;
    const strengthCompatible = scored.filter(item => item.strengthMatch);
    const best = strengthCompatible[0] || scored[0];
    const second = strengthCompatible[1] || null;
    const margin = second ? best.score - second.score : null;
    const confident = best.strengthMatch && best.nameSimilarity >= CONFIG.minimumNameSimilarity &&
      best.score >= CONFIG.confidenceThreshold && (margin === null
        ? best.nameSimilarity >= CONFIG.highConfidenceNameThreshold
        : margin >= CONFIG.ambiguityMargin);
    return {
      ...best,
      confident,
      margin,
      candidates: [...strengthCompatible, ...scored.filter(item => !item.strengthMatch)],
      strengthCompatible
    };
  }

  function logScoredCandidate(candidate) {
    const name = typeof candidate.product === "string" ? candidate.product : candidate.product?.name || "(unnamed)";
    log(`[VoicePOS] Candidate: ${name}`);
    log(`[VoicePOS] Raw string similarity: ${candidate.rawNameSimilarity.toFixed(2)}`);
    log(`[VoicePOS] Query phonetic codes: ${JSON.stringify(candidate.queryPhoneticCodes)}`);
    log(`[VoicePOS] Candidate phonetic codes: ${JSON.stringify(candidate.candidatePhoneticCodes)}`);
    log(`[VoicePOS] Phonetic match: ${candidate.phoneticMatch}`);
    log(`[VoicePOS] Phonetic bonus applied: ${candidate.phoneticBonusApplied ? `+${CONFIG.phoneticBonus.toFixed(2)}` : "+0.00"}`);
    log(`[VoicePOS] Effective name similarity: ${candidate.effectiveNameSimilarity.toFixed(2)}`);
    log(`[VoicePOS] Strength match: ${candidate.strengthMatch}`);
    log(`[VoicePOS] Final score: ${candidate.score.toFixed(3)}`);

    let decision;
    if (!candidate.strengthMatch) decision = "rejected: strength mismatch";
    else if (candidate.effectiveNameSimilarity < CONFIG.minimumNameSimilarity) decision = "rejected: name similarity below threshold";
    else if (candidate.score < CONFIG.confidenceThreshold) decision = "rejected: confidence below threshold";
    else decision = "accepted for comparison";
    log(`[VoicePOS] Candidate ${decision}`);
  }

  function mergeScoringAttempts(attempts) {
    const bestByIdentity = new Map();
    for (const attempt of attempts) {
      for (const scored of attempt.match?.candidates || []) {
        const product = scored.product;
        if (!product || typeof product === "string") continue;
        const identity = product.code ? `code:${product.code}` : `name:${product.normalizedName || normalizeCandidateProduct(product.name)}`;
        const existing = bestByIdentity.get(identity);
        if (!existing || scored.score > existing.score) {
          bestByIdentity.set(identity, { ...scored, queryVariant: attempt.queryVariant });
        }
      }
    }
    const all = [...bestByIdentity.values()].sort((a, b) => b.score - a.score);
    const compatible = all.filter(candidate => candidate.strengthMatch);
    const best = compatible[0] || all[0] || null;
    const second = compatible[1] || null;
    const margin = second && best ? best.score - second.score : null;
    const confident = !!best && best.strengthMatch &&
      best.nameSimilarity >= CONFIG.minimumNameSimilarity &&
      best.score >= CONFIG.confidenceThreshold &&
      (margin === null ? best.nameSimilarity >= CONFIG.highConfidenceNameThreshold : margin >= CONFIG.ambiguityMargin);
    return {
      ...(best || {}),
      confident,
      margin,
      candidates: [...compatible, ...all.filter(candidate => !candidate.strengthMatch)],
      strengthCompatible: compatible,
      allScored: all
    };
  }

  function waitForElement(selector, { root = document, timeout = 5000 } = {}) {
    if (!selector) return Promise.reject(new Error("Selector is not configured"));
    const existing = root.querySelector(selector);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const element = root.querySelector(selector);
        if (element) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(element);
        }
      });
      observer.observe(root === document ? document.documentElement : root, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timed out waiting for selector: ${selector}`));
      }, timeout);
    });
  }

  function setNativeInputValue(element, value) {
    if (!element) throw new Error("Input element was not found");
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, String(value));
    else element.value = String(value);
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified" }));
  }

  function getVisibleProductCards(discoveredFromQuery = "") {
    return [...document.querySelectorAll(CONFIG.productCards)]
      .filter(isVisible)
      .map(card => extractProductCardData(card, discoveredFromQuery))
      .filter(candidate => candidate.name);
  }

  async function searchProductCards(search, query) {
    const signature = cards => cards.map(card => `${card.code}|${card.normalizedName}`).sort().join("\n");
    const previousCards = getVisibleProductCards();
    const previousSignature = signature(previousCards);
    setNativeInputValue(search, "");
    let cleared = previousCards.length === 0;
    try {
      await waitForCondition(() => getVisibleProductCards().length === 0, "old product results to clear", 350);
      cleared = true;
    } catch (_) { /* Some POS pages keep old cards mounted while refreshing. */ }
    setNativeInputValue(search, query);
    const started = Date.now();
    let lastSignature = null;
    let changedAt = started;
    while (Date.now() - started < CONFIG.searchResultsTimeout) {
      const cards = getVisibleProductCards(query);
      const currentSignature = signature(cards);
      if (!cards.length) cleared = true;
      if (currentSignature !== lastSignature) {
        lastSignature = currentSignature;
        changedAt = Date.now();
      }
      const fresh = cleared || currentSignature !== previousSignature;
      if (cards.length && fresh && Date.now() - started >= CONFIG.searchMinimumWaitMs &&
          Date.now() - changedAt >= CONFIG.searchSettleMs) {
        void upsertCatalogItems(cards, { discoveredFromPrefix: query }).catch(error => warn("Catalog upsert failed:", error));
        return cards;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!getVisibleProductCards().length) return [];
    throw new Error(`POS search results did not refresh or settle for "${query}". Product selection stopped.`);
  }

  function productCardSignature(cards) {
    return cards.map(card => String(card.code || card.normalizedName || card.name)).filter(Boolean).sort().join("\n");
  }

  function waitForDomSettle(timeout = CONFIG.catalogSearchTimeout, quietMs = 400) {
    return new Promise(resolve => {
      let lastMutation = Date.now();
      const observer = new MutationObserver(() => { lastMutation = Date.now(); });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true
      });
      const started = Date.now();
      const poll = () => {
        if (Date.now() - lastMutation >= quietMs || Date.now() - started >= timeout) {
          observer.disconnect();
          resolve();
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
  }

  async function catalogSearchProductCards(search, prefix, previousAcceptedSignature = "") {
    const started = Date.now();
    const originalTimeout = CONFIG.searchResultsTimeout;
    const originalSettle = CONFIG.searchSettleMs;
    CONFIG.searchResultsTimeout = CONFIG.catalogSearchTimeout;
    CONFIG.searchSettleMs = CONFIG.catalogSettleMs;
    let cards = [];
    try {
      cards = await searchProductCards(search, prefix);
    } finally {
      CONFIG.searchResultsTimeout = originalTimeout;
      CONFIG.searchSettleMs = originalSettle;
    }

    if (!cards.length && Date.now() - started < CONFIG.catalogMinEmptyWaitMs) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.catalogMinEmptyWaitMs - (Date.now() - started)));
      cards = getVisibleProductCards(prefix);
    }
    if (!cards.length && Date.now() - started < CONFIG.catalogSearchTimeout) {
      await waitForDomSettle(CONFIG.catalogSearchTimeout - (Date.now() - started), CONFIG.catalogSettleMs);
      cards = getVisibleProductCards(prefix);
    }

    if (cards.length) await waitForDomSettle(1200, CONFIG.catalogSettleMs);
    cards = getVisibleProductCards(prefix);
    let signature = productCardSignature(cards);
    if (prefix && previousAcceptedSignature && signature && signature === previousAcceptedSignature) {
      await waitForDomSettle(1200, CONFIG.catalogSettleMs);
      cards = getVisibleProductCards(prefix);
      signature = productCardSignature(cards);
    }

    const diagnostics = getCatalogSearchDiagnostics(search, cards);
    return {
      cards,
      signature,
      waitedMs: Date.now() - started,
      containerOuterHtmlLength: diagnostics.containerOuterHtmlLength,
      state: diagnostics.state
    };
  }

  function getCatalogSearchDiagnostics(search, cards = []) {
    const container = getCatalogResultsContainer(search, cards);
    const text = normalizeProductName(container?.innerText || container?.textContent || "");
    const loading = /\b(?:loading|searching|please wait|wait)\b/.test(text);
    const noResults = /\b(?:no result|no results|not found|no item|no items|empty)\b/.test(text);
    return {
      containerOuterHtmlLength: String(container?.outerHTML || "").length,
      state: loading ? "loading" : noResults ? "no-results" : "none"
    };
  }

  function getCatalogResultsContainer(search, cards = []) {
    const firstCardElement = cards.find(card => card.element)?.element || document.querySelector(CONFIG.productCards);
    if (firstCardElement?.parentElement) return firstCardElement.parentElement;
    return search?.closest("form, section, main, div") || document.body || document.documentElement;
  }

  function getCartHasItems() {
    if (!CONFIG.billRows) return false;
    const roots = [...document.querySelectorAll(CONFIG.billRows)].filter(isVisible);
    const candidates = roots.flatMap(root => {
      const visibleChildren = [...root.querySelectorAll("tr, li, div")]
        .filter(el => isVisible(el) && String(el.innerText || el.textContent || "").trim());
      return visibleChildren.length ? visibleChildren : [root];
    });
    return candidates.some(element => isLikelyBillLineText(element.innerText || element.textContent || ""));
  }

  function isLikelyBillLineText(text) {
    const normalized = normalizeProductName(text);
    if (!normalized) return false;
    const withoutUiLabels = normalized
      .replace(/\b(?:item|items|product|products|name|code|qty|quantity|price|amount|discount|total|subtotal|net|balance|cash|card|payment|invoice|bill|cart|empty|no items?)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!/[a-z]/.test(withoutUiLabels)) return false;
    const numbers = String(text).match(/\d+(?:[.,]\d+)?/g) || [];
    return numbers.length >= 1;
  }

  function catalogSeedPrefixes() {
    const letters = "abcdefghijklmnopqrstuvwxyz".split("");
    const twoLetterPrefixes = letters.flatMap(first => letters.map(second => `${first}${second}`));
    return [...letters, ...twoLetterPrefixes];
  }

  function randomCatalogItems(items, count = 10) {
    const pool = [...items];
    for (let index = pool.length - 1; index > 0; index--) {
      const swap = Math.floor(Math.random() * (index + 1));
      [pool[index], pool[swap]] = [pool[swap], pool[index]];
    }
    return pool.slice(0, count);
  }

  function renderCatalogReport(report) {
    const panel = document.querySelector(".voice-pos-catalog-panel");
    if (!panel) return;
    panel.querySelector(".voice-pos-catalog-report")?.remove();
    const section = document.createElement("section");
    section.className = "voice-pos-catalog-report";
    const summary = document.createElement("p");
    summary.textContent = `Catalog: ${report.totalItems} items. Duplicates dropped: ${report.duplicatesDropped}. No strength: ${report.noStrengthCount}. Failed searches: ${report.failedPrefixes.length}. Zero-item searches: ${report.zeroItemQueries.length}. Search prefixes: A-Z and AA-ZZ.`;
    const sample = document.createElement("pre");
    const zeroLines = report.zeroItemQueries.slice(0, 20)
      .map(item => `0 items | ${item.prefix} | ${item.waitedMs}ms | ${item.state}`)
      .join("\n");
    const sampleLines = report.sampleItems
      .map(item => `${item.code || "(no code)"} | ${item.name} | ${item.strength || "(no strength)"} | ${item.price || "(no price)"}`)
      .join("\n");
    sample.textContent = [zeroLines, sampleLines || "No catalog items found."].filter(Boolean).join("\n\n");
    section.append(summary, sample);
    panel.append(section);
  }

  async function buildCatalog() {
    if (catalogHarvestRun?.active) return;
    const status = document.querySelector(".voice-pos-catalog-status");
    const buildButton = document.querySelector(".voice-pos-catalog-build");
    const stopButton = document.querySelector(".voice-pos-catalog-stop");
    if (getCartHasItems()) {
      if (status) status.textContent = "Catalog build refused: cart/bill has items. Clear the cart first.";
      return;
    }
    const search = await waitForElement(CONFIG.searchInput, { timeout: CONFIG.stageTimeout });
    const run = { active: true, stop: false };
    catalogHarvestRun = run;
    if (buildButton) buildButton.disabled = true;
    if (stopButton) stopButton.disabled = false;

    const queue = catalogSeedPrefixes();
    const itemsByCode = new Map();
    const failedPrefixes = [];
    const zeroItemQueries = [];
    let queriesDone = 0;
    let duplicatesDropped = 0;
    let previousSignature = "";
    let sanityStopMessage = "";
    const updateProgress = () => {
      if (status) status.textContent = `Building catalog: ${queriesDone} done / ${queue.length} queued / ${itemsByCode.size} items found`;
    };

    try {
      while (queue.length && !run.stop) {
        const prefix = queue.shift();
        updateProgress();
        const throttle = CONFIG.catalogThrottleMinMs + Math.floor(Math.random() * (CONFIG.catalogThrottleMaxMs - CONFIG.catalogThrottleMinMs + 1));
        await new Promise(resolve => setTimeout(resolve, throttle));

        let result = null;
        for (let attempt = 0; attempt < 2 && !result; attempt++) {
          try {
            result = await catalogSearchProductCards(search, prefix, previousSignature);
          } catch (error) {
            warn(`Catalog prefix "${prefix}" attempt ${attempt + 1} failed:`, error);
            if (attempt === 1) failedPrefixes.push(prefix);
          }
        }
        queriesDone += 1;
        if (!result) {
          updateProgress();
          continue;
        }
        if (queriesDone <= 5) {
          log("[VoicePOS] Catalog debug", {
            prefix,
            waitedMs: result.waitedMs,
            cardsFound: result.cards.length,
            containerOuterHtmlLength: result.containerOuterHtmlLength,
            state: result.state
          });
        }
        if (!result.cards.length) {
          zeroItemQueries.push({
            prefix,
            waitedMs: result.waitedMs,
            state: result.state,
            containerOuterHtmlLength: result.containerOuterHtmlLength
          });
        }
        if (queriesDone === 10 && itemsByCode.size === 0 && zeroItemQueries.length === 10) {
          const message = "POS returned nothing for the first 10 searches. Check wait time / minimum length.";
          sanityStopMessage = message;
          if (status) status.textContent = message;
          warn(message, zeroItemQueries);
          break;
        }

        previousSignature = result.signature;
        const enriched = result.cards
          .map(card => enrichCatalogItem(card, prefix))
          .filter(item => item.code && item.name);
        for (const item of enriched) {
          if (itemsByCode.has(item.code)) duplicatesDropped += 1;
          itemsByCode.set(item.code, item);
        }

        updateProgress();
      }

      const items = [...itemsByCode.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
      const report = {
        totalItems: items.length,
        duplicatesDropped,
        noStrengthCount: items.filter(item => !item.strength).length,
        failedPrefixes,
        zeroItemQueries,
        sampleItems: randomCatalogItems(items, 10)
      };
      await new Promise(resolve => saveCatalog({ harvestedAt: new Date().toISOString(), items }, resolve));
      renderCatalogReport(report);
      if (status) status.textContent = sanityStopMessage || (run.stop
        ? `Catalog build stopped: ${queriesDone} done / ${queue.length} queued / ${items.length} items found`
        : `Catalog build complete: ${queriesDone} done / ${items.length} items found`);
      log("[VoicePOS] Catalog report", report);
    } finally {
      run.active = false;
      if (catalogHarvestRun === run) catalogHarvestRun = null;
      if (buildButton) buildButton.disabled = false;
      if (stopButton) stopButton.disabled = true;
    }
  }

  function stopCatalogBuild() {
    if (catalogHarvestRun) catalogHarvestRun.stop = true;
    const status = document.querySelector(".voice-pos-catalog-status");
    if (status) status.textContent = "Stopping catalog build after the current prefix...";
  }

  function downloadCatalog() {
    getCatalog(catalog => {
      const blob = new Blob([JSON.stringify(catalog, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "catalog.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  function importCatalogFile(file) {
    const status = document.querySelector(".voice-pos-catalog-status");
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      try {
        const parsed = JSON.parse(String(reader.result || "{}"));
        if (!parsed || !Array.isArray(parsed.items)) throw new Error("Expected { harvestedAt, items[] }");
        const items = parsed.items
          .map(item => ({
            ...enrichCatalogItem({
            code: item.code,
            name: item.name,
            price: item.price,
            discoveredFromQuery: item.discoveredFromPrefix
            }, item.discoveredFromPrefix || "import"),
            strength: String(item.strength || enrichCatalogItem(item).strength || ""),
            normalizedName: String(item.normalizedName || normalizeProductName(item.name || "")),
            discoveredFromPrefix: String(item.discoveredFromPrefix || "import")
          }))
          .filter(item => item.code && item.name);
        saveCatalog({ harvestedAt: parsed.harvestedAt || new Date().toISOString(), items }, () => {
          if (status) status.textContent = `Imported catalog: ${items.length} items`;
        });
      } catch (error) {
        if (status) status.textContent = `Import failed: ${error.message || error}`;
      }
    }, { once: true });
    reader.readAsText(file);
  }

  function canStopDiscovery(match) {
    // A phonetic boost must never hide other possible spellings from discovery.
    return !!match?.confident && match.exactNameMatch === true;
  }

  async function addProduct(productName, quantity, internalOptions = {}) {
    const required = ["searchInput", "productCards", "productCardName", "calculatorModal",
      "calculatorQtyDisplay", "calculatorNumberButtons", "calculatorQtyButton",
      "calculatorConfirmButton"];
    const missing = required
      .filter(key => !CONFIG[key]);
    if (missing.length) throw new Error(`DOM automation is not configured. Missing selectors: ${missing.join(", ")}`);
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error("Quantity must be a positive integer");
    if (!String(productName || "").trim()) throw new Error("Product name is required");
    if (!extractSearchParts(productName).valid) throw new Error("Product strength or size could not be parsed safely.");

    log("[1/8] Locating main product search input");
    const search = await waitForElement(CONFIG.searchInput, { timeout: CONFIG.stageTimeout });
    const originalQuery = normalizeSearchQuery(productName);
    const resolvedCandidate = internalOptions.resolvedCandidate || null;
    let winningCandidate = resolvedCandidate;
    if (resolvedCandidate) {
      log("Using reranker-resolved candidate identity without fuzzy rematching", {
        code: resolvedCandidate.code || "(none)", name: resolvedCandidate.name
      });
    } else {
    const fallbackQueries = buildSearchFallbacks(productName);
    log("[VoicePOS] Original query:", originalQuery);
    const gathered = new Map();
    let currentCards = [];
    let match = null;
    const prefixQuerySet = new Set(buildNamePrefixQueries(extractSearchParts(productName).words.join(" ")));
    const prefixCandidateKeys = new Set();
    const actuallySearched = new Set();

    for (const [index, query] of fallbackQueries.entries()) {
      if (prefixQuerySet.has(query) && query.length === 2 && prefixCandidateKeys.size >= 3) {
        log(`[VoicePOS] Prefix candidate pool has ${prefixCandidateKeys.size} products; skipping shorter prefix "${query}"`);
        continue;
      }
      log(`[VoicePOS] Search attempt ${index + 1}:`, query);
      currentCards = await searchProductCards(search, query);
      actuallySearched.add(query);
      log(`[VoicePOS] Results found: ${currentCards.length}`);
      for (const card of currentCards) {
        const key = card.code ? `code:${card.code}` : `name:${card.normalizedName}`;
        if (!card.normalizedName) continue;
        gathered.set(key, card);
        if (prefixQuerySet.has(query) && candidateMatchesStrength(card, productName)) prefixCandidateKeys.add(key);
        log("[VoicePOS] Candidate discovered:", `code=${card.code || "(none)"}`, `name="${card.name}"`, `price=${card.price || "(none)"}`, `query="${card.discoveredFromQuery}"`);
      }
      if (!currentCards.length) continue;

      match = findBestProductMatch(productName, [...gathered.values()]);
      for (const candidate of match?.candidates || []) logScoredCandidate(candidate);
      if (canStopDiscovery(match)) {
        log("[VoicePOS] Best candidate:", match.product.name);
        log("[VoicePOS] Confidence:", match.score.toFixed(3));
        log("[VoicePOS] High-confidence name and strength match found; stopping fallback searches");
        break;
      }
    }

    match = findBestProductMatch(productName, [...gathered.values()]);
    for (const candidate of match?.candidates || []) logScoredCandidate(candidate);
    let resolvedByMerge = false;
    let mergeFallbackRan = false;
    if (!match?.confident) {
      const mergeParts = getMergeQueryParts(productName);
      log('[VoicePOS] Original namePart:', JSON.stringify(mergeParts.namePart));
      if (match?.product) log(`[VoicePOS] Original match insufficient; best score=${Number(match.score).toFixed(2)}`);
      const variants = generateNameMergeVariants(mergeParts.namePart);
      log("[VoicePOS] Generated merge variants:", variants);
      if (variants.length) {
        mergeFallbackRan = true;
        const attempts = match ? [{ queryVariant: productName, match }] : [];
        let globalMatch = attempts.length ? mergeScoringAttempts(attempts) : null;
        let stopMergeSearch = false;
        const searchedMergeQueries = new Set(actuallySearched);
        for (const variant of variants) {
          const mergedQuery = normalizeSearchQuery(`${variant} ${mergeParts.strength}`).trim();
          log('[VoicePOS] Trying merged product query:', JSON.stringify(mergedQuery));
          const mergePrefixQueries = new Set(buildNamePrefixQueries(extractSearchParts(mergedQuery).words.join(" ")));
          const mergePrefixCandidateKeys = new Set();
          for (const [searchIndex, query] of buildSearchFallbacks(mergedQuery).entries()) {
            if (searchedMergeQueries.has(query)) continue;
            if (mergePrefixQueries.has(query) && query.length === 2 && mergePrefixCandidateKeys.size >= 3) {
              log(`[VoicePOS] Merge prefix candidate pool has ${mergePrefixCandidateKeys.size} products; skipping shorter prefix "${query}"`);
              continue;
            }
            searchedMergeQueries.add(query);
            log(`[VoicePOS] Merge search attempt ${searchIndex + 1}:`, query);
            const mergeCards = await searchProductCards(search, query);
            for (const card of mergeCards) {
              const key = card.code ? `code:${card.code}` : `name:${card.normalizedName}`;
              if (!card.normalizedName) continue;
              gathered.set(key, card);
              if (mergePrefixQueries.has(query) && candidateMatchesStrength(card, productName)) mergePrefixCandidateKeys.add(key);
              log('[VoicePOS] Merge candidate discovered:', `code=${card.code || "(none)"}`, `name="${card.name}"`);
            }

            if (!attempts.some(attempt => attempt.queryVariant === mergedQuery)) attempts.push({ queryVariant: mergedQuery });
            if (!attempts.some(attempt => attempt.queryVariant === productName)) attempts.push({ queryVariant: productName });
            // Newly discovered cards must also be compared with every earlier representation.
            for (const attempt of attempts) attempt.match = findBestProductMatch(attempt.queryVariant, [...gathered.values()]);
            const mergedMatch = attempts.find(attempt => attempt.queryVariant === mergedQuery).match;
            for (const candidate of mergedMatch?.candidates || []) {
              const queryName = extractSearchParts(mergedQuery).words.join(" ");
              const candidateName = extractSearchParts(candidate.product.name).words.join(" ");
              log('[VoicePOS] Merge candidate scoring:', {
                queryName,
                candidateName,
                stringSimilarity: candidate.rawNameSimilarity.toFixed(2),
                phoneticMatch: candidate.phoneticMatch,
                effectiveSimilarity: candidate.effectiveNameSimilarity.toFixed(2),
                strengthMatch: candidate.strengthMatch,
                finalScore: candidate.score.toFixed(3)
              });
            }
            globalMatch = mergeScoringAttempts(attempts);
            if (canStopDiscovery(globalMatch)) {
              log('[VoicePOS] Merge variant improved match');
              log('[VoicePOS] Merge variant resolved product confidently:', globalMatch.product?.name);
              stopMergeSearch = true;
              break;
            }
          }
          // Rescore even if all discovery queries for this representation were already run.
          if (!attempts.some(attempt => attempt.queryVariant === mergedQuery)) attempts.push({ queryVariant: mergedQuery });
          if (!attempts.some(attempt => attempt.queryVariant === productName)) attempts.push({ queryVariant: productName });
          for (const attempt of attempts) attempt.match = findBestProductMatch(attempt.queryVariant, [...gathered.values()]);
          globalMatch = mergeScoringAttempts(attempts);
          if (stopMergeSearch) break;
        }
        if (globalMatch) {
          if (!globalMatch.confident) log('[VoicePOS] No merge variant produced a confident product match');
          else log('[VoicePOS] Merge variant improved match');
          match = globalMatch;
          resolvedByMerge = !!globalMatch.confident;
        }
      }
    }
    if (internalOptions.voiceContext) {
      winningCandidate = await resolveVoiceCandidateAgreement({
        deterministicMatch: match?.confident ? match : null,
        candidates: [...gathered.values()],
        transcript: internalOptions.voiceContext.transcript,
        productName,
        quantity
      });
    } else {
      if (!match?.confident) {
        if (!mergeFallbackRan) log('[VoicePOS] No merge variants were available for this product name');
        const candidates = match?.candidates || [];
        const possibleMatches = candidates.length
          ? `\nPossible matches:\n${candidates.map(candidate => `- ${candidate.product.name}`).join("\n")}`
          : "\nNo visible POS products were returned.";
        throw new Error(`Could not confidently identify “${originalQuery}”.${possibleMatches}`);
      }
      winningCandidate = match.product;
    }
    if (resolvedByMerge && !internalOptions.voiceContext) log('[VoicePOS] Merge variant resolved product confidently');
    log("[VoicePOS] Winning candidate:", `code=${winningCandidate.code || "(none)"}`, `name="${winningCandidate.name}"`);
    if (!internalOptions.voiceContext) {
      log(`[VoicePOS] Candidate: ${winningCandidate.name}`);
      logScoredCandidate(match);
      log("[VoicePOS] Best candidate:", winningCandidate.name);
      log("[VoicePOS] Confidence:", Number(match.score).toFixed(3));
    }
    }
    let clickCard = null;
    let reopened = false;
    const storedElement = winningCandidate.element;
    if (storedElement?.isConnected && isVisible(storedElement)) {
      const currentIdentity = extractProductCardData(storedElement);
      const sameCode = winningCandidate.code && currentIdentity.code === winningCandidate.code;
      const sameName = currentIdentity.normalizedName === winningCandidate.normalizedName;
      if (sameCode || (!winningCandidate.code && sameName)) clickCard = storedElement;
    }

    if (clickCard) {
      log("[VoicePOS] Winning card still visible; clicking directly");
    } else {
      log("[VoicePOS] Winning card no longer visible");
      if (winningCandidate.code) {
        log("[VoicePOS] Reopening by product code:", winningCandidate.code);
        const codeResults = await searchProductCards(search, winningCandidate.code);
        clickCard = codeResults.find(card => card.code === winningCandidate.code)?.element || null;
        if (clickCard) {
          reopened = true;
          log("[VoicePOS] Exact product code located");
        }
      }
      if (!clickCard && winningCandidate.name) {
        log("[VoicePOS] Reopening by exact product name:", winningCandidate.name);
        const nameResults = await searchProductCards(search, winningCandidate.name);
        clickCard = nameResults.find(card => card.normalizedName === winningCandidate.normalizedName)?.element || null;
        if (clickCard) reopened = true;
      }
    }
    if (!clickCard) throw new Error(`Could not reopen selected POS product “${winningCandidate.name}” by exact code or name.`);
    if (!candidateMatchesStrength(extractProductCardData(clickCard), productName)) {
      throw new Error("The reopened product does not match the requested strength. Product submission stopped.");
    }
    log(reopened ? "[VoicePOS] Clicking reopened product" : "[VoicePOS] Clicking winning product card");
    clickCard.click();

    log("[VoicePOS] Calculator detected");
    let modal;
    try {
      modal = await waitForElement(CONFIG.calculatorModal, { timeout: 10000 });
      await waitForCondition(() => isVisible(modal), "calculator visibility", 10000);
    } catch (error) { throw new Error(`Calculator detection stage failed: ${error.message}`); }

    const output = modal.querySelector(CONFIG.calculatorQtyDisplay);
    const readValue = element => (element && "value" in element ? element.value : element?.innerText || element?.textContent || "").trim();
    const clickableElements = () => [...modal.querySelectorAll(CONFIG.calculatorNumberButtons)]
      .filter(el => isVisible(el) && (/^(A|BUTTON|TD)$/.test(el.tagName) || el.getAttribute("role") === "button" || getComputedStyle(el).cursor === "pointer"));
    const clickableFor = text => {
      const exact = clickableElements().filter(el => (el.textContent || "").trim() === text);
      return exact.find(el => /^(A|BUTTON)$/.test(el.tagName) || el.getAttribute("role") === "button") || exact[0];
    };
    const quantityCandidates = () => {
      const found = new Set([output, ...modal.querySelectorAll("input, textarea, select")]);
      for (const el of modal.querySelectorAll("*")) {
        if (!isVisible(el)) continue;
        const text = (el.textContent || "").trim();
        if (/\bqty\b|\bquantity\b/i.test(text)) {
          found.add(el);
          if (el.nextElementSibling) found.add(el.nextElementSibling);
          if (el.parentElement) found.add(el.parentElement);
        }
      }
      return [...found].filter(isVisible);
    };
    const logQuantityCandidates = label => {
      const candidates = quantityCandidates().map(el => ({ tag: el.tagName, text: (el.textContent || "").trim(), value: "value" in el ? el.value : undefined, html: el.outerHTML.slice(0, 350) }));
      log(`${label}; quantity candidates`, candidates);
      return candidates;
    };
    const snapshot = () => ({ output: readValue(output), quantities: quantityCandidates().map(readValue) });
    const matchesQty = value => new RegExp(`(^|\\D)${quantity}(\\D|$)`).test(String(value || ""));
    const readNumericQuantity = () => {
      const rawOutput = readValue(output);
      const outputNumber = Number.parseInt(String(rawOutput).trim(), 10);
      if (Number.isFinite(outputNumber)) return outputNumber;
      for (const candidate of quantityCandidates()) {
        const raw = readValue(candidate);
        const labelled = raw.match(/\b(?:qty|quantity)\s*:?\s*(\d+)/i);
        const parsed = Number.parseInt(labelled?.[1] || raw.trim(), 10);
        if (Number.isFinite(parsed)) return parsed;
      }
      return null;
    };

    log("[VoicePOS] Looking for Q button");
    const configuredQ = modal.querySelector(CONFIG.calculatorQtyButton) || document.querySelector(CONFIG.calculatorQtyButton);
    if (configuredQ) {
      log("[VoicePOS] #calQty inspection", {
        tagName: configuredQ.tagName,
        textContent: (configuredQ.textContent || "").trim(),
        outerHTML: configuredQ.outerHTML,
        visible: isVisible(configuredQ),
        parentOuterHTML: configuredQ.parentElement?.outerHTML
      });
    } else log("[VoicePOS] #calQty not found; searching visible calculator text");
    const qTextElement = [...modal.querySelectorAll("*")].find(el => isVisible(el) && (el.textContent || "").trim() === "Q");
    const qButton = configuredQ && isVisible(configuredQ)
      ? (configuredQ.closest("a, button, td, [role='button']") || (configuredQ.matches("a, button, td, [role='button']") ? configuredQ : null))
      : qTextElement && (qTextElement.closest("a, button, td, [role='button']") || qTextElement);
    if (!qButton) throw new Error("Q button stage failed: no visible Q control found in calculator");
    log("[VoicePOS] Q button found:", qButton.outerHTML);
    const beforeQ = snapshot();
    const qLooksActive = qButton.getAttribute("aria-pressed") === "true" ||
      /(^|\s)(active|selected|current)(\s|$)/i.test(qButton.className?.baseVal || qButton.className || "");
    if (qLooksActive) {
      log("[VoicePOS] Q already appears active; not clicking again", { className: qButton.className, ariaPressed: qButton.getAttribute("aria-pressed") });
    } else {
      log("[VoicePOS] Clicking Q");
      qButton.click();
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    log("[VoicePOS] After Q click quantity snapshot:", snapshot(), "before:", beforeQ);
    logQuantityCandidates("After Q click");

    const initial = snapshot();
    if (readNumericQuantity() === quantity) log("[VoicePOS] Quantity already shows requested value", quantity);
    else {
      for (const digit of String(quantity)) {
        log(`[VoicePOS] Looking for digit ${digit}`);
        const button = clickableFor(digit);
        if (!button) throw new Error(`Keypad digit ${digit} stage failed: no visible clickable with exact text found`);
        log(`[VoicePOS] Digit ${digit} found`, button.outerHTML);
        log(`[VoicePOS] Clicking ${digit}`);
        button.click();
        await new Promise(resolve => setTimeout(resolve, 120));
        const afterClick = snapshot();
        log(`[VoicePOS] Quantity snapshot after clicking ${digit}:`, afterClick);
        logQuantityCandidates(`After clicking ${digit}`);
      }
    }
    logQuantityCandidates("Final calculator state");
    const quantityDeadline = Date.now() + 3000;
    let enteredQty = readNumericQuantity();
    while (enteredQty !== quantity && Date.now() < quantityDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      enteredQty = readNumericQuantity();
    }
    const displayText = readValue(output) || "(empty)";
    log(`[VoicePOS] Calculator output after entry: ${displayText}`);
    if (enteredQty !== quantity) {
      throw new Error(`Quantity verification failed. Expected ${quantity}, got ${enteredQty}`);
    }
    log(`[VoicePOS] Numeric quantity verified: ${enteredQty}`);
    const confirmIcon = document.querySelector(CONFIG.calculatorConfirmButton);
    const confirm = confirmIcon?.closest("button, a, [role='button']") || confirmIcon;
    log("[VoicePOS] Looking for confirm button");
    if (!confirm || !isVisible(confirm)) throw new Error("Confirm button stage failed: visible #doneAdd > i and clickable ancestor not found");
    log("[VoicePOS] Confirm button found", confirm);
    log("[VoicePOS] Clicking confirm");
    confirm.click();
    log("[VoicePOS] Waiting for calculator to close");
    try {
      await waitForCondition(() => !document.querySelector(CONFIG.calculatorModal) || !isVisible(document.querySelector(CONFIG.calculatorModal)), "calculator close", 10000);
    } catch (error) { throw new Error(`Calculator close stage failed: ${error.message}`); }

    log("[VoicePOS] Product submission completed");
    return { productName, quantity, selected: winningCandidate.name, code: winningCandidate.code };
  }

  function productStrength(name) {
    return extractSearchParts(name || "").strength;
  }

  function productIdentityKey(candidate) {
    return candidate?.code
      ? `code:${candidate.code}`
      : `name:${normalizeCandidateProduct(candidate?.name || "")}`;
  }

  function candidateMatchesStrength(candidate, productName) {
    return !!candidate && globalThis.VoicePOSProductIdentity.strengthMatches(productName, candidate.name);
  }

  function uniqueScoredCatalogCandidates(scoredCandidates) {
    const unique = new Map();
    for (const scored of scoredCandidates || []) {
      const product = scored?.product;
      if (!product?.name) continue;
      const key = productIdentityKey(product);
      const existing = unique.get(key);
      if (!existing || scored.score > existing.score) unique.set(key, scored);
    }
    return [...unique.values()].sort((a, b) => b.score - a.score);
  }

  function topCatalogProductsForRerank(match, productName) {
    const scored = uniqueScoredCatalogCandidates(match?.candidates || []);
    const strengthCompatible = scored.filter(candidate => candidateMatchesStrength(candidate.product, productName));
    const fallback = scored.filter(candidate => !strengthCompatible.includes(candidate));
    return [...strengthCompatible, ...fallback]
      .slice(0, CONFIG.catalogRerankMaxCandidates)
      .map(candidate => candidate.product);
  }

  function matchCatalogProduct(productName, catalogItems) {
    const candidates = catalogItems
      .filter(item => item?.code && item?.name)
      .map(item => ({
        code: String(item.code),
        name: String(item.name),
        price: String(item.price || ""),
        normalizedName: item.normalizedName || normalizeCandidateProduct(item.name),
        discoveredFromQuery: item.discoveredFromPrefix || "catalog"
      }));
    const directMatch = findBestProductMatch(productName, candidates);
    const attempts = directMatch ? [{ queryVariant: productName, match: directMatch }] : [];
    let bestMatch = directMatch;
    const mergeParts = getMergeQueryParts(productName);
    for (const variant of generateNameMergeVariants(mergeParts.namePart)) {
      const mergedQuery = normalizeSearchQuery(`${variant} ${mergeParts.strength}`).trim();
      if (!mergedQuery || attempts.some(attempt => attempt.queryVariant === mergedQuery)) continue;
      const match = findBestProductMatch(mergedQuery, candidates);
      if (match) attempts.push({ queryVariant: mergedQuery, match });
    }
    const mergedMatch = attempts.length ? mergeScoringAttempts(attempts) : null;
    if (mergedMatch?.product && (!bestMatch?.product || mergedMatch.score > bestMatch.score || mergedMatch.confident)) bestMatch = mergedMatch;
    return { match: bestMatch, candidates };
  }

  async function resolveVoiceProductFromCatalog({ transcript, productName, quantity }) {
    const catalog = await getCatalogWithBundledFallback();
    const items = Array.isArray(catalog.items) ? catalog.items : [];
    if (!items.length) throw new Error("Local catalog is empty. Build, import, or reload the bundled pos_catalog.json before using voice orders.");
    const { match } = matchCatalogProduct(productName, items);
    if (match?.product) {
      log(`[VoicePOS] Catalog deterministic result: ${match.product.name} (${Number(match.score).toFixed(2)})`);
    } else log("[VoicePOS] Catalog deterministic result: candidate none found");
    for (const candidate of match?.candidates?.slice(0, CONFIG.catalogRerankMaxCandidates) || []) logScoredCandidate(candidate);
    const rerankCandidates = topCatalogProductsForRerank(match, productName);
    if (!rerankCandidates.length) throw new Error(`No local catalog candidates matched “${normalizeSearchQuery(productName)}”.`);
    return rerankCatalogCandidates({ transcript, quantity, productName, candidates: rerankCandidates });
  }

  async function rerankCatalogCandidates({ transcript, quantity, productName, candidates }) {
    const parsed = extractSearchParts(productName);
    const requestCandidates = candidates.map((candidate, index) => ({
      index: index + 1,
      code: candidate.code || "",
      name: candidate.name,
      strength: productStrength(candidate.name),
      candidate
    }));
    log(`[VoicePOS] Sending ${requestCandidates.length} local catalog candidates to LLM reranker`);
    log("[VoicePOS] LLM transcript input:", transcript);
    log("[VoicePOS] LLM candidates:", requestCandidates.map(({ index, code, name, strength }) => ({ index, code, name, strength })));
    const statusElement = document.querySelector(".voice-pos-recording-status");
    if (statusElement) statusElement.textContent = "Checking local catalog candidates...";

    let selectedIndex = 0;
    let rerankerStatus = "unavailable";
    try {
      const response = await fetch("http://localhost:3001/rerank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          quantity,
          namePart: parsed.words.join(" "),
          strength: parsed.strength,
          candidates: requestCandidates.map(({ index, code, name, strength }) => ({ index, code, name, strength }))
        }),
        signal: AbortSignal.timeout(CONFIG.rerankTimeoutMs)
      });
      const result = await response.json();
      log("[VoicePOS] Catalog reranker endpoint response:", result);
      rerankerStatus = response.ok ? result?.status || "invalid_response" : "unavailable";
      if (response.ok && rerankerStatus === "ok" && Number.isInteger(result?.selectedIndex) &&
          result.selectedIndex > 0 && result.selectedIndex <= requestCandidates.length) {
        selectedIndex = result.selectedIndex;
      } else if (rerankerStatus === "ok") rerankerStatus = "invalid_response";
    } catch (error) {
      rerankerStatus = ["TimeoutError", "AbortError"].includes(error?.name) ? "timeout" : "unavailable";
      warn("Catalog reranker request failed; treating its result as uncertain:", error?.message || error);
    }

    const selected = selectedIndex > 0 ? requestCandidates[selectedIndex - 1]?.candidate || null : null;
    if (!selected) throw new Error("Could not confidently identify the medicine.");
    if (!candidateMatchesStrength(selected, productName)) {
      log("[VoicePOS] Catalog reranker choice rejected by strength cross-check", { expected: parsed.strength, actual: productStrength(selected.name) });
      throw new Error("Could not confidently identify the medicine.");
    }
    log(`[VoicePOS] Catalog reranker selected: ${selected.name} (candidate ${selectedIndex})`);
    return selected;
  }

  async function resolveVoiceCandidateAgreement({ deterministicMatch, candidates, transcript, productName, quantity }) {
    const parsed = extractSearchParts(productName);
    const discovered = candidates.filter(candidate => candidate?.name);
    const requestCandidates = discovered.map((candidate, index) => ({
      index: index + 1,
      code: candidate.code || "",
      name: candidate.name,
      strength: productStrength(candidate.name),
      candidate
    }));
    const deterministicCandidate = deterministicMatch?.product || null;
    if (deterministicCandidate) {
      log(`[VoicePOS] Deterministic result: ${deterministicCandidate.name} (${Number(deterministicMatch.score).toFixed(2)})`);
    } else log("[VoicePOS] Deterministic result: candidate none found");
    log(`[VoicePOS] Sending ${requestCandidates.length} candidates to LLM reranker`);
    log("[VoicePOS] LLM transcript input:", transcript);
    log("[VoicePOS] LLM candidates:", requestCandidates.map(({ index, code, name, strength }) => ({ index, code, name, strength })));

    let selectedIndex = 0;
    let rerankerStatus = "unavailable";
    const statusElement = document.querySelector(".voice-pos-recording-status");
    if (statusElement) statusElement.textContent = "Checking product agreement...";
    try {
      const response = await fetch("http://localhost:3001/rerank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          quantity,
          namePart: parsed.words.join(" "),
          strength: parsed.strength,
          candidates: requestCandidates.map(({ index, code, name, strength }) => ({ index, code, name, strength }))
        }),
        signal: AbortSignal.timeout(CONFIG.rerankTimeoutMs)
      });
      const result = await response.json();
      log('[VoicePOS] Reranker endpoint response:', result);
      rerankerStatus = response.ok ? result?.status || "invalid_response" : "unavailable";
      if (response.ok && rerankerStatus === "ok" && Number.isInteger(result?.selectedIndex) && result.selectedIndex > 0 && result.selectedIndex <= requestCandidates.length) {
        selectedIndex = result.selectedIndex;
      } else if (rerankerStatus === "ok") {
        rerankerStatus = "invalid_response";
      }
    } catch (rerankError) {
      rerankerStatus = ["TimeoutError", "AbortError"].includes(rerankError?.name) ? "timeout" : "unavailable";
      warn("Reranker request failed; treating its result as uncertain:", rerankError?.message || rerankError);
    }
    log("[VoicePOS] Parsed selected index:", selectedIndex);
    let rerankerCandidate = selectedIndex > 0 ? requestCandidates[selectedIndex - 1]?.candidate || null : null;
    if (rerankerCandidate && !candidateMatchesStrength(rerankerCandidate, productName)) {
      log("[VoicePOS] Reranker choice rejected by strength cross-check", { expected: parsed.strength, actual: productStrength(rerankerCandidate.name) });
      selectedIndex = 0;
      rerankerCandidate = null;
      rerankerStatus = "strength_rejected";
    }
    if (selectedIndex > 0 && rerankerCandidate) {
      log(`[VoicePOS] Reranker result: ${rerankerCandidate.name} (candidate ${selectedIndex})`);
    } else log("[VoicePOS] Reranker result:", describeRerankerStatus(rerankerStatus));

    if (!deterministicCandidate && !rerankerCandidate) {
      log("[VoicePOS] Agreement: NONE — no confident candidate");
      const possibleMatches = discovered.length ? `\nPossible matches:\n${discovered.map(candidate => `- ${candidate.name}`).join("\n")}` : "\nNo visible POS products were returned.";
      throw new Error(`Could not confidently identify “${normalizeSearchQuery(productName)}”. AI check: ${describeRerankerStatus(rerankerStatus)}.${possibleMatches}`);
    }

    if (deterministicCandidate && rerankerCandidate && productIdentityKey(deterministicCandidate) === productIdentityKey(rerankerCandidate)) {
      if (!candidateMatchesStrength(deterministicCandidate, productName)) {
        throw new Error(`Selected product strength did not match ${parsed.strength}.`);
      }
      log("[VoicePOS] Agreement: MATCH — auto-proceeding");
      return deterministicCandidate;
    }

    log("[VoicePOS] Agreement: DISAGREEMENT — routing to confirmation");
    const humanChoice = await showAgreementConfirmation({
      transcript,
      quantity,
      productName,
      deterministicCandidate,
      deterministicScore: deterministicMatch?.score,
      rerankerCandidate,
      rerankerStatus,
      rerankerIndex: selectedIndex
    });
    if (!humanChoice) throw new Error("Product addition canceled.");
    if (!candidateMatchesStrength(humanChoice, productName)) {
      throw new Error(`Selected product strength did not match ${parsed.strength}. No product was added.`);
    }
    log("[VoicePOS] Human selected candidate:", `${humanChoice.name} / ${humanChoice.code || "(no code)"}`);
    return humanChoice;
  }

  async function addProductByResolvedCandidate(candidate, quantity) {
    if (!candidate?.name) throw new Error("Resolved POS candidate is missing its product name.");
    return addProduct(candidate.name, quantity, { resolvedCandidate: candidate });
  }

  function describeRerankerStatus(status) {
    return ({ uncertain: "uncertain", no_candidates: "no candidates available", timeout: "unavailable — timed out",
      rate_limited: "unavailable — rate limit reached", not_configured: "unavailable — backend key is missing",
      truncated: "unavailable — model answer was truncated", invalid_response: "unavailable — invalid model response",
      strength_rejected: "rejected — strength mismatch", invalid_request: "unavailable — invalid request",
      provider_error: "unavailable — provider error", unavailable: "unavailable — connection or backend failure" })[status] || "unavailable — unrecognized response";
  }

  function showAgreementConfirmation({ transcript, quantity, productName, deterministicCandidate, deterministicScore, rerankerCandidate, rerankerIndex, rerankerStatus }) {
    return new Promise(resolve => {
      document.querySelector(".voice-pos-rerank-confirm")?.remove();
      const panel = document.createElement("section");
      panel.className = "voice-pos-rerank-confirm";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "Resolve product match disagreement");
      const heard = document.createElement("p");
      heard.textContent = `Voice sounded like: “${transcript}”`;
      const deterministic = document.createElement("p");
      deterministic.textContent = deterministicCandidate
        ? `Deterministic match: ${deterministicCandidate.name} (${Number(deterministicScore).toFixed(2)})`
        : "Deterministic match: no confident candidate";
      const reranker = document.createElement("p");
      reranker.textContent = rerankerCandidate
        ? `AI reranker match: ${rerankerCandidate.name} (candidate ${rerankerIndex})`
        : `AI reranker match: ${describeRerankerStatus(rerankerStatus)}`;
      const qty = document.createElement("p");
      qty.textContent = `Quantity: ${quantity}`;
      const actions = document.createElement("div");
      actions.className = "voice-pos-rerank-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        panel.remove();
        resolve(value);
      };
      const options = [];
      if (deterministicCandidate && candidateMatchesStrength(deterministicCandidate, productName)) {
        options.push({ label: `Use deterministic: ${deterministicCandidate.name}`, candidate: deterministicCandidate });
      }
      if (rerankerCandidate && (!deterministicCandidate || productIdentityKey(rerankerCandidate) !== productIdentityKey(deterministicCandidate)) &&
          candidateMatchesStrength(rerankerCandidate, productName)) {
        options.push({ label: `Use AI match: ${rerankerCandidate.name}`, candidate: rerankerCandidate });
      }
      for (const option of options) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = option.label;
        button.addEventListener("click", () => finish(option.candidate), { once: true });
        actions.append(button);
      }
      cancel.addEventListener("click", () => finish(false), { once: true });
      actions.append(cancel);
      panel.append(heard, deterministic, reranker, qty, actions);
      document.body.append(panel);
    });
  }

  // Future optional bill verification, deliberately not called by the MVP flow.
  function verifyBillRow(productName, quantity) {
    const desiredNorm = normalizeProductName(productName);
    return [...document.querySelectorAll(CONFIG.billRows)].some(row => {
      if (!isVisible(row)) return false;
      const text = normalizeProductName(row.innerText || row.textContent || "");
      return text.includes(desiredNorm) && new RegExp(`(^|\\D)${quantity}(\\D|$)`).test(row.innerText || row.textContent || "");
    });
  }

  function isVisible(el) { return !!el && el.getClientRects().length > 0; }

  function waitForCondition(check, description, timeout = CONFIG.stageTimeout) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        let value;
        try { value = check(); } catch (_) { value = null; }
        if (value) return resolve(value);
        if (Date.now() - started >= timeout) return reject(new Error(`Timed out waiting for ${description}`));
        setTimeout(poll, 100);
      };
      poll();
    });
  }

  function mountTestAddButton() {
    if (document.querySelector(".voice-pos-test-add")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "voice-pos-test-add";
    button.textContent = "TEST ADD";
    button.setAttribute("aria-label", "Test add Losacar 50mg quantity 10");
    button.style.cssText = "position:fixed;right:190px;bottom:24px;z-index:2147483647;padding:12px 16px;border:0;border-radius:8px;background:#f59e0b;color:#111827;font:700 14px sans-serif;box-shadow:0 3px 12px #0004;cursor:pointer";
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      const priorText = button.textContent;
      button.textContent = "ADDING…";
      console.log("[VoicePOS] Test started");
      try {
        await addProduct("Losacar 50mg", 10);
        console.log("[VoicePOS] Test completed");
        button.textContent = "ADDED ✓";
      } catch (error) {
        console.error(`[VoicePOS] Test failed: ${error?.message || error}`, error);
        warn("TEST ADD stopped:", error);
        button.textContent = "TEST FAILED";
        button.title = error.message;
        setTimeout(() => {
          if (!button.isConnected) return;
          button.textContent = priorText;
          button.title = "";
          button.disabled = false;
        }, 4000);
        return;
      }
      setTimeout(() => {
        if (!button.isConnected) return;
        button.textContent = priorText;
        button.disabled = false;
      }, 2000);
    });
    document.body.append(button);
    log("Temporary TEST ADD button mounted");
  }

  function mountCatalogControls() {
    if (document.querySelector(".voice-pos-catalog-panel")) return;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "voice-pos-catalog-toggle";
    toggle.textContent = "Catalog";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", "voice-pos-catalog-panel");

    const panel = document.createElement("section");
    panel.id = "voice-pos-catalog-panel";
    panel.className = "voice-pos-catalog-panel";
    panel.hidden = true;
    panel.setAttribute("aria-label", "Catalog builder");

    const build = document.createElement("button");
    build.type = "button";
    build.className = "voice-pos-catalog-build";
    build.textContent = "Start catalog scan";
    build.addEventListener("click", () => {
      buildCatalog().catch(error => {
        console.error("[VoicePOS] Catalog build failed:", error);
        const status = document.querySelector(".voice-pos-catalog-status");
        if (status) status.textContent = `Catalog build failed: ${error.message || error}`;
        const buildButton = document.querySelector(".voice-pos-catalog-build");
        const stopButton = document.querySelector(".voice-pos-catalog-stop");
        if (buildButton) buildButton.disabled = false;
        if (stopButton) stopButton.disabled = true;
      });
    });

    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "voice-pos-catalog-stop";
    stop.textContent = "Stop scan";
    stop.disabled = true;
    stop.addEventListener("click", stopCatalogBuild);

    const download = document.createElement("button");
    download.type = "button";
    download.className = "voice-pos-catalog-download";
    download.textContent = "Save catalog.json";
    download.addEventListener("click", downloadCatalog);

    const importButton = document.createElement("button");
    importButton.type = "button";
    importButton.className = "voice-pos-catalog-import";
    importButton.textContent = "Import catalog.json";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.className = "voice-pos-catalog-file";
    input.addEventListener("change", () => {
      importCatalogFile(input.files?.[0]);
      input.value = "";
    });
    importButton.addEventListener("click", () => input.click());

    const status = document.createElement("div");
    status.className = "voice-pos-catalog-status";
    status.setAttribute("role", "status");
    status.textContent = "Catalog idle";

    toggle.addEventListener("click", () => {
      const nextHidden = !panel.hidden;
      panel.hidden = nextHidden;
      toggle.setAttribute("aria-expanded", String(!nextHidden));
    });

    panel.append(build, stop, download, importButton, input, status);
    document.body.append(toggle);
    document.body.append(panel);
    log("Catalog launcher mounted");
  }

  function microphoneStreamIsActive() {
    return !!mediaStream && mediaStream.getAudioTracks().some(track => track.readyState === "live");
  }

  async function ensureMicrophoneStream() {
    if (microphoneStreamIsActive()) return mediaStream;
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true
      }
    });
    for (const track of mediaStream.getTracks()) {
      track.addEventListener?.("ended", () => {
        if (!microphoneStreamIsActive()) {
          mediaStream = null;
          resetMicButton();
          const status = document.querySelector(".voice-pos-recording-status");
          if (status) status.textContent = "Microphone disconnected. Click Speak order to reconnect.";
        }
      }, { once: true });
    }
    return mediaStream;
  }

  async function toggleRecording() {
    if (microphoneRequestPending) return;
    const micButton = document.querySelector(".voice-pos-mic");
    const status = document.querySelector(".voice-pos-recording-status");
    if (mediaRecorder?.state === "recording") {
      micButton.textContent = "Finishing recording...";
      micButton.disabled = true;
      mediaRecorder.stop();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      const message = "Audio recording is unavailable. Use a supported browser on HTTPS or localhost.";
      console.error("[VoicePOS] Microphone error:", message);
      if (status) status.textContent = message;
      return;
    }

    microphoneRequestPending = true;
    if (micButton) { micButton.disabled = true; micButton.textContent = "Requesting microphone..."; }
    if (status) status.textContent = "Requesting microphone access...";
    log("Requesting microphone");
    try {
      const stream = await ensureMicrophoneStream();
      const audioTrack = stream.getAudioTracks()[0];
      log("Microphone ready");
      if (audioTrack?.getSettings) log("Microphone audio settings:", audioTrack.getSettings());
      recordedChunks = [];
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
        .find(type => MediaRecorder.isTypeSupported?.(type));
      mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorder.addEventListener("dataavailable", event => {
        if (!event.data || event.data.size === 0) return;
        recordedChunks.push(event.data);
        log("Recording chunk received:", event.data.size, "bytes");
      });
      mediaRecorder.addEventListener("error", event => {
        const error = event.error || event;
        console.error("[VoicePOS] Recording error:", error);
        if (status) status.textContent = `Recording failed: ${error.message || error.name || "unknown error"}`;
        mediaRecorder = null;
        resetMicButton();
      });
      mediaRecorder.addEventListener("stop", async () => {
        log("Recording stopped");
        const recorderMimeType = mediaRecorder?.mimeType || "audio/webm";
        mediaRecorder = null;
        const blob = new Blob(recordedChunks, { type: recorderMimeType });
        log("Audio blob created:", blob.size, "bytes");
        log("Audio size:", blob.size);
        if (blob.size > 0) {
          await transcribeRecording(blob);
        } else {
          const message = "No audio data was recorded. Check microphone input and try again.";
          console.error("[VoicePOS] Recording error:", message);
          if (status) {
            status.className = "voice-pos-recording-status voice-pos-transcription-error";
            status.textContent = message;
          }
          resetMicButton();
        }
      }, { once: true });
      mediaRecorder.start(500);
      log("Recording started");
      if (micButton) {
        micButton.disabled = false;
        micButton.textContent = "Recording... click to stop";
        micButton.setAttribute("aria-label", "Recording... click to stop");
      }
      if (status) {
        status.className = "voice-pos-recording-status";
        status.textContent = "Recording this order. Audio is sent only after you stop.";
      }
    } catch (error) {
      stopMicrophoneTracks();
      const message = error?.name === "NotAllowedError"
        ? "Microphone permission was denied. Allow microphone access and try again."
        : error?.name === "NotFoundError"
          ? "No microphone was found. Connect or enable a microphone and try again."
          : `Could not start recording: ${error?.message || error}`;
      console.error("[VoicePOS] Microphone error:", error?.name || "Error", error);
      if (status) status.textContent = message;
      resetMicButton();
    } finally {
      microphoneRequestPending = false;
    }
  }

  function stopMicrophoneTracks() {
    if (!mediaStream) return;
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
    mediaRecorder = null;
    const status = document.querySelector(".voice-pos-recording-status");
    if (status) status.textContent = "Microphone off.";
  }

  function resetMicButton() {
    const button = document.querySelector(".voice-pos-mic");
    if (!button) return;
    button.disabled = false;
    button.textContent = "🎙 Speak order";
    button.setAttribute("aria-label", microphoneStreamIsActive()
      ? "Record one order using the ready microphone"
      : "Start microphone and record one order");
    const release = document.querySelector(".voice-pos-release-mic");
    if (release) release.hidden = !microphoneStreamIsActive();
    const status = document.querySelector(".voice-pos-recording-status");
    if (status && microphoneStreamIsActive() && !status.textContent) {
      status.className = "voice-pos-recording-status";
      status.textContent = "Mic ready. Audio is sent only while recording.";
    }
  }

  async function transcribeRecording(blob) {
    const status = document.querySelector(".voice-pos-recording-status");
    const micButton = document.querySelector(".voice-pos-mic");
    if (!blob || blob.size === 0) {
      if (status) {
        status.className = "voice-pos-recording-status voice-pos-transcription-error";
        status.textContent = "Transcription skipped: recorded audio is empty.";
      }
      resetMicButton();
      return;
    }
    log("Sending audio for transcription");
    if (micButton) { micButton.disabled = true; micButton.textContent = "Transcribing..."; }
    if (status) {
      status.className = "voice-pos-recording-status";
      status.textContent = "Transcribing...";
    }
    try {
      const formData = new FormData();
      formData.append("audio", blob, "voice-order.webm");
      const response = await fetch("http://localhost:3001/transcribe", {
        method: "POST",
        body: formData
      });
      let result;
      try { result = await response.json(); }
      catch { throw new Error(`Backend returned an unreadable response (HTTP ${response.status})`); }
      if (!response.ok) throw new Error(result?.error || `Transcription failed (HTTP ${response.status})`);
      const transcript = String(result?.text || "").trim();
      if (!transcript) throw new Error("Transcription returned an empty transcript.");
      log("Transcript received:", transcript);
      const items = parseOrder(transcript);
      log("Parsed items:", items);
      if (!items.length || items.some(item => !item.product?.trim() || !Number.isInteger(item.quantity) || item.quantity < 1 || item.needsCorrection)) {
        throw new Error("Voice format not understood. Say quantity first, then product.");
      }

      for (const [index, item] of items.entries()) {
        log(`Adding item ${index + 1}/${items.length}:`, `${item.product} × ${item.quantity}`);
        if (status) {
          status.className = "voice-pos-recording-status";
          status.textContent = `Matching ${item.product} × ${item.quantity} in local catalog...`;
        }
        const resolvedCandidate = await resolveVoiceProductFromCatalog({
          transcript,
          productName: item.product,
          quantity: item.quantity
        });
        if (status) {
          status.className = "voice-pos-recording-status";
          status.textContent = `Adding ${resolvedCandidate.name} × ${item.quantity}...`;
        }
        await addProductByResolvedCandidate(resolvedCandidate, item.quantity);
        log("Item added successfully", `${item.product} × ${item.quantity}`);
      }
      log("Voice order completed");
      if (status) {
        status.className = "voice-pos-recording-status voice-pos-success";
        status.textContent = "Added successfully";
      }
    } catch (error) {
      console.error("[VoicePOS] Voice order failed:", error);
      if (status) {
        status.className = "voice-pos-recording-status voice-pos-transcription-error";
        status.textContent = error?.message || "Voice order failed. Please try again.";
      }
    } finally {
      resetMicButton();
      if (status && microphoneStreamIsActive() && status.classList?.contains("voice-pos-success")) {
        setTimeout(() => {
          if (!microphoneStreamIsActive() || mediaRecorder?.state === "recording") return;
          status.className = "voice-pos-recording-status";
          status.textContent = "Mic ready. Audio is sent only while recording.";
        }, 1800);
      }
    }
  }

  function mountMicButton() {
    if (document.querySelector(".voice-pos-mic")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "voice-pos-mic";
    button.textContent = "🎙 Speak order";
    button.setAttribute("aria-label", "Start microphone and record one order");
    button.addEventListener("click", toggleRecording);
    document.body.append(button);
    const release = document.createElement("button");
    release.type = "button";
    release.className = "voice-pos-release-mic";
    release.textContent = "Release mic";
    release.hidden = true;
    release.addEventListener("click", () => {
      if (mediaRecorder?.state === "recording") mediaRecorder.stop();
      stopMicrophoneTracks();
      resetMicButton();
    });
    document.body.append(release);
    const status = document.createElement("div");
    status.className = "voice-pos-recording-status";
    status.setAttribute("role", "status");
    document.body.append(status);
    log("Microphone button mounted");
  }

  // Keep required extension functions accessible for DevTools feature checks.
  window.VoicePOS = Object.freeze({
    toggleRecording,
    parseOrder,
    normalizeProductName,
    normalizeSearchQuery,
    extractSearchParts,
    buildSearchFallbacks,
    buildNamePrefixQueries,
    searchProductCards,
    canStopDiscovery,
    getMergeQueryParts,
    generateNameMergeVariants,
    findBestProductMatch,
    normalizePhoneticName,
    getPhoneticCodes,
    phoneticCodesMatch,
    medicinePhoneticKey,
    medicinePhoneticSimilarity,
    waitForElement,
    setNativeInputValue,
    enrichCatalogItem,
    loadBundledCatalog,
    getCatalogWithBundledFallback,
    upsertCatalogItems,
    catalogSeedPrefixes,
    catalogSearchProductCards,
    buildCatalog,
    stopCatalogBuild,
    downloadCatalog,
    importCatalogFile,
    getCartHasItems,
    matchCatalogProduct,
    resolveVoiceProductFromCatalog,
    rerankCatalogCandidates,
    addProduct,
    addProductByResolvedCandidate,
    CONFIG
  });

  // Audio capture remains independent from parsing and POS automation.
  function mountDevelopmentControls() {
    mountMicButton();
    mountTestAddButton();
    mountCatalogControls();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountDevelopmentControls, { once: true });
  else mountDevelopmentControls();
})();
