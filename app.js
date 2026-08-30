import * as pdfjsLib from "./lib/pdfjs/pdf.min.mjs";
import Tesseract from "./lib/tesseract/tesseract.esm.min.js";
import { Document, Paragraph, TextRun, HeadingLevel, Packer } from "./lib/docx/docx.mjs";
import { hashBuffer, getCachedDoc, saveCachedDoc, getSetting, setSetting } from "./cache.js";
import { LANGUAGES, DEFAULT_LANGUAGES } from "./languages.js";

// Resolved relative to this module's own URL (not the document's), so asset paths
// stay correct no matter what subpath this app is deployed under — a GitHub Pages
// project site at yoursite.io/scantext/ works the same as a root domain.
const LIB_BASE = new URL("./lib/", import.meta.url);

const { createWorker, OEM, PSM } = Tesseract;

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs/pdf.worker.min.mjs", LIB_BASE).href;

// Render pages at ~180dpi (2.5x a 72dpi PDF unit). Good balance of OCR accuracy vs
// speed/memory for in-browser use. Raise this if small print is getting missed.
const RENDER_SCALE = 2.5;

// A page with fewer than this many extractable characters is treated as "image only"
// and gets OCR'd. Pages above it use the PDF's real text layer instead (faster + exact).
const MIN_NATIVE_CHARS = 20;

const MAX_DISPLAY_WIDTH = 900;

// Safety cap on the long edge of a rendered page canvas, regardless of RENDER_SCALE.
// Some PDF generators (govt/legal templates in particular) use unusual page sizes;
// this keeps memory use bounded instead of ever producing a runaway-huge canvas.
const MAX_CANVAS_DIM = 3500;

// A page that takes longer than this to OCR is treated as failed rather than left
// hanging forever, so one bad page can't freeze the whole document.
const OCR_TIMEOUT_MS = 60000;

// ---------- DOM ----------
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const pickBtn = document.getElementById("pickBtn");
const pagesEl = document.getElementById("pages");
const statusLine = document.getElementById("statusLine");
const searchBar = document.getElementById("searchBar");
const searchInput = document.getElementById("searchInput");
const matchLabel = document.getElementById("matchLabel");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const exportBtn = document.getElementById("exportBtn");
const exportMenu = document.getElementById("exportMenu");
const newFileBtn = document.getElementById("newFileBtn");
const settingsBtn = document.getElementById("settingsBtn");
const settingsPanel = document.getElementById("settingsPanel");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const applySettingsBtn = document.getElementById("applySettingsBtn");
const langSearchInput = document.getElementById("langSearchInput");
const langSelected = document.getElementById("langSelected");
const langOptions = document.getElementById("langOptions");

// ---------- state ----------
/** @type {{canvas:HTMLCanvasElement, pageEl:HTMLElement, innerEl:HTMLElement, hlLayer:HTMLElement, words:Array, source:string}[]} */
let pages = [];
let matches = []; // {pageIdx, wordIdx}
let currentFileName = "document";
let activeMatch = -1;
let currentQuery = "";
let ocrWorker = null;
let ocrWorkerReady = null;
let ocrWorkerLangs = null; // langs currently loaded into ocrWorker, for reinitialize checks
let pdfDoc = null;
let selectedLangs = DEFAULT_LANGUAGES.slice();

// Surface anything that slips past our own try/catches (belt-and-braces) instead of
// letting it fail silently with the status line stuck mid-sentence.
window.addEventListener("unhandledrejection", (e) => {
  console.error("ScanText: unhandled error", e.reason);
  setStatus(`Something went wrong: ${errorMessage(e.reason)}`, true);
});

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

// ---------- settings panel ----------
// No account, no limits, no network calls — this build is the OCR/search engine on
// its own. The only thing worth a "settings" panel at all is picking OCR
// language(s), since that's a real feature independent of any paywall.
settingsBtn.addEventListener("click", () => (settingsPanel.hidden = false));
closeSettingsBtn.addEventListener("click", () => (settingsPanel.hidden = true));
applySettingsBtn.addEventListener("click", () => (settingsPanel.hidden = true));
settingsPanel.addEventListener("click", (e) => {
  if (e.target === settingsPanel) settingsPanel.hidden = true; // click on the backdrop
});
document.addEventListener("keydown", (e) => {
  // A layout-independent way out of the panel — doesn't matter whether the close
  // button is currently reachable/visible, this always works.
  if (e.key === "Escape" && !settingsPanel.hidden) settingsPanel.hidden = true;
});

// ---------- OCR language picker ----------
initLanguagePicker();

async function initLanguagePicker() {
  const saved = await getSetting("ocrLanguages");
  if (Array.isArray(saved) && saved.length) selectedLangs = saved;
  renderLangChips();
  renderLangOptions("");
}

langSearchInput.addEventListener("input", () => renderLangOptions(langSearchInput.value));

function renderLangOptions(query) {
  const q = query.trim().toLowerCase();
  const matches = q
    ? LANGUAGES.filter((l) => l.name.toLowerCase().includes(q) || l.code.includes(q))
    : LANGUAGES;

  langOptions.innerHTML = "";
  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "lang-empty";
    empty.textContent = "No languages match that search.";
    langOptions.appendChild(empty);
    return;
  }

  for (const lang of matches) {
    const row = document.createElement("label");
    row.className = "lang-option";
    row.setAttribute("role", "option");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedLangs.includes(lang.code);
    checkbox.addEventListener("change", () => toggleLang(lang.code));

    const name = document.createElement("span");
    name.textContent = lang.name;

    const code = document.createElement("span");
    code.className = "lang-code";
    code.textContent = lang.code;

    row.appendChild(checkbox);
    row.appendChild(name);
    row.appendChild(code);
    langOptions.appendChild(row);
  }
}

function renderLangChips() {
  langSelected.innerHTML = "";
  for (const code of selectedLangs) {
    const lang = LANGUAGES.find((l) => l.code === code);
    const chip = document.createElement("span");
    chip.className = "lang-chip";
    chip.textContent = lang ? lang.name : code;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${lang ? lang.name : code}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => toggleLang(code));

    chip.appendChild(remove);
    langSelected.appendChild(chip);
  }
}

async function toggleLang(code) {
  if (selectedLangs.includes(code)) {
    // Keep at least one language selected — an empty set isn't a valid OCR request.
    if (selectedLangs.length === 1) return;
    selectedLangs = selectedLangs.filter((c) => c !== code);
  } else {
    selectedLangs = [...selectedLangs, code];
  }
  await setSetting("ocrLanguages", selectedLangs);
  renderLangChips();
  renderLangOptions(langSearchInput.value);
}

// ---------- file intake ----------
pickBtn.addEventListener("click", () => fileInput.click());
newFileBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
});

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag-over");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
  })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file && file.type === "application/pdf") loadFile(file);
  else if (file) setStatus("That doesn't look like a PDF — try a .pdf file.", true);
});

function setStatus(text, isWarning = false) {
  statusLine.hidden = !text;
  statusLine.textContent = text;
  statusLine.style.color = isWarning ? "#ff6b4a" : "";
}

async function loadFile(file) {
  resetViewer();
  dropzone.style.display = "none";
  currentFileName = file.name.replace(/\.pdf$/i, "") || "document";
  exportBtn.hidden = false;
  newFileBtn.hidden = false;
  searchBar.hidden = false;
  setStatus(`Opening ${file.name}…`);

  let buf;
  try {
    buf = await file.arrayBuffer();
  } catch (err) {
    setStatus("Couldn't read that file.", true);
    return;
  }

  const hash = await hashBuffer(buf);
  const cached = await getCachedDoc(hash);

  try {
    pdfDoc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
  } catch (err) {
    console.error("ScanText: failed to open PDF", err);
    setStatus("Couldn't open that PDF — it may be encrypted or corrupted.", true);
    return;
  }

  if (pdfDoc.numPages > 60) {
    setStatus(`Opening ${file.name} — ${pdfDoc.numPages} pages, this may take a while…`);
  }

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    pages.push(createPageShell(i));
  }

  try {
    await processPages(hash, cached);
  } catch (err) {
    // processPages already catches per-page errors; this only fires for something
    // outside that loop (e.g. the final cache write). Surface it rather than hang.
    console.error("ScanText: scan pass failed", err);
    setStatus(`Scan stopped early: ${errorMessage(err)}`, true);
  }
}

function resetViewer() {
  pagesEl.innerHTML = "";
  pages = [];
  matches = [];
  activeMatch = -1;
  currentQuery = "";
  currentFileName = "document";
  searchInput.value = "";
  updateMatchLabel();
}

// ---------- page shells & rendering ----------
function createPageShell(pageNumber) {
  const pageEl = document.createElement("div");
  pageEl.className = "page scanning";

  const innerEl = document.createElement("div");
  innerEl.className = "page-inner";

  const canvas = document.createElement("canvas");
  const textLayer = document.createElement("div");
  textLayer.className = "text-layer";
  const hlLayer = document.createElement("div");
  hlLayer.className = "hl-layer";

  const badge = document.createElement("span");
  badge.className = "page-badge";
  badge.textContent = "reading…";
  badge.addEventListener("click", () => retryPage(pageNumber - 1));

  const num = document.createElement("span");
  num.className = "page-number";
  num.textContent = String(pageNumber);

  innerEl.appendChild(canvas);
  innerEl.appendChild(textLayer);
  innerEl.appendChild(hlLayer);
  pageEl.appendChild(innerEl);
  pageEl.appendChild(badge);
  pageEl.appendChild(num);
  pagesEl.appendChild(pageEl);

  return { canvas, pageEl, innerEl, textLayer, hlLayer, badge, words: [], source: null };
}

function fitPageToColumn(entry) {
  const w = entry.canvas.width;
  const h = entry.canvas.height;
  const scale = Math.min(1, MAX_DISPLAY_WIDTH / w);
  entry.pageEl.style.width = `${w * scale}px`;
  entry.pageEl.style.height = `${h * scale}px`;
  entry.innerEl.style.width = `${w}px`;
  entry.innerEl.style.height = `${h}px`;
  entry.innerEl.style.transform = `scale(${scale})`;
}

function scaleForPage(page) {
  const base = page.getViewport({ scale: 1 });
  const longEdge = Math.max(base.width, base.height);
  return Math.max(1, Math.min(RENDER_SCALE, MAX_CANVAS_DIM / longEdge));
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Sanity-checks a native text layer before trusting it. Some PDF generators (this is
// common with government/legal templates using embedded subset fonts) report text
// items that "exist" but decode to garbage — long runs of control or private-use
// characters instead of real words. Treat that as unreliable and OCR the page instead
// of silently indexing nonsense.
function looksLikeRealText(words) {
  if (!words.length) return false;
  const sample = words.map((w) => w.text).join("");
  const printable = sample.replace(/[^\x20-\x7E]/g, "").length;
  return printable / sample.length > 0.85;
}

function updateBadge(entry, source) {
  entry.badge.textContent = source === "ocr" ? "OCR" : "text";
  entry.badge.classList.toggle("ocr", source === "ocr");
  entry.badge.classList.remove("err");
  entry.badge.title = "Click to force OCR on this page";
}

function markPageError(entry, err) {
  entry.pageEl.classList.remove("scanning");
  entry.pageEl.classList.add("error");
  entry.badge.textContent = "error — click to retry";
  entry.badge.classList.add("err");
  entry.badge.title = errorMessage(err);
}

// Renders one page to its canvas and fills in entry.words/entry.source. Used both by
// the initial pass and by the per-page "force OCR" retry button.
async function renderAndIndexPage(pageNum, entry, cached, total, opts = {}) {
  entry.busy = true;
  try {
    await renderAndIndexPageInner(pageNum, entry, cached, total, opts);
  } finally {
    entry.busy = false;
  }
}

async function renderAndIndexPageInner(pageNum, entry, cached, total, opts) {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: scaleForPage(page) });
  entry.canvas.width = viewport.width;
  entry.canvas.height = viewport.height;
  fitPageToColumn(entry);

  const ctx = entry.canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

  let words, source;
  const cachedPage = !opts.forceOcr && cached && cached.pages && cached.pages[pageNum - 1];

  if (cachedPage) {
    words = cachedPage.words;
    source = cachedPage.source;
  } else if (opts.forceOcr) {
    setStatus(`Running OCR on page ${pageNum} of ${total}…`);
    words = await withTimeout(ocrCanvas(entry.canvas), OCR_TIMEOUT_MS, `OCR timed out on page ${pageNum}`);
    source = "ocr";
  } else {
    const textContent = await page.getTextContent();
    const nativeWords = wordsFromTextContent(textContent, viewport);
    const charCount = nativeWords.reduce((n, w) => n + w.text.length, 0);

    if (charCount >= MIN_NATIVE_CHARS && looksLikeRealText(nativeWords)) {
      words = nativeWords;
      source = "text";
    } else {
      setStatus(`Page ${pageNum} of ${total} looks like a scanned image — running OCR…`);
      words = await withTimeout(ocrCanvas(entry.canvas), OCR_TIMEOUT_MS, `OCR timed out on page ${pageNum}`);
      source = "ocr";
    }
  }

  entry.words = words;
  entry.source = source;
  entry.pageEl.classList.remove("scanning", "error");
  updateBadge(entry, source);
  buildTextLayer(entry);
}

async function processPages(hash, cached) {
  const total = pdfDoc.numPages;
  let usedOcr = false;
  let errorCount = 0;

  for (let i = 1; i <= total; i++) {
    const entry = pages[i - 1];
    setStatus(`Reading page ${i} of ${total}…`);
    try {
      await renderAndIndexPage(i, entry, cached, total);
      if (entry.source === "ocr") usedOcr = true;
    } catch (err) {
      console.error(`ScanText: failed on page ${i}`, err);
      errorCount += 1;
      markPageError(entry, err);
    }
    if (currentQuery) runSearch(currentQuery, true);
  }

  await saveCachedDoc(hash, {
    pages: pages.map((p) => ({ words: p.words, source: p.source })),
    savedAt: Date.now(),
  });

  if (errorCount) {
    setStatus(
      `Done, but ${errorCount} page${errorCount === 1 ? "" : "s"} couldn't be scanned — click the badge on ` +
        `${errorCount === 1 ? "it" : "those pages"} to retry, or check the browser console for details.`,
      true
    );
    return;
  }

  setStatus(
    usedOcr
      ? `Done — ${total} page${total === 1 ? "" : "s"} indexed (some via OCR).`
      : `Done — ${total} page${total === 1 ? "" : "s"} indexed.`
  );
  window.setTimeout(() => setStatus(""), 4000);
}

async function retryPage(pageIdx) {
  const entry = pages[pageIdx];
  if (!pdfDoc || !entry || entry.busy) return;
  entry.pageEl.classList.add("scanning");
  entry.pageEl.classList.remove("error");
  entry.badge.textContent = "retrying…";
  entry.badge.classList.remove("err");
  try {
    await renderAndIndexPage(pageIdx + 1, entry, null, pages.length, { forceOcr: true });
    if (currentQuery) runSearch(currentQuery, true);
    setStatus(`Page ${pageIdx + 1} re-scanned.`);
    window.setTimeout(() => setStatus(""), 2500);
  } catch (err) {
    console.error(`ScanText: retry failed on page ${pageIdx + 1}`, err);
    markPageError(entry, err);
  }
}

// ---------- native text-layer extraction ----------
// pdf.js gives us text "runs" (item.str), not individual word boxes. We approximate
// per-word boxes by distributing each run's width proportionally by character offset.
// This is exact for OCR'd pages (Tesseract gives real word boxes) and a close visual
// approximation for text-native pages, which is what matters for a search highlight.
function wordsFromTextContent(textContent, viewport) {
  const words = [];
  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;

    const m = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(m[0], m[1]) || Math.hypot(m[2], m[3]) || 10;
    const originX = m[4];
    const baselineY = m[5];
    const widthPx = (item.width || 0) * viewport.scale;
    const y0 = baselineY - fontHeight * 0.85;
    const y1 = baselineY + fontHeight * 0.25;

    const totalLen = item.str.length || 1;
    let offset = 0;
    for (const part of item.str.split(/(\s+)/)) {
      if (part.trim().length > 0) {
        const startFrac = offset / totalLen;
        const endFrac = (offset + part.length) / totalLen;
        words.push({
          text: part,
          x0: originX + startFrac * widthPx,
          x1: originX + endFrac * widthPx,
          y0,
          y1,
        });
      }
      offset += part.length;
    }
  }
  return words;
}

// ---------- selectable text layer ----------
// Canvas pixels aren't selectable on their own, so this lays an invisible span per
// word on top of the canvas at the word's exact position — same idea as pdf.js's
// own accessibility text layer. The point is purely to let the browser's native
// selection/copy work over the rendered page; nothing here is ever shown.
//
// This is unconditional for every opened document — no account, license, or usage
// check involved. It only touches words already extracted for that document, so it
// has nothing left to gate.
const textMeasureCtx = document.createElement("canvas").getContext("2d");
const TEXT_LAYER_FONT = "sans-serif";

// A vertical-midpoint overlap test for "is this still the same line" — robust to
// the odd word running slightly high or low, unlike a strict y0 comparison. Shared
// between the selectable text layer and every text export path (copy/CSV/JSON) so
// they all agree on where lines break.
function isSameLine(prevWord, word) {
  const prevMidY = (prevWord.y0 + prevWord.y1) / 2;
  return word.y0 <= prevMidY && word.y1 >= prevMidY;
}

function buildTextLayer(entry) {
  entry.textLayer.innerHTML = "";
  let prevWord = null;

  for (const w of entry.words) {
    if (!w.text || !w.text.trim()) continue;

    if (prevWord && !isSameLine(prevWord, w)) {
      entry.textLayer.appendChild(document.createElement("br"));
    }

    const targetWidth = Math.max(2, w.x1 - w.x0);
    const targetHeight = Math.max(6, w.y1 - w.y0);
    const fontSize = targetHeight * 0.85;

    textMeasureCtx.font = `${fontSize}px ${TEXT_LAYER_FONT}`;
    const naturalWidth = textMeasureCtx.measureText(w.text).width || 1;
    const scaleX = targetWidth / naturalWidth;

    const span = document.createElement("span");
    span.className = "text-layer-word";
    span.textContent = w.text + " ";
    span.style.left = `${w.x0}px`;
    span.style.top = `${w.y0}px`;
    span.style.fontSize = `${fontSize}px`;
    span.style.lineHeight = `${targetHeight}px`;
    span.style.transform = `scaleX(${scaleX})`;
    entry.textLayer.appendChild(span);

    prevWord = w;
  }
}

// ---------- floating copy button for on-screen selections ----------
// The text layer above is genuinely selectable (drag, Ctrl/Cmd+C), but nothing
// about the canvas visually hints at that — it looks like a picture of a page, not
// text. This button appears the moment a selection is made anywhere in a page's
// text layer, both as a discoverable, explicit "copy this" action and as a way to
// notice the underlying text-is-selectable behavior exists at all. Appended
// directly to <body> (not nested under any .page-inner) because those get a CSS
// transform: scale() applied for responsive sizing, and position: fixed on a
// descendant of a transformed ancestor is relative to that ancestor, not the
// viewport — appending here keeps the fixed positioning meaning what it says.
const copySelectionBtn = document.createElement("button");
copySelectionBtn.type = "button";
copySelectionBtn.className = "copy-selection-btn";
copySelectionBtn.textContent = "Copy";
copySelectionBtn.setAttribute("aria-label", "Copy selected text");
copySelectionBtn.hidden = true;
document.body.appendChild(copySelectionBtn);

let selectionChangeTimer = null;
document.addEventListener("selectionchange", () => {
  clearTimeout(selectionChangeTimer);
  selectionChangeTimer = setTimeout(updateCopySelectionBtn, 150);
});
document.addEventListener("mouseup", () => {
  clearTimeout(selectionChangeTimer);
  updateCopySelectionBtn();
});
document.addEventListener("mousedown", (e) => {
  // A new mousedown anywhere else is about to change or clear the selection —
  // hide right away instead of waiting on the debounced handler above, so the
  // button doesn't linger a moment over whatever the user just clicked.
  if (e.target !== copySelectionBtn) copySelectionBtn.hidden = true;
});

function updateCopySelectionBtn() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !selection.toString().trim()) {
    copySelectionBtn.hidden = true;
    return;
  }

  // Only react to selections inside a page's text layer — a selection elsewhere in
  // the UI (a status message, a button label) isn't what this feature is for.
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const el = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
  if (!el || !el.closest(".text-layer")) {
    copySelectionBtn.hidden = true;
    return;
  }

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    copySelectionBtn.hidden = true;
    return;
  }

  copySelectionBtn.hidden = false;
  copySelectionBtn.textContent = "Copy";
  const btnRect = copySelectionBtn.getBoundingClientRect();
  const top = Math.max(8, rect.top - btnRect.height - 8);
  const left = Math.min(
    Math.max(8, rect.left + rect.width / 2 - btnRect.width / 2),
    window.innerWidth - btnRect.width - 8
  );
  copySelectionBtn.style.top = `${top}px`;
  copySelectionBtn.style.left = `${left}px`;
}

copySelectionBtn.addEventListener("mousedown", (e) => {
  // Without this, the button's own mousedown would collapse the selection before
  // the click handler below gets a chance to read it.
  e.preventDefault();
});

copySelectionBtn.addEventListener("click", async () => {
  const text = window.getSelection().toString();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copySelectionBtn.textContent = "Copied!";
    setTimeout(() => (copySelectionBtn.hidden = true), 900);
  } catch {
    setStatus("Couldn't copy to clipboard.", true);
  }
});

// ---------- OCR ----------
async function getOcrWorker() {
  if (!ocrWorkerReady) {
    ocrWorkerReady = (async () => {
      setStatus("Loading OCR engine (first time only)…");
      const worker = await createWorker(selectedLangs, OEM.LSTM_ONLY, {
        workerPath: new URL("tesseract/worker.min.js", LIB_BASE).href,
        corePath: new URL("tesseract-core/", LIB_BASE).href,
        // Not an extension-CSP requirement here the way it was in the Chrome build,
        // but this is proven to work reliably, so there's no reason to switch back
        // to the (default) blob-based loading path just because the constraint
        // that originally forced this choice doesn't strictly apply anymore.
        workerBlobURL: false,
        // langPath intentionally left at its default (jsDelivr CDN): each selected
        // language's model is fetched once and cached by the browser after that.
        // For a fully offline build, bundle the .traineddata files locally — see README.
      });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
      ocrWorker = worker;
      ocrWorkerLangs = selectedLangs.slice();
      return worker;
    })().catch((err) => {
      // Critical: if setup fails (e.g. a transient hiccup fetching the language pack),
      // don't leave a rejected promise cached here forever — that would silently kill
      // OCR for every remaining page in the document, not just this one attempt.
      ocrWorkerReady = null;
      ocrWorker = null;
      ocrWorkerLangs = null;
      throw err;
    });
  }

  const worker = await ocrWorkerReady;

  // The language picker can change selectedLangs mid-session (or between documents)
  // without tearing down the worker — reinitialize() swaps the loaded language data
  // without re-fetching the WASM engine itself, which is the expensive part.
  if (!sameLangs(ocrWorkerLangs, selectedLangs)) {
    setStatus("Switching OCR language…");
    await worker.reinitialize(selectedLangs, OEM.LSTM_ONLY);
    ocrWorkerLangs = selectedLangs.slice();
  }

  return worker;
}

function sameLangs(a, b) {
  if (!a || a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((code) => setA.has(code));
}

async function ocrCanvas(canvas) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(canvas, {}, { blocks: true });
  const words = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) {
          if (!w.text || !w.text.trim()) continue;
          words.push({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 });
        }
      }
    }
  }
  return words;
}

// ---------- search ----------
let searchDebounce;
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(searchInput.value), 150);
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    e.shiftKey ? stepMatch(-1) : stepMatch(1);
  }
});
prevBtn.addEventListener("click", () => stepMatch(-1));
nextBtn.addEventListener("click", () => stepMatch(1));

function runSearch(query, incremental = false) {
  currentQuery = query;
  const q = query.trim().toLowerCase();
  const previousActiveKey = incremental && activeMatch >= 0 ? matchKey(matches[activeMatch]) : null;

  matches = [];
  if (q) {
    pages.forEach((entry, pageIdx) => {
      entry.words.forEach((w, wordIdx) => {
        if (w.text.toLowerCase().includes(q)) matches.push({ pageIdx, wordIdx });
      });
    });
  }

  renderHighlights();

  if (!q) {
    activeMatch = -1;
  } else if (previousActiveKey) {
    const idx = matches.findIndex((m) => matchKey(m) === previousActiveKey);
    activeMatch = idx >= 0 ? idx : matches.length ? 0 : -1;
  } else {
    activeMatch = matches.length ? 0 : -1;
  }

  updateMatchLabel();
  if (activeMatch >= 0 && !incremental) focusMatch(activeMatch, true);
  else applyActiveStyle();
}

function matchKey(m) {
  return `${m.pageIdx}:${m.wordIdx}`;
}

function stepMatch(dir) {
  if (!matches.length) return;
  activeMatch = (activeMatch + dir + matches.length) % matches.length;
  updateMatchLabel();
  focusMatch(activeMatch, true);
}

function updateMatchLabel() {
  matchLabel.textContent = matches.length ? `${activeMatch + 1} / ${matches.length}` : "0 / 0";
  prevBtn.disabled = matches.length === 0;
  nextBtn.disabled = matches.length === 0;
}

function renderHighlights() {
  pages.forEach((entry) => (entry.hlLayer.innerHTML = ""));
  matches.forEach((m, i) => {
    const entry = pages[m.pageIdx];
    const w = entry.words[m.wordIdx];
    const div = document.createElement("div");
    div.className = "hl";
    div.style.left = `${w.x0}px`;
    div.style.top = `${w.y0}px`;
    div.style.width = `${Math.max(2, w.x1 - w.x0)}px`;
    div.style.height = `${Math.max(2, w.y1 - w.y0)}px`;
    div.dataset.matchIndex = String(i);
    entry.hlLayer.appendChild(div);
  });
  applyActiveStyle();
}

function applyActiveStyle() {
  document.querySelectorAll(".hl.active").forEach((el) => el.classList.remove("active"));
  if (activeMatch < 0) return;
  const el = document.querySelector(`.hl[data-match-index="${activeMatch}"]`);
  if (el) el.classList.add("active");
}

function focusMatch(idx, scroll) {
  applyActiveStyle();
  if (!scroll) return;
  const m = matches[idx];
  if (!m) return;
  const entry = pages[m.pageIdx];
  entry.pageEl.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---------- export menu ----------
exportBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  exportMenu.hidden = !exportMenu.hidden;
});
document.addEventListener("click", (e) => {
  if (!exportMenu.hidden && !exportMenu.contains(e.target) && e.target !== exportBtn) {
    exportMenu.hidden = true;
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !exportMenu.hidden) exportMenu.hidden = true;
});

exportMenu.addEventListener("click", async (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  exportMenu.hidden = true;

  if (action === "copy") {
    const text = pages
      .map((p, i) => `--- Page ${i + 1} ---\n${pageTextWithLineBreaks(p.words)}`)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      const original = exportBtn.textContent;
      exportBtn.textContent = "Copied!";
      setTimeout(() => (exportBtn.textContent = original), 1500);
    } catch {
      setStatus("Couldn't copy to clipboard.", true);
    }
    return;
  }

  if (action === "csv") downloadCsv();
  if (action === "json") downloadJson();
  if (action === "docx") await downloadDocx();
});

function pageTextWithLineBreaks(words) {
  let out = "";
  let prevWord = null;
  for (const w of words) {
    if (!w.text || !w.text.trim()) continue;
    if (prevWord) out += isSameLine(prevWord, w) ? " " : "\n";
    out += w.text;
    prevWord = w;
  }
  return out;
}

function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// One row per page — the simple, spreadsheet-friendly shape. Word-level positions
// don't fit naturally in a flat table, so those live in the JSON export instead.
function downloadCsv() {
  const header = ["page", "source", "text"];
  const rows = pages.map((p, i) => [i + 1, p.source, pageTextWithLineBreaks(p.words)].map(csvEscape).join(","));
  const csv = [header.join(","), ...rows].join("\r\n");
  downloadBlob(csv, `${currentFileName}-scantext.csv`, "text/csv;charset=utf-8");
}

// Full structured export, including per-word bounding boxes — JSON handles nested
// data naturally, so this carries more than the CSV: exact word positions on each
// page, useful for anyone processing the output programmatically rather than just
// reading it in a spreadsheet.
function downloadJson() {
  const data = {
    document: currentFileName,
    generatedAt: new Date().toISOString(),
    pages: pages.map((p, i) => ({
      page: i + 1,
      source: p.source,
      text: pageTextWithLineBreaks(p.words),
      words: p.words.map((w) => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 })),
    })),
  };
  downloadBlob(JSON.stringify(data, null, 2), `${currentFileName}-scantext.json`, "application/json;charset=utf-8");
}

// A readable, shareable document rather than raw data — one heading per page,
// each line of reconstructed text as its own paragraph. Word-level bounding boxes
// don't belong in a document meant to be read, so those stay JSON-only.
async function downloadDocx() {
  const children = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun(currentFileName)],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `Exported ${new Date().toLocaleString()} — ScanText`, italics: true, size: 18 }),
      ],
    }),
  ];

  pages.forEach((p, i) => {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 300 },
        children: [
          new TextRun(`Page ${i + 1}`),
          new TextRun({ text: `  (${p.source === "ocr" ? "OCR" : "text"})`, italics: true, size: 20 }),
        ],
      })
    );

    const text = pageTextWithLineBreaks(p.words);
    const lines = text ? text.split("\n") : [""];
    for (const line of lines) {
      children.push(new Paragraph({ children: [new TextRun(line)] }));
    }
  });

  const doc = new Document({ sections: [{ children }] });

  try {
    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentFileName}-scantext.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("ScanText: docx export failed", err);
    setStatus("Couldn't build the Word document.", true);
  }
}

// ---------- responsive re-fit ----------
window.addEventListener("resize", () => {
  pages.forEach(fitPageToColumn);
});
