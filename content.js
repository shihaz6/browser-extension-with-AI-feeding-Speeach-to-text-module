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
    recognitionLanguage: "en-US",
    minimumMatchScore: 0.72,
    minimumMatchMargin: 0.08,
    stageTimeout: 6000
  };

  const LOG = "[VoicePOS]";
  let recognition = null;
  let finalTranscript = "";
  let interimTranscript = "";
  let recognitionActive = false;

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
    const numberWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1 };
    const readQuantity = token => /^\d+$/.test(token) ? Number(token) : numberWords[token.toLowerCase()];
    const chunks = String(text ?? "").replace(/[.!?]+/g, " ")
      .replace(/\b(and|then|plus)\b/gi, "|")
      .split(/[|,;\n]+/).map(part => part.trim()).filter(Boolean);
    return chunks.map(chunk => {
      const prefix = chunk.match(/^\s*(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(.+?)\s*$/i);
      const suffix = chunk.match(/^\s*(.+?)\s+(?:quantity\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*$/i);
      const match = prefix || suffix;
      const product = match ? (prefix ? match[2] : match[1]).trim() : chunk;
      const quantity = match ? readQuantity(prefix ? match[1] : match[2]) : null;
      return { product, quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : null, needsCorrection: !(Number.isInteger(quantity) && quantity > 0) };
    }).filter(item => item.product);
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

    const scored = [];
    for (const product of products) {
      const label = typeof product === "string" ? product : product?.name;
      if (!label) continue;
      const candidate = normalizeProductName(label);
      const distance = levenshteinDistance(needle, candidate);
      const compactNeedle = needle.replace(/\s/g, "");
      const compactCandidate = candidate.replace(/\s/g, "");
      const exactPhraseInCandidate = (` ${candidate} `).includes(` ${needle} `);
      const editScore = 1 - distance / Math.max(needle.length, candidate.length, 1);
      const score = candidate === needle ? 1 : exactPhraseInCandidate ? 0.99 : Math.max(editScore,
        (candidate.includes(needle) || needle.includes(candidate) || compactCandidate.includes(compactNeedle)) ? 0.82 : 0);
      scored.push({ product, score });
    }
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length || scored[0].score < CONFIG.minimumMatchScore) return null;
    if (scored[1] && scored[0].score - scored[1].score < CONFIG.minimumMatchMargin) {
      return { ambiguous: true, matches: scored.filter(item => scored[0].score - item.score < CONFIG.minimumMatchMargin) };
    }
    return scored[0];
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

  async function addProduct(productName, quantity) {
    const required = ["searchInput", "productCards", "productCardName", "calculatorModal",
      "calculatorQtyDisplay", "calculatorNumberButtons", "calculatorQtyButton",
      "calculatorConfirmButton"];
    const missing = required
      .filter(key => !CONFIG[key]);
    if (missing.length) throw new Error(`DOM automation is not configured. Missing selectors: ${missing.join(", ")}`);
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error("Quantity must be a positive integer");
    if (!String(productName || "").trim()) throw new Error("Product name is required");

    log("[1/8] Locating main product search input");
    const search = await waitForElement(CONFIG.searchInput, { timeout: CONFIG.stageTimeout });
    log("[2/8] Clearing search using native input events");
    setNativeInputValue(search, "");
    log("[3/8] Entering product search", productName);
    setNativeInputValue(search, productName);
    log("[4/8] Waiting for visible product cards matching the requested product");
    await waitForCondition(() => {
      const visibleNames = [...document.querySelectorAll(CONFIG.productCards)].filter(isVisible).map(card => {
        const nameNode = card.matches(CONFIG.productCardName) ? card : card.querySelector(CONFIG.productCardName);
        return (nameNode?.innerText || nameNode?.textContent || "").trim();
      }).filter(Boolean);
      return visibleNames.some(label => {
        const score = findBestProductMatch(productName, [label]);
        return score && !score.ambiguous;
      });
    }, "visible product cards matching the search");
    const cards = [...document.querySelectorAll(CONFIG.productCards)].filter(isVisible).map(card => {
      const nameNode = card.matches(CONFIG.productCardName) ? card : card.querySelector(CONFIG.productCardName);
      return { element: card, name: (nameNode?.innerText || nameNode?.textContent || "").trim() };
    }).filter(card => card.name);
    log("[5/8] Visible product cards", cards.map(card => card.name));
    const match = findBestProductMatch(productName, cards.map(card => card.name));
    if (!match || match.ambiguous) {
      const possible = match?.matches?.map(item => item.product) || cards.map(card => card.name);
      const message = `Could not safely choose "${productName}". Possible matches: ${possible.join(" | ") || "none"}`;
      warn(message);
      throw new Error(message);
    }
    const chosen = cards.find(card => card.name === match.product);
    log("[6/8] Clicking best matching product card", chosen.name, "score", match.score);
    chosen.element.click();

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
        } else if (/^\d+(?:\.\d+)?$/.test(text) && el.children.length === 0) found.add(el);
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
    if (initial.quantities.some(matchesQty)) log("[VoicePOS] Quantity already shows requested value", quantity);
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
    return { productName, quantity, selected: match.product };
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

  function showConfirmation(items, transcript = "") {
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
    title.textContent = "Voice detected:";
    const list = document.createElement("ul");
    const status = document.createElement("p");
    status.className = "voice-pos-note";
    status.setAttribute("role", "status");
    const quantityInputs = [];

    if (!items.length) {
      const empty = document.createElement("p");
      empty.textContent = transcript === "No speech detected" ? "No speech detected" : (transcript ? "No products were understood. Please try again." : "No speech transcript was received.");
      dialog.append(title, empty);
    } else {
      for (const [index, item] of items.entries()) {
        const row = document.createElement("li");
        const description = document.createElement("span");
        description.textContent = item.needsCorrection || !item.quantity
          ? `${item.product} — quantity needs correction `
          : `${item.product} × ${item.quantity}`;
        row.append(description);
        if (item.needsCorrection || !item.quantity) {
          const quantityInput = document.createElement("input");
          quantityInput.type = "number";
          quantityInput.min = "1";
          quantityInput.step = "1";
          quantityInput.required = true;
          quantityInput.setAttribute("aria-label", `Quantity for ${item.product}`);
          quantityInput.placeholder = "Qty";
          quantityInput.addEventListener("input", () => {
            const value = Number(quantityInput.value);
            item.quantity = Number.isInteger(value) && value > 0 ? value : null;
            item.needsCorrection = !item.quantity;
            description.textContent = item.quantity ? `${item.product} × ${item.quantity}` : `${item.product} — quantity needs correction `;
            confirm.disabled = items.some(entry => !Number.isInteger(entry.quantity) || entry.quantity < 1);
          });
          row.append(quantityInput);
          quantityInputs[index] = quantityInput;
        }
        list.append(row);
      }
      status.textContent = "Review the items before adding them to the POS.";
      dialog.append(title, list, status);
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
      confirm.textContent = "Confirm";
      confirm.disabled = items.some(item => !Number.isInteger(item.quantity) || item.quantity < 1);
      let nextItem = 0;
      confirm.addEventListener("click", async () => {
        if (confirm.disabled || nextItem >= items.length) return;
        confirm.disabled = true;
        cancel.disabled = true;
        confirm.textContent = "Adding…";
        log("Review confirmed");
        try {
          while (nextItem < items.length) {
            const item = items[nextItem];
            if (quantityInputs[nextItem]) {
              const corrected = Number(quantityInputs[nextItem].value);
              if (!Number.isInteger(corrected) || corrected < 1) throw new Error(`Quantity correction required for ${item.product}`);
              item.quantity = corrected;
            }
            log(`Adding item ${nextItem + 1}/${items.length}:`, `${item.product} × ${item.quantity}`);
            status.className = "voice-pos-note";
            status.textContent = `Adding ${item.product} × ${item.quantity}...`;
            await addProduct(item.product, item.quantity);
            log("Item added successfully", `${item.product} × ${item.quantity}`);
            nextItem++;
          }
          log("Voice order completed");
          confirm.textContent = "Added successfully";
          status.textContent = "Added successfully";
          setTimeout(removeConfirmation, 800);
        } catch (error) {
          const failedItem = items[nextItem];
          const product = failedItem?.product || "order";
          console.error(`[VoicePOS] Failed on ${product}:`, error);
          status.className = "voice-pos-error";
          status.textContent = `Could not add ${product}: ${error.message}. Correct the issue and choose Retry, or Cancel.`;
          confirm.disabled = items.slice(nextItem).some(item => !Number.isInteger(item.quantity) || item.quantity < 1);
          confirm.textContent = "Retry";
          cancel.disabled = false;
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

  function startVoiceRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      warn("SpeechRecognition is unavailable in this browser.");
      showConfirmation([]);
      return;
    }
    if (recognitionActive) {
      log("Recognition is already active; ignoring additional microphone click");
      return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = "en-US";
    finalTranscript = "";
    interimTranscript = "";
    updateLiveTranscript();
    recognition.onstart = () => {
      recognitionActive = true;
      setMicState("Listening...", true);
      log("[VoicePOS] Recognition started");
    };
    recognition.onaudiostart = () => log("[VoicePOS] Audio capture started");
    recognition.onsoundstart = () => log("[VoicePOS] Sound detected");
    recognition.onspeechstart = () => log("[VoicePOS] Speech detected");
    recognition.onresult = event => {
      log("[VoicePOS] Result count:", event.results.length);
      const finals = [];
      const interims = [];
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        const alternative = result?.[0];
        const transcript = (alternative?.transcript || "").trim();
        const confidence = alternative?.confidence;
        log("[VoicePOS] Result index:", index);
        log("[VoicePOS] Transcript:", transcript);
        log("[VoicePOS] Confidence:", confidence);
        log("[VoicePOS] Final:", !!result?.isFinal);
        if (!transcript) continue;
        (result.isFinal ? finals : interims).push(transcript);
      }
      // Build from the current result list so repeated browser events do not
      // append the same result a second time.
      finalTranscript = [...event.results].filter(result => result.isFinal)
        .map(result => result?.[0]?.transcript?.trim()).filter(Boolean).join(" ");
      interimTranscript = interims.join(" ");
      updateLiveTranscript();
    };
    recognition.onspeechend = () => log("[VoicePOS] Speech ended");
    recognition.onsoundend = () => log("[VoicePOS] Sound ended");
    recognition.onaudioend = () => log("[VoicePOS] Audio capture ended");
    recognition.onnomatch = () => log("[VoicePOS] No speech match");
    recognition.onerror = event => {
      console.error("[VoicePOS] Recognition error:", event.error, event.message || "");
    };
    recognition.onend = () => {
      recognitionActive = false;
      log("[VoicePOS] Recognition ended");
      setMicState("Processing...", false);
      const transcript = (finalTranscript || interimTranscript).trim();
      if (!transcript) {
        finalTranscript = "";
        interimTranscript = "";
        updateLiveTranscript();
        setMicState("Speak order", false);
        showConfirmation([], "No speech detected");
        return;
      }
      finalTranscript = transcript;
      interimTranscript = "";
      updateLiveTranscript();
      log("[VoicePOS] Full transcript:", transcript);
      const items = parseOrder(transcript);
      log("[VoicePOS] Parsed items:", items);
      setMicState("Speak order", false);
      showConfirmation(items, transcript);
    };
    recognitionActive = true;
    setMicState("Listening...", true);
    try { recognition.start(); }
    catch (error) {
      recognitionActive = false;
      setMicState("Speak order", false);
      warn("Could not start recognition:", error);
    }
  }

  function updateLiveTranscript() {
    const preview = document.querySelector(".voice-pos-live-transcript");
    if (!preview) return;
    const text = [finalTranscript, interimTranscript].filter(Boolean).join(" ").trim();
    preview.textContent = text ? `Heard: ${text}` : "";
    preview.hidden = !text;
  }


  function setMicState(label, listening) {
    const button = document.querySelector(".voice-pos-mic");
    if (!button) return;
    button.textContent = listening ? `● ${label}` : (label === "Processing..." ? label : "🎙 Speak order");
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
    const preview = document.createElement("div");
    preview.className = "voice-pos-live-transcript";
    preview.hidden = true;
    document.body.append(preview);
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

  // Voice recognition still parses and reviews orders, but does not add them.
  // TEST ADD is a separate development-only route into addProduct().
  function mountDevelopmentControls() {
    mountMicButton();
    mountTestAddButton();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountDevelopmentControls, { once: true });
  else mountDevelopmentControls();
})();
