// Render-based slide audit using a real browser (headless Chromium in the container).
// Returns per-slide geometry violations against the house rules:
//   stage 1280x720; margins 76/64/96; nothing within 32px of an edge.
// ponytail: puppeteer-core is only installed in the container; require lazily so the
// server still runs locally and audits simply skip when the dep/browser is absent.
const fs = require("fs");
const SLIDE_W = 1280, SLIDE_H = 720;

// Chromium's binary name varies by distro: Alpine ships /usr/bin/chromium,
// Debian/Ubuntu chromium-browser, Google Chrome google-chrome. Detect it.
function chromePath() {
  if (process.env.SLIDEGEN_CHROME) return process.env.SLIDEGEN_CHROME;
  const candidates = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"];
  return candidates.find((p) => fs.existsSync(p)) || "/usr/bin/chromium";
}

let browser = null;
async function chrome() {
  if (browser) return browser;
  const puppeteer = require("puppeteer-core");
  const launched = await puppeteer.launch({
    executablePath: chromePath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  // A crashed browser must not poison later requests with "Connection closed".
  launched.once("disconnected", () => { browser = null; });
  browser = launched;
  return browser;
}

async function auditDeck(sections, globalStyle) {
  // sections: [{html, index}] in deck order; globalStyle: deck <style> text
  // returns { issues: [ {slide, msg} ], ok }
  let page;
  try {
    await chrome();
    page = await browser.newPage();
  } catch {
    return { skipped: true, issues: [], ok: true };
  }
  try {
    const html = buildProbe(sections, globalStyle);
    await page.setViewport({ width: SLIDE_W, height: SLIDE_H });
    await page.setContent(html, { waitUntil: "load" });
    // Neutralize the model's own scaler so we measure in fixed pixels, and make every slide visible.
    await page.evaluate(() => {
      // Some decks apply transform: scale(...) to fit — that shrinks our measurement space.
      document.querySelectorAll("*").forEach((element) => {
        const transform = getComputedStyle(element).transform;
        const isScaled = transform && transform !== "none" && /scale/.test(transform);
        if (isScaled) element.style.transform = "none";
      });
      // Also force every slide to render as a full-size, visible block.
      document.querySelectorAll("section[class*=slide]").forEach((slide) => {
        slide.style.display = "block";
        slide.style.position = "absolute";
        slide.style.width = "1280px";
        slide.style.height = "720px";
      });
    });
    const { issues } = await page.evaluate((SW, SH) => {
      const MARGIN = { left: 76, right: 76, top: 64, bottom: 96 };
      const issues = [];
      document.querySelectorAll("section[class*=slide]").forEach((slide, i) => {
        const slideRect = slide.getBoundingClientRect();
        const slideNo = i + 1;
        // The slide's content bounding box, in viewport coordinates.
        let maxBottom = -1e9, minTop = 1e9, minLeft = 1e9, maxRight = -1e9;
        slide.querySelectorAll("*").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return; // zero-size elements (whitespace nodes etc.)
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") return;
          if (el.localName === "style" || el.localName === "script") return;
          maxBottom = Math.max(maxBottom, r.bottom);
          minTop = Math.min(minTop, r.top);
          minLeft = Math.min(minLeft, r.left);
          maxRight = Math.max(maxRight, r.right);
        });
        if (maxBottom === -1e9) return; // nothing measurable inside this slide
        // Convert viewport coordinates back to "pixels from the slide's top-left corner".
        const y = (v) => Math.round(v - slideRect.top);
        const x = (v) => Math.round(v - slideRect.left);
        if (y(maxBottom) > SH) issues.push({ slide: slideNo, msg: `overflows: content reaches y=${y(maxBottom)}px > 720 stage` });
        else if (y(maxBottom) > SH - MARGIN.bottom + 8) issues.push({ slide: slideNo, msg: `tight bottom: content ends at y=${y(maxBottom)}px, bottom margin must be >=96px (<=624px)` });
        if (y(minTop) < 0) issues.push({ slide: slideNo, msg: `content above slide top (y=${y(minTop)}px)` });
        else if (y(minTop) < MARGIN.top - 24) issues.push({ slide: slideNo, msg: `tight top: content starts at y=${y(minTop)}px, top margin must be >=64px` });
        if (x(maxRight) > SW) issues.push({ slide: slideNo, msg: `overflows right: content at x=${x(maxRight)}px > 1280 stage` });
        else if (x(maxRight) > SW - MARGIN.right + 8) issues.push({ slide: slideNo, msg: `tight right: content at x=${x(maxRight)}px, right margin must be >=76px (<=1204px)` });
        if (x(minLeft) < 0) issues.push({ slide: slideNo, msg: `content left of slide edge (x=${x(minLeft)}px)` });
        else if (x(minLeft) < MARGIN.left - 24) issues.push({ slide: slideNo, msg: `tight left: content at x=${x(minLeft)}px, left margin must be >=76px` });
      });
      return { issues };
    }, SLIDE_W, SLIDE_H);
    await page.close();
    return { skipped: false, issues, ok: issues.length === 0 };
  } catch (error) {
    try { if (page) await page.close(); } catch {}
    return { skipped: true, issues: [], ok: true, error: String(error) };
  }
}

function buildProbe(sections, globalStyle) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${globalStyle ? `<style>${globalStyle}</style>` : ""}</head><body>${sections.map((s) => s.html).join("\n")}</body></html>`;
}

// One PDF page per <section class="slide">, each exactly 1280x720. The deck's own
// scaler/nav is neutralized so every slide is visible and unstretched; print CSS
// forces a page break after each section. Returns { pdf } or { skipped, error }.
async function exportPdf(html) {
  let page;
  try {
    await chrome();
    page = await browser.newPage();
  } catch (error) {
    return { skipped: true, error: String(error) };
  }
  try {
    await page.setViewport({ width: SLIDE_W, height: SLIDE_H });
    await page.setContent(html, { waitUntil: "load" });
    await page.emulateMediaType("print");
    // Decks wrap slides in a fixed, scaled #stage that clips to 720px. Neutralize
    // those wrappers IN PLACE — do not move slides out, or CSS variables/selectors
    // scoped to #stage (backgrounds, colors, padding) stop applying.
    await page.evaluate(() => {
      const slides = [...document.querySelectorAll("section[class*=slide]")];
      if (!slides.length) return;
      // Reveal every slide but KEEP the deck's own display (usually flex) — forcing
      // display:block breaks those layouts and overflows the 720 stage.
      slides.forEach((slide) => slide.classList.add("active"));
      slides.forEach((slide) => { if (getComputedStyle(slide).display === "none") slide.style.setProperty("display", "block", "important"); });
      const ancestors = new Set();
      slides.forEach((slide) => {
        for (let parent = slide.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) ancestors.add(parent);
      });
      ancestors.forEach((el) => {
        const s = el.style;
        s.setProperty("position", "static", "important");
        s.setProperty("transform", "none", "important");
        s.setProperty("overflow", "visible", "important");
        s.setProperty("width", "auto", "important");
        s.setProperty("height", "auto", "important");
        s.setProperty("max-width", "none", "important");
        s.setProperty("max-height", "none", "important");
        s.setProperty("margin", "0", "important");
        s.setProperty("padding", "0", "important");
        s.setProperty("inset", "auto", "important");
        s.setProperty("display", "block", "important");
      });
      // Hide nav chrome/overlays that are neither a slide, inside one, nor an
      // ancestor of one, so they can't add stray printed pages.
      document.querySelectorAll("body *").forEach((el) => {
        if (el.matches("section[class*=slide]") || el.closest("section[class*=slide]") || ancestors.has(el)) return;
        el.style.setProperty("display", "none", "important");
      });
      // Bare text not inside any slide (leaked prose between sections) would
      // render as its own page — remove it. Skip <style>/<script> text.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const stray = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const tag = node.parentElement && node.parentElement.tagName;
        if (tag === "STYLE" || tag === "SCRIPT") continue;
        if (node.textContent.trim() && !node.parentElement.closest("section[class*=slide]")) stray.push(node);
      }
      stray.forEach((node) => node.remove());
    });
    await page.addStyleTag({ content: `
      @page { size: ${SLIDE_W}px ${SLIDE_H}px; margin: 0; }
      * { animation: none !important; transition: none !important; }
      html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
      section[class*="slide"] { position:relative !important;
        box-sizing:border-box !important;
        width:${SLIDE_W}px !important; height:${SLIDE_H}px !important;
        transform:none !important; opacity:1 !important; visibility:visible !important;
        page-break-after: always; break-after: page; page-break-inside: avoid; }
      section[class*="slide"]:last-of-type { page-break-after: auto; break-after: auto; }
    ` });
    const pdf = await page.pdf({ width: `${SLIDE_W}px`, height: `${SLIDE_H}px`, printBackground: true, preferCSSPageSize: true });
    await page.close();
    return { skipped: false, pdf: Buffer.from(pdf) };
  } catch (error) {
    try { if (page) await page.close(); } catch {}
    return { skipped: true, error: String(error) };
  }
}

module.exports = { auditDeck, exportPdf };
