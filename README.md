# Voice POS Order Entry (MVP)

A small Manifest V3 Chrome extension for reviewing spoken product orders and adding confirmed items through the POS search and calculator popup. The extension does not automate checkout or payment.

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

Product cards are selected by the dynamic `fcs_` ID prefix and matched by their visible text, so the automation does not depend on a fixed result ID. Digits are chosen from visible anchors/buttons under the keypad by exact trimmed text. Confirm resolves the inner icon to its containing button/link when available.

`addProduct(productName, quantity)` logs each stage. It clears and fills the search with native events, reads visible cards, applies normalized fuzzy matching, and stops with possible matches if confidence or separation is insufficient. It selects Q mode, enters digits through the keypad, checks the displayed quantity numerically, clicks confirmation, and waits for the calculator to close. It then logs `[VoicePOS] Product submission completed` and returns success. Bill verification is intentionally deferred and does not block this MVP flow.

If any required selector is blank, a stage times out, or product matching is uncertain, the operation stops with an error. No checkout or payment controls are configured or used. Voice order confirmation processes items sequentially; **TEST ADD** remains a separate development control.

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
10. Click **Speak order**, allow microphone access if prompted, and say an order such as “ten Losacar fifty milligram.” The recognition session remains active through brief pauses; interim speech appears in the live preview.
11. Say another item such as “and five Panadol,” then click the mic button again to stop and process the accumulated transcript.
12. Review the parsed products and quantities in the modal. Correct any item marked as needing a quantity.
13. Click **Confirm**. Items are added sequentially, one calculator interaction at a time; if one fails, remaining items stop and the failed item is shown with a Retry option.
14. Confirm the modal reports **Added successfully** and closes. Use **Cancel** to leave the POS unchanged before confirmation.

## Manual workflow check

The temporary **TEST ADD** button runs `addProduct("Losacar 50mg", 10)` inside the content script. It is not exposed as a page-console function because Chrome content scripts use an isolated world. Review `[VoicePOS]` logs for each stage, plus the test started/completed/failed message. For live voice testing, click **Speak order** to start, speak across brief pauses, click it again to stop, then check the final transcript and parsed items before confirming. Supported v1 forms include “10 Losacar 50mg”, “Losacar 50mg quantity 10”, and multiple products joined by “and”. Quantities one through ten may be spoken as number words. Products without a clear quantity require correction in the review modal; quantity is never assumed.

## Limitations

- The live POS page is not available in this workspace, so the configured selectors and workflow still need a browser run there.
- Fuzzy matching is intentionally conservative and reports ambiguous visible candidates rather than selecting one.
- Voice recognition uses browser speech recognition. Availability and accuracy depend on the browser and microphone permission.
- No checkout or payment action is implemented.
