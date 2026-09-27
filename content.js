(() => {
  "use strict";

  // Replace these selectors only after inspecting the target POS page.
  const CONFIG = {
    searchInput: "",
    productResults: "",
    quantityInput: "",
    addButton: "",
    checkoutButton: "",

    // Optional mapping: normalized spoken alias -> canonical product name.
    aliases: {
      "coke": "Coca Cola",
      "coca cola": "Coca Cola",
      "coca-cola": "Coca Cola"
    },
    recognitionLanguage: "en-US",
    minimumMatchScore: 0.58
  };

  const LOG = "[Voice POS]";
  let recognition = null;

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

  function parseOrder(text) {
    // MVP phrase pattern: quantity followed by a product name; split on common
    // spoken/list separators. Supports digits and a small set of number words.
    const numberWords = {
      a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
      six: 6, seven: 7, eight: 8, nine: 9, ten: 10
    };
    const chunks = String(text ?? "")
      .replace(/\b(and|then|plus)\b/gi, "|")
      .split(/[|,;\n]+/)
      .map(part => part.trim())
      .filter(Boolean);

    const items = [];
    for (const chunk of chunks) {
      const match = chunk.match(/^\s*(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(.+?)\s*$/i);
      if (!match) {
        warn("Could not parse phrase; expected quantity then product:", chunk);
        continue;
      }
      const quantity = /^\d+$/.test(match[1]) ? Number(match[1]) : numberWords[match[1].toLowerCase()];
      const product = match[2].trim();
      if (!Number.isInteger(quantity) || quantity < 1 || !product) continue;
      items.push({ product, quantity });
    }
    log("Parsed order", items);
    return items;
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

  function findBestProductMatch(name, products) {
    const normalized = normalizeProductName(name);
    const alias = CONFIG.aliases[normalized];
    const needle = normalizeProductName(alias || name);
    if (!needle || !Array.isArray(products) || !products.length) return null;

    let best = null;
    for (const product of products) {
      const label = typeof product === "string" ? product : product?.name;
      if (!label) continue;
      const candidate = normalizeProductName(label);
      const distance = levenshteinDistance(needle, candidate);
      const score = 1 - distance / Math.max(needle.length, candidate.length, 1);
      if (!best || score > best.score) best = { product, score };
    }
    return best && best.score >= CONFIG.minimumMatchScore ? best : null;
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
  }

  async function addProduct(productName, quantity) {
    // Intentionally guarded: this MVP does not guess selectors or choose a
    // product automatically. Implement the page-specific result selection only
    // after CONFIG selectors and the site's result markup have been verified.
    const missing = ["searchInput", "productResults", "quantityInput", "addButton"]
      .filter(key => !CONFIG[key]);
    if (missing.length) throw new Error(`DOM automation is not configured. Missing selectors: ${missing.join(", ")}`);
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error("Quantity must be a positive integer");
    throw new Error(`Product selection behavior for "${productName}" needs to be configured for this POS result markup.`);
  }

  function getVisibleProductNames() {
    if (!CONFIG.productResults) return [];
    return [...document.querySelectorAll(CONFIG.productResults)]
      .filter(el => el.getClientRects().length)
      .map(el => (el.getAttribute("aria-label") || el.innerText || el.textContent || "").trim())
      .filter(Boolean);
  }

  function showConfirmation(items) {
    removeConfirmation();
    const overlay = document.createElement("div");
    overlay.className = "voice-pos-overlay";
    overlay.setAttribute("role", "presentation");
    const dialog = document.createElement("section");
    dialog.className = "voice-pos-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "voice-pos-title");

    const title = document.createElement("h2");
    title.id = "voice-pos-title";
    title.textContent = "Review spoken order";
    const list = document.createElement("ul");

    if (!items.length) {
      const empty = document.createElement("p");
      empty.textContent = "No items were understood. Try saying “3 Coca Cola and 2 Sprite.”";
      dialog.append(title, empty);
    } else {
      const candidates = getVisibleProductNames();
      for (const item of items) {
        const row = document.createElement("li");
        const match = candidates.length ? findBestProductMatch(item.product, candidates) : null;
        row.textContent = `${item.quantity} × ${item.product}${candidates.length ? (match ? `  (possible match: ${typeof match.product === "string" ? match.product : match.product.name})` : "  (no confident visible match)") : ""}`;
        list.append(row);
      }
      const note = document.createElement("p");
      note.className = "voice-pos-note";
      note.textContent = "Nothing is added until you confirm. Confirm runs only when page selectors and product selection are configured.";
      dialog.append(title, list, note);
    }

    const actions = document.createElement("div");
    actions.className = "voice-pos-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", removeConfirmation);
    actions.append(cancel);
    if (items.length) {
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "voice-pos-primary";
      confirm.textContent = "Confirm order entry";
      confirm.addEventListener("click", async () => {
        confirm.disabled = true;
        try {
          for (const item of items) await addProduct(item.product, item.quantity);
          removeConfirmation();
        } catch (error) {
          warn("Order entry stopped safely:", error);
          const failure = dialog.querySelector(".voice-pos-error") || document.createElement("p");
          failure.className = "voice-pos-error";
          failure.textContent = `No further items were entered: ${error.message}`;
          dialog.insertBefore(failure, actions);
          confirm.disabled = false;
        }
      });
      actions.append(confirm);
    }
    dialog.append(actions);
    overlay.append(dialog);
    overlay.addEventListener("click", event => { if (event.target === overlay) removeConfirmation(); });
    document.body.append(overlay);
    (dialog.querySelector("button") || dialog).focus?.();
  }

  function removeConfirmation() {
    document.querySelector(".voice-pos-overlay")?.remove();
  }

  function startVoiceRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      warn("SpeechRecognition is unavailable in this browser.");
      showConfirmation([]);
      return;
    }
    if (recognition) {
      try { recognition.abort(); } catch (_) { /* already stopped */ }
    }
    recognition = new SpeechRecognition();
    recognition.lang = CONFIG.recognitionLanguage;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => { setMicState("Listening…", true); log("Listening started"); };
    recognition.onerror = event => { warn("Speech recognition error:", event.error); setMicState("Speak order", false); };
    recognition.onend = () => { setMicState("Speak order", false); };
    recognition.onresult = event => {
      const transcript = event.results?.[0]?.[0]?.transcript || "";
      log("Recognized speech:", transcript);
      showConfirmation(parseOrder(transcript));
    };
    try { recognition.start(); }
    catch (error) { warn("Could not start recognition:", error); setMicState("Speak order", false); }
  }

  function setMicState(label, listening) {
    const button = document.querySelector(".voice-pos-mic");
    if (!button) return;
    button.textContent = listening ? "● Listening…" : "🎙 Speak order";
    button.setAttribute("aria-label", label);
    button.classList.toggle("voice-pos-listening", listening);
  }

  function mountMicButton() {
    if (document.querySelector(".voice-pos-mic")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "voice-pos-mic";
    button.textContent = "🎙 Speak order";
    button.setAttribute("aria-label", "Speak order");
    button.addEventListener("click", startVoiceRecognition);
    document.body.append(button);
    log("Microphone button mounted");
  }

  // Keep required extension functions accessible for DevTools feature checks.
  window.VoicePOS = Object.freeze({
    startVoiceRecognition,
    parseOrder,
    normalizeProductName,
    findBestProductMatch,
    waitForElement,
    setNativeInputValue,
    addProduct,
    showConfirmation,
    CONFIG
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountMicButton, { once: true });
  else mountMicButton();
})();
