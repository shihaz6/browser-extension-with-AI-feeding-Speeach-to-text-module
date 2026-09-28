# Voice POS Order Entry (MVP)

A small Manifest V3 Chrome extension with a MediaRecorder capture flow, a local transcription backend, and POS product-entry helpers. The API key stays in the server environment and is never included in extension files. The extension does not automate checkout or payment.

## Configure the POS page

1. The manifest currently allows `http://*/*` and `https://*/*` for development testing. **These broad permissions are temporary; restrict both `host_permissions` and `content_scripts.matches` to the real POS domain before production use.**
2. The current live selectors are configured in `CONFIG` at the top of `content.js`:

```js
const CONFIG = {
  searchInput: "#select_item",
  productCards: '[id^="fcs_"]',
  productCardName: '[id^="fcs_"]',
  calculatorModal: "#easy-numpad-frame",
  calculatorQtyDisplay: "#easy-numpad-output",
  calculatorNumberButtons: "a, button",
  calculatorQtyButton: "#calQty",
  calculatorConfirmButton: "#doneAdd > i",
  billRows: "#ddd > div:nth-child(2)",
  closeButton: "#bill_close_but"
};
```

Product cards are selected by the dynamic `fcs_` ID prefix and matched from all visible result text, so the automation does not depend on a fixed result ID. Matching normalizes product codes/prices away, checks medicine-name similarity separately from strength, and stops with a visible error if the match is uncertain. Digits are chosen from visible anchors/buttons under the keypad by exact trimmed text. Confirm resolves the inner icon to its containing button/link when available.

`addProduct(productName, quantity)` logs each stage. It progressively searches the normalized full product phrase, name, shrinking name prefixes, and strength, collecting visible POS results across attempts. Prefix searches try 5/4/3 characters for longer names or 3/2 for shorter names, and skip a broad two-character search only after finding at least three strength-compatible prefix candidates. Three-character searches remain available even when longer prefixes found other products. It scores medicine-name similarity independently from strength: strength must match when spoken, but never compensates for a weak name match. A local Double Metaphone signal can add a small bonus only when raw name similarity already meets its minimum. Only an exact name match that also passes confidence, strength, and ambiguity checks can stop discovery early. A phonetic bonus cannot push an approximate name over the single-candidate confidence threshold; scores remain within 0?1. Close or weak candidates stop with a visible error and possible matches; the extension does not auto-select a lone weak result. It then selects Q mode, enters digits through the keypad, checks the displayed quantity numerically, clicks confirmation, and waits for the calculator to close. Bill verification is intentionally deferred and does not block this MVP flow.

The voice grammar is `[quantity] [product name] [strength/size]`, such as `10 Atorva 50mg`. The first token must be a positive integer (or a supported number word), and everything after it stays in the product phrase; units such as `50 mg`, `500 milligram`, and `5 ml` are normalized. Reversed or incomplete formats show “Voice format not understood. Say quantity first, then product.” and do not search the POS. After POS discovery and deterministic scoring (including token-merge fallback), every voice item sends the transcript, parsed quantity/name/strength, and all discovered candidates to `/rerank`. A deterministic and reranker agreement proceeds automatically; disagreement requires the user to choose one candidate or cancel. If both return no candidate, nothing is added. The chosen product must pass the existing strength gate. No checkout or payment controls are configured or used. **TEST ADD** remains a separate development control.

## Load the extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select this project folder.
4. After modifying files, press **Reload** on the extension.
5. Refresh the POS page.
6. Confirm `[VoicePOS] content script loaded` appears in the DevTools Console.
7. Confirm extension access to the POS site in its site access details.
8. Click **TEST ADD**.
9. Watch console logs for `[VoicePOS] Product submission completed` and `[VoicePOS] Test completed`.
10. Start the local transcription backend using the steps below.
11. Click **Speak order** and allow microphone access if prompted.
12. Speak the product order, then click the microphone button again to stop recording.
13. Confirm the console logs a nonzero audio size and **Sending audio for transcription**.
14. Verify `[VoicePOS] Transcript received: ...` and parsed item logs in the console. **PLAY RECORDING** remains available during development.
15. Items are processed sequentially. Agreement between deterministic matching and the reranker adds automatically. Disagreement shows both answers and requires a human choice or Cancel. Parse and search failures stop the order.

## Local transcription backend

Run these steps from the `server` directory:

1. Install dependencies with `npm install`.
2. Create or edit `server/.env` (copy `.env.example` if needed) and set `GROQ_API_KEY` to your Groq API key. Set it only in this server file; `.env` is gitignored. `GROQ_TRANSCRIBE_MODEL` is `whisper-large-v3`; the backend explicitly sends language `en` and temperature `0`. `GROQ_TRANSCRIPTION_PROMPT` gives generic POS/pharmacy terminology and asks Groq to preserve unfamiliar product wording; it does not include the product catalogue. `STT_PROVIDER=groq` selects transcription and `RERANK_PROVIDER=groq` selects the required agreement check. `GROQ_RERANK_MODEL` configures the chat model (the example uses `openai/gpt-oss-20b`).
3. Start the server with `npm start`. It listens at `http://localhost:3001`; check `http://localhost:3001/health` for `{ "ok": true }`.
4. Reload the extension at `chrome://extensions`, then refresh the POS page.
5. Record voice and stop manually. The extension posts the audio as multipart field `audio` to `/transcribe`, parses the returned transcript, runs deterministic matching, and always calls `/rerank` with the discovered candidates. Agreement proceeds automatically; disagreement presents both results for a human choice before adding.

The backend's Groq transcription adapter calls `https://api.groq.com/openai/v1/audio/transcriptions` with multipart WebM audio, English language, zero temperature, and the configurable pharmacy prompt. It returns `{ "text": "..." }`. The separate reranker adapter calls Groq's chat completions API with temperature `0` and a closed-choice prompt limited to the discovered POS candidates. It accepts only a response consisting of one allowed integer; provider/network/timeout/invalid-output failures become index `0`. An explicit strength mismatch also becomes index `0`. Both API calls stay behind backend providers; the Chrome extension never has the Groq key. [Groq Speech to Text documentation](https://console.groq.com/docs/speech-to-text), [Groq supported models](https://console.groq.com/docs/models)

## Manual workflow check

The temporary **TEST ADD** button runs `addProduct("Losacar 50mg", 10)` inside the content script. It is not exposed as a page-console function because Chrome content scripts use an isolated world. Review `[VoicePOS]` logs for each stage, plus the test started/completed/failed message. The microphone button starts MediaRecorder on the first click and stops it on the second. It posts a nonempty Blob to the local backend; a successful transcript with complete quantities is added sequentially. The small status notification shows listening, transcription, adding, success, or an error. Checkout/payment is not automated.

## Limitations

- The live POS page is not available in this workspace, so the configured selectors and workflow still need a browser run there.
- Progressive fuzzy matching uses only live POS result cards and rejects explicit strength conflicts or weak medicine-name similarity.
- Audio capture requires MediaRecorder, microphone permission, and a secure context such as HTTPS or localhost. Transcription also requires the local backend and a valid server-side API key.
- No checkout or payment action is implemented.

Run all local regression cases from the project root with `node --test`. These use synthetic products, simulated DOM updates, and mocked provider responses; they never add to a real bill or call Groq.

## Matching fixes and rollout checks

- Search waits for old cards to clear or change and for new visible results to settle. Unchanged stale cards now cause an explicit error. `CONFIG.searchResultsTimeout`, `searchMinimumWaitMs`, and `searchSettleMs` control bounded waits. This DOM check still requires live validation against the POS's loading behaviour; it cannot identify arbitrary out-of-order network responses without a POS response marker.
- `product-identity.js` loads before the extension scripts and is also required by the backend. It preserves decimal values, units, and every component of combination strengths. Explicit units must agree; a bare numeric strength can match that same value with a unit. Single and combination strengths cannot substitute for each other. The reopened card is checked again before clicking it.
- The Groq reranker defaults to `GROQ_RERANK_MAX_COMPLETION_TOKENS=1024`, low reasoning effort for GPT-OSS, and `GROQ_RERANK_TIMEOUT_MS=8000`. The extension allows 10 seconds. Missing settings use these defaults; keep the existing API key in `server/.env`.
- `/rerank` returns `{ selectedIndex, status }`. `uncertain` means the model returned 0; `truncated`, `timeout`, `rate_limited`, `invalid_response`, and other failure statuses are displayed separately. No incomplete answer is accepted. The backend logs the final response, finish reason, and token count, never the API key.

After updating: restart the backend, reload the extension at `chrome://extensions`, and refresh the POS page (the manifest now loads the shared identity script). Check `Atorva 20mg` versus a similar spelling, a decimal strength, and a disagreement that you cancel. Confirm the chosen code/name in logs before approving a disagreement. TEST ADD remains available for its original DOM-only development check.
