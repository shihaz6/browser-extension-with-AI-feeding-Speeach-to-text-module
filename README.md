# Voice POS Order Entry (MVP)

A small Manifest V3 Chrome extension scaffold for dictating product names and quantities on one POS page. It uses the browser's speech recognition, shows a confirmation dialog, and exposes guarded DOM automation helpers. It does not submit checkout.

## 1. Set the target site

Edit `manifest.json` in **both** `host_permissions` and `content_scripts.matches`. Replace `https://YOUR-POS-DOMAIN.example/*` with the site's origin and paths, for example `https://pos.example.com/*`. Keep the match as narrow as the site allows. Save, then reload the extension from `chrome://extensions`.

## 2. Inspect and configure selectors

On the POS page, use Chrome DevTools Elements panel to inspect the product search field, result rows, quantity field, and add button. Prefer stable IDs, `name` attributes, or stable `data-*` attributes. Test each selector in the DevTools Console with `document.querySelector("YOUR_SELECTOR")` and confirm it selects the intended element.

Paste the selectors into the `CONFIG` object at the top of `content.js`:

```js
const CONFIG = {
  searchInput: "",
  productResults: "",
  quantityInput: "",
  addButton: "",
  checkoutButton: ""
};
```

Do not configure `checkoutButton` for this MVP. `productResults` must select the product choices shown after typing. The result markup and click behavior differ between POS systems, so inspect how one result is selected before implementing page-specific product selection inside `addProduct()`. Until that behavior is deliberately implemented, the confirm action stops safely with a configuration message and will not guess or add a product. Keep the checkout button out of the automation flow.

Aliases can also be added in `CONFIG.aliases`, where the key is the spoken spelling and the value is the canonical catalog label.

## 3. Load unpacked extension

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this project folder.
4. Open or refresh the configured POS page. Chrome may ask permission to use the microphone the first time you dictate.
5. After editing extension files, return to `chrome://extensions`, press the extension's reload icon, and refresh the POS page.

## 4. Test features independently

- **Injection/UI:** Load the target page and confirm the floating **Speak order** button appears. Check the page console for `[Voice POS] Microphone button mounted`.
- **Parser:** In the page DevTools Console run `VoicePOS.parseOrder("3 Coca Cola and 2 Sprite")`; expect two `{ product, quantity }` entries. It also recognizes quantity words from one to ten.
- **Normalization/matching:** Run `VoicePOS.normalizeProductName("Coca-Cola")`. To test matching, run `VoicePOS.findBestProductMatch("coke", ["Coca Cola", "Sprite"])`.
- **Speech:** Click the mic, allow microphone access, and say “3 Coca Cola and 2 Sprite.” Check the console transcript and inspect the confirmation dialog. Speech recognition availability depends on Chrome/platform and may require internet service.
- **Confirmation:** The dialog offers Cancel and Confirm. Cancel does not touch the POS. Confirm currently reaches the guarded automation stub unless page-specific selection logic has been implemented and reviewed.
- **Controlled inputs:** Once configured, test `VoicePOS.setNativeInputValue(element, "example")` on a non-submitting search input and verify the page's own UI reflects the value.
- **Wait helper:** `VoicePOS.waitForElement("your-selector")` resolves when a matching element appears and rejects after five seconds.

## Limitations

- Speech recognition is browser/platform dependent, and transcripts can be inaccurate. Always review the confirmation list.
- Parsing expects quantity first (such as “3 Coca Cola”) and supports a small set of quantities; it does not infer omitted quantities or complex modifiers.
- Product matching is lightweight fuzzy text matching. Similar product names can be ambiguous. The MVP displays candidate hints when matching visible result labels, but never silently chooses one.
- POS selectors and result selection are site-specific. The provided selectors are intentionally blank; automatic adding remains safely disabled until inspected and implemented for the actual page.
- No checkout or payment action is implemented. Test on a non-production order or a safe environment after the site-specific adapter is ready.
