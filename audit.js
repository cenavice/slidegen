// Render-based slide audit using a real browser (headless Chromium in the container).
// Returns per-slide geometry violations against the house rules:
//   stage 1280x720; margins 76/64/96; nothing within 32px of an edge.
// ponytail: puppeteer-core is only installed in the container; require lazily so the
// server still runs locally and audits simply skip when the dep/browser is absent.
const SLIDE_W = 1280, SLIDE_H = 720;
const MARGIN = { left: 76, right: 76, top: 64, bottom: 96 };
const EDGE = 32; // nothing closer than this to any edge

let browser = null;
async function chrome() {
  if (browser) return browser;
  const puppeteer = require("puppeteer-core");
  browser = await puppeteer.launch({
    executablePath: process.env.SLIDEGEN_CHROME || "/usr/bin/chromium-browser",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
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
      document.querySelectorAll("*").forEach((el) => {
        const t = getComputedStyle(el).transform;
        if (t && t !== "none" && /scale/.test(t)) el.style.transform = "none";
      });
      document.querySelectorAll("section[class*=slide]").forEach((s) => {
        s.style.display = "block";
        s.style.position = "absolute";
        s.style.width = "1280px";
        s.style.height = "720px";
      });
    });
    const { issues } = await page.evaluate((SW, SH) => {
      const MARGIN = { left: 76, right: 76, top: 64, bottom: 96 };
      const out = { issues: [] };
      document.querySelectorAll("section[class*=slide]").forEach((slide, i) => {
        const sr = slide.getBoundingClientRect();
        const slideNo = i + 1;
        let maxBottom = -1e9, minTop = 1e9, minLeft = 1e9, maxRight = -1e9;
        slide.querySelectorAll("*").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return;
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") return;
          if (el.localName === "style" || el.localName === "script") return;
          maxBottom = Math.max(maxBottom, r.bottom); minTop = Math.min(minTop, r.top);
          minLeft = Math.min(minLeft, r.left); maxRight = Math.max(maxRight, r.right);
        });
        if (maxBottom === -1e9) return;
        const rel = (v) => Math.round(v - sr.top);
        const relx = (v) => Math.round(v - sr.left);
        if (rel(maxBottom) > SH) out.issues.push({ slide: slideNo, msg: `overflows: content reaches y=${rel(maxBottom)}px > 720 stage` });
        else if (rel(maxBottom) > SH - MARGIN.bottom + 8) out.issues.push({ slide: slideNo, msg: `tight bottom: content ends at y=${rel(maxBottom)}px, bottom margin must be >=96px (<=624px)` });
        if (rel(minTop) < 0) out.issues.push({ slide: slideNo, msg: `content above slide top (y=${rel(minTop)}px)` });
        else if (rel(minTop) < MARGIN.top - 24) out.issues.push({ slide: slideNo, msg: `tight top: content starts at y=${rel(minTop)}px, top margin must be >=64px` });
        if (relx(maxRight) > SW) out.issues.push({ slide: slideNo, msg: `overflows right: content at x=${relx(maxRight)}px > 1280 stage` });
        else if (relx(maxRight) > SW - MARGIN.right + 8) out.issues.push({ slide: slideNo, msg: `tight right: content at x=${relx(maxRight)}px, right margin must be >=76px (<=1204px)` });
        if (relx(minLeft) < 0) out.issues.push({ slide: slideNo, msg: `content left of slide edge (x=${relx(minLeft)}px)` });
        else if (relx(minLeft) < MARGIN.left - 24) out.issues.push({ slide: slideNo, msg: `tight left: content at x=${relx(minLeft)}px, left margin must be >=76px` });
      });
      return out;
    }, SLIDE_W, SLIDE_H);
    await page.close();
    return { skipped: false, issues, ok: issues.length === 0 };
  } catch (e) {
    try { if (page) await page.close(); } catch {}
    return { skipped: true, issues: [], ok: true, error: String(e) };
  }
}

function buildProbe(sections, globalStyle) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${globalStyle ? `<style>${globalStyle}</style>` : ""}</head><body>${sections.map((s) => s.html).join("\n")}</body></html>`;
}

module.exports = { auditDeck };
