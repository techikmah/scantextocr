# ScanText — web app

The OCR/search engine, ported to run as a plain
static website instead — no install, just a link. Forked from the free/no-limits, so this version has no
account, no document cap, and no API dependency at all.

## What changed from the extension

Only the parts that are genuinely Chrome-extension-specific:

- `background.js` and `popup.html/css/js` are gone — those existed purely to open
  the extension's viewer in a new tab when you clicked the toolbar icon. A website
  doesn't need that indirection; `index.html` *is* the app, directly.
- The two `chrome.runtime.getURL(...)` calls (used to build the Tesseract worker's
  URLs) are replaced with `new URL(..., import.meta.url)` — resolved relative to
  the JS module's own location rather than a Chrome API, so it now works under
  `http://`/`https://` instead of `chrome-extension://`. This was checked against
  both a root-domain deployment and a GitHub Pages–style project subpath
  (`username.github.io/scantext/`), since a subpath is exactly the case that would
  expose a relative-path mistake if there were one.
- `viewer.html/js/css` are renamed to `index.html/app.js/app.css` — conventional
  static-site naming, and `index.html` specifically is what most static hosts
  (GitHub Pages included) look for by default at a given path.
- Added real `<head>` metadata that had no equivalent in an extension page: a
  viewport meta tag, an actual page description, Open Graph tags so it looks right
  when linked on Reddit/forums/Twitter, and favicon links (reusing the existing
  extension icons).

Everything else — OCR, the native-text-vs-scanned-image detection, search and
highlighting, the selectable text layer and its floating copy button, CSV/JSON
export, all 125 OCR languages, the IndexedDB result cache — is unchanged. It's the
same `cache.js` and `languages.js` files, untouched.

## Run it locally

ES modules don't load over `file://` (browsers block it as a CORS issue), so you
need an actual local server, not just opening `index.html` directly. Any of these
work:

```bash
python3 -m http.server 8000
# or: npx serve
# or: php -S localhost:8000
```

Then visit `http://localhost:8000`.

## Deploy it

Any static host works — there's no backend, no build step, just these files as-is.

**GitHub Pages** (matches your existing distribution channels):
1. Push this folder to a repo (or a `docs/` folder, or a `gh-pages` branch)
2. Repo Settings → Pages → pick that folder as the source
3. Live at `https://<username>.github.io/<repo>/`

**Netlify / Vercel / Cloudflare Pages**: drag-and-drop this folder (Netlify) or
connect the repo (Vercel/Cloudflare Pages) — no build command needed, no
framework, just static files.

## Package size

Same as the free extension build, ~13MB, mostly the Tesseract WASM engine
(three variants: no-SIMD, SIMD, relaxed-SIMD — the browser picks the right one at
runtime). That's a real download for a first-time visitor on a slow connection,
worth knowing going in; everything's cached by the browser after the first load.

## If you want the paid/metered version as a web app too

The Cloudflare Worker behind the SaaS build already sends
`Access-Control-Allow-Origin: *`, so it'll accept requests from a new web app
domain with zero changes on the Worker side. Porting the gated build itself would
mean carrying over `config.js`, `entitlement.js`, and `usage.js` from the extension
version (none of which are Chrome-specific — they're plain `fetch()` calls) and
adding back the account panel's email/subscription UI, which this free-based fork
intentionally doesn't have.
