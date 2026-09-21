const http = require("http");
const fs = require("fs");
const path = require("path");
const { SYSTEMS, EDIT_SYSTEM } = require("./design/systems.js");
const { auditDeck, exportPdf } = require("./audit.js");

const PORT = process.env.PORT || 3000;
const STATIC_DIR = path.join(__dirname, "public");
const OUTPUT_DIR = process.env.SLIDEGEN_OUTPUT_DIR || path.join(__dirname, "output");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

// Streaming configuration. Long generations are handled by streaming + two watchdogs:
//   IDLE   — abort if NOTHING arrives for this long (provider stall detection)
//   TOTAL  — hard ceiling for one generation regardless of progress
const IDLE_MS = Number(process.env.SLIDEGEN_IDLE_TIMEOUT_MS || 120_000);
const TOTAL_MS = Number(process.env.SLIDEGEN_TIMEOUT_MS || 900_000);

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req, onDone, maxBytes = 8_000_000) {
  let body = "";
  let over = false;
  req.on("data", (c) => {
    body += c;
    if (Buffer.byteLength(body) > maxBytes) { over = true; req.destroy(); }
  });
  req.on("end", () => { if (!over) onDone(body); });
}

// Provider config: everything comes from the UI request; env vars are fallback only, never credentials in code.
// Works with any OpenAI-compatible endpoint (e.g. https://api.openai.com/v1, Ollama, vLLM, OpenRouter, …).
function providerConfig(provider = {}) {
  const requestHeaders = provider.headers;
  const validHeaders = typeof requestHeaders === "object" && requestHeaders !== null && !Array.isArray(requestHeaders);

  const baseUrl = String(provider.baseUrl || process.env.SLIDEGEN_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = provider.model || process.env.SLIDEGEN_MODEL || "gpt-4o-mini";
  const apiKey = provider.apiKey || process.env.SLIDEGEN_API_KEY || "";
  return { baseUrl, model, apiKey, headers: { "User-Agent": "slidegen/0.1", ...(validHeaders ? requestHeaders : {}) } };
}

async function smallCall(config, urlPath, timeoutMs = 60_000) {
  const headers = { ...config.headers };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const response = await fetch(config.baseUrl + urlPath, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw await providerError(response);
  return response.json();
}

// Providers return model lists in different shapes for the same /models endpoint.
// Examples: { data: ["gpt-4"] }, { models: [{ id: "gpt-4" }] }, or a bare array.
function parseModelList(data) {
  const raw = data.data || data.models || data || [];
  if (!Array.isArray(raw)) return [];
  const names = raw.map((entry) => (typeof entry === "string" ? entry : entry.id || entry.model || entry.name));
  return names.filter((name) => typeof name === "string");
}

// Keep only the HTML document itself. Models wrap it in prose and/or a ```html
// fence, and often append explanation after </html> — all of which must not be
// saved, shown, or printed as extra slides. Returns null if there's no document.
function extractDocument(text) {
  const start = text.search(/<!doctype html|<html[\s>]/i);
  if (start < 0) return null;
  const tail = text.slice(start);
  const htmlEnd = tail.search(/<\/html>/i);
  if (htmlEnd >= 0) return tail.slice(0, htmlEnd + 7).trim();
  const bodyEnd = tail.search(/<\/body>/i);
  if (bodyEnd >= 0) return tail.slice(0, bodyEnd + 7).trim();
  return tail.trim();
}

// Clean a full deck (extractDocument) or a single slide fragment (fences only).
function stripFences(text) {
  return extractDocument(text) || text
    .replace(/^[\s\S]*?\n\s*```[a-z]*\s*\n/, "") // prose before the first ```…``` fence
    .replace(/^```[a-z]*\n?/, "")               // ``` at the very top, no fence language
    .replace(/```\s*$/, "")
    .trim();
}

// Stream a chat call and return the cleaned string (used for edit retries).
async function callEditStream(config, messages, corrective) {
  const extra = corrective ? [{ role: "user", content: corrective }] : [];
  let raw = "";
  await streamChat(config, { model: config.model, stream: true, messages: [...messages, ...extra] }, (delta) => { raw += delta; });
  return stripFences(raw);
}

// Format a failed provider response into a short error message.
// Anthropic-native endpoints reject chat/completions entirely (HTTP 500 with
// {"type":"error",...} bodies) — that's a base-URL misconfiguration, so say so.
async function providerError(response) {
  const text = (await response.text()).slice(0, 500);
  const looksAnthropic = text.includes('"type":"error"');
  if (looksAnthropic) {
    return new Error(`provider ${response.status} — this base URL looks Anthropic-native, not OpenAI-compatible. slidegen speaks the OpenAI chat/completions dialect; use a provider/gateway that accepts {"model", "messages", "stream"} at /chat/completions. Body: ${text}`);
  }
  return new Error(`provider ${response.status}: ${text}`);
}

// Turn one "data: {...}" line from the SSE stream into a text fragment, or "" if none.
function textDeltaFromSseLine(line) {
  if (!line.startsWith("data:")) return "";
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") return "";
  try {
    return JSON.parse(payload).choices?.[0]?.delta?.content || "";
  } catch {
    return ""; // keepalive pings and partial lines are not JSON — ignore them
  }
}

// Stream a chat completion, invoking onChunk(delta, received, seconds) per text delta.
// Pass a controller to cancel it from outside (e.g. a queued job's cancel button).
function streamChat(config, body, onChunk, controller) {
  return new Promise((resolve, reject) => {
    const headers = { "Content-Type": "application/json", ...config.headers };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const started = Date.now();
    let lastData = started;
    let received = 0;
    let settled = false;
    let reader = null;
    const abort = controller || new AbortController();
    const fail = (e) => { if (settled) return; settled = true; cleanup(); reject(e); };
    const finish = () => { if (!settled) { settled = true; cleanup(); resolve(received); } };
    const cleanup = () => { clearInterval(idle); clearTimeout(total); try { reader?.cancel(); } catch {} };
    const idle = setInterval(() => {
      if (!settled && Date.now() - lastData > IDLE_MS) {
        abort.abort();
        fail(new Error(`stalled: no data from provider for ${Math.round(IDLE_MS / 1000)}s — aborted (retry or check provider)`));
      }
    }, 2000);
    const total = setTimeout(() => { if (!settled) { abort.abort(); fail(new Error(`generation exceeded ${Math.round(TOTAL_MS / 60000)} min hard limit`)); } }, TOTAL_MS);

    fetch(config.baseUrl + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abort.signal,
    }).then(async (response) => {
      if (!response.ok) return fail(await providerError(response));
      if (!response.body) return fail(new Error("provider sent no body"));

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastData = Date.now();
        buffer += decoder.decode(value, { stream: true });
        // SSE events are newline-separated lines; process all complete lines.
        let newlineAt = buffer.indexOf("\n");
        while (newlineAt >= 0) {
          const line = buffer.slice(0, newlineAt).trim();
          buffer = buffer.slice(newlineAt + 1);
          const delta = textDeltaFromSseLine(line);
          if (delta) {
            received += delta.length;
            const secondsSoFar = (Date.now() - started) / 1000;
            onChunk(delta, received, secondsSoFar);
          }
          newlineAt = buffer.indexOf("\n");
        }
      }
      log(`provider stream done in ${Math.round((Date.now() - started) / 1000)}s chars=${received} model=${config.model}`);
      finish();
    }).catch((e) => { if (!settled) { fail(e); } else { try { reader?.cancel(); } catch {} } });
  });
}

// The class reserved for the edited/inserted slide: replace keeps the target's slot,
// a new slide takes the next free number.
function editSlideClass(action, index, count) {
  return action === "replace" ? `s${index + 1}` : `s${count + 1}`;
}

// One line per slide; the target is swapped in and marked with "→ TARGET".
function editOutline(slides, index, target) {
  return slides
    .map((slideHtml, i) => {
      const shown = i === index ? target : slideHtml;
      const marker = i === index ? "→ TARGET" : i === index - 1 ? "↖" : " ";
      const textPreview = shown.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
      return `  ${marker}[${i + 1}] ${textPreview}`;
    })
    .join("\n");
}

// Surrounding slides used as context, plus the target snapshot.
function editContext(slides, index, action) {
  const n = slides.length;
  const snap = (i, label) => `<!-- ${label} (slide ${i + 1} of ${n}) -->\n${slides[i]}`;
  let context = "";
  if (index > 0 && action !== "insert_before") context += snap(index - 1, "previous slide") + "\n\n";
  let target = "";
  if (action === "replace") target = snap(index, "target slide");
  else {
    // Insertion: style-match to the closest slide.
    if (index > 0) context += snap(Math.min(index, n - 1), "slide before insertion point") + "\n\n";
    if (index < n) target = snap(index, "slide after insertion point");
  }
  return { context, target };
}

function editTask(action, index, slideClass) {
  return action === "replace"
    ? `REGENERATE the TARGET slide. Keep its role in the deck, apply the user's fix below, and improve layout/typography per the design system. Your section keeps the number ${index + 1} — use class "${slideClass}". IMPORTANT: this is a restyle/fix pass — unless the instruction explicitly asks for new content, keep the target slide's topic, bullets and facts intact.`
    : `CREATE ONE NEW slide to insert at that position, matching the visual system of the neighboring slides (a unique class has been reserved for you: "${slideClass}" — see Output Format).`;
}

function editStyleBlock(style) {
  return style ? `

Deck <style> (scoping note inside applies to every selector below; truncate nothing — read the .s{n} pattern):
<style>
${String(style).slice(0, 6000)}
</style>` : "";
}

function editFormat(slideClass) {
  return `

Output format (exactly):
<style>
  /* ALL rules your slide needs, scoped under your section's unique class */
</style>
<section class="slide ${slideClass}">
  <!-- the slide markup -->
</section>`;
}

// Build the single-slide edit prompt (replace or insert).
function editPrompt(brief, slides, index, action, instruction, style) {
  const slideClass = editSlideClass(action, index, slides.length);
  const { context, target } = editContext(slides, index, action);
  return `${editTask(action, index, slideClass)}

DECK OUTLINE (so you understand where this slide sits in the narrative; → is the TARGET):
${editOutline(slides, index, target)}

Original brief:
${brief}

${context}
${target}

User instruction for the slide:
${instruction}
${editStyleBlock(style)}
${editFormat(slideClass)}

Output rules:
- Respond with ONLY the single slide markup: one <style>…</style> + one <section class="slide">…</section> block.
- It must look native to the deck (reuse the same CSS variables/classes the deck defines).
- FIDELITY (hard rule): keep every fact, number, name, citation, and bullet topic that exists
  on the target slide. The instruction may reframe wording or pacing; deleting substantive
  information is allowed ONLY when the user explicitly asks for that deletion. When reducing
  density for fit, compress phrasing or move detail into a table column / sub-line — do not
  silently drop facts.
- FIT (hard rule): the fixed slide must not overflow at any viewport. Respect the deck's
  type scale; reduce within slide-local bounds first (tighten padding, trim non-factual
  decoration), split ONLY if the user asks for a new slide. Test your sizes mentally for
  the longest line (title nine words / body <= 46 chars/line).
- IMAGES: no external URLs, no file paths. If the user asks for an image, draw it as an
  inline <svg> illustration (simple, matching the design system's shapes/colors) — never
  <img src="http...">. Data URIs are also acceptable.
- No <html>, no fences, no commentary — start the answer directly with the <section> tag.
- INSTRUCTION SCOPE: the user instruction describes a change to THE TARGET SLIDE (layout,
  style, emphasis, density). It is never a request for a different slide. If it mentions
  content the target lacks (commands, examples, a guide), ADD that as an enrichment inside
  the target slide's own topic — preserving all existing facts — instead of swapping topics
  or producing a copy of a neighboring slide.`;
}

// Token-overlap helpers for content fidelity checks: strip markup, keep meaningful words,
// then compare what fraction of the smaller word set is shared.
const STOP = new Set("the and for with that this from into your you can its are was were has have will would their there these those more most than then when what about into over under near between one two all any each every".split(" "));
function tokens(html) {
  const withoutStyles = html.replace(/<style[\s\S]*?<\/style>/gi, " ");
  const textOnly = withoutStyles.replace(/<[^>]+>/g, " ").toLowerCase();
  const words = textOnly.match(/[a-z0-9]{3,}/g) || [];
  const meaningfulWords = words.filter((word) => !STOP.has(word));
  return new Set(meaningfulWords);
}
function overlap(tokensA, tokensB) {
  if (!tokensA.size || !tokensB.size) return 0;
  let shared = 0;
  tokensA.forEach((word) => { if (tokensB.has(word)) shared++; });
  return shared / Math.min(tokensA.size, tokensB.size);
}
// Structural rules a generated deck must satisfy. Returns warnings (never blocks);
// geometry is checked separately against the rendered stage by auditDeckHtml.
function deckRuleIssues(html) {
  const issues = [];
  if (!/<html[\s>]/i.test(html)) issues.push({ slide: 0, msg: "not a complete HTML document" });
  if (!/<style[\s>]/i.test(html)) issues.push({ slide: 0, msg: "no <style> block — deck would be unstyled" });
  if (!/<section[^>]*class="[^"]*slide/gi.test(html)) issues.push({ slide: 0, msg: 'no <section class="slide"> found' });
  if (/<img\b[^>]*\bsrc\s*=\s*["']https?:/i.test(html)) issues.push({ slide: 0, msg: 'external <img src="http..."> — use inline <svg> or a data URI' });
  if (/<script\b[^>]*\bsrc\s*=\s*["']https?:/i.test(html)) issues.push({ slide: 0, msg: 'external <script src="http..."> — decks must be self-contained' });
  return issues;
}

// Render-audit a finished deck; returns issues ([] when the audit is unavailable).
async function auditDeckHtml(html) {
  const style = html.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] || "";
  const sections = [...html.matchAll(/<section[\s\S]*?<\/section>/g)].map((match) => ({ html: match[0] }));
  if (!sections.length) return [];
  const audit = await auditDeck(sections, style);
  return audit.ok ? [] : audit.issues;
}

// Persist a finished deck to <root>/<timestamp>/deck.html; returns the file path.
function saveDeck(html, root = OUTPUT_DIR, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(root, stamp);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "deck.html");
  fs.writeFileSync(file, html);
  return file;
}

// Run one queued generation. Never throws: the outcome is recorded on the job.
async function runJob(job) {
  job.phase = "running";
  job.startedAt = Date.now();
  job.abort = new AbortController();
  let lastLogged = 0;
  try {
    log(`generate started: job=${job.id} model=${job.config.model} preset=${job.preset || "swiss"} brief=${job.prompt.length} chars`);
    await streamChat(job.config, {
      model: job.config.model,
      stream: true,
      messages: [
        { role: "system", content: SYSTEMS[job.preset] || SYSTEMS.swiss },
        { role: "user", content: job.prompt },
      ],
    }, (delta, chars) => {
      job.html += delta;
      job.chars = chars;
      if (chars - lastLogged > 2000) {
        lastLogged = chars;
        log(`generate stream: job=${job.id} ${chars} chars in ${Math.round((Date.now() - job.startedAt) / 1000)}s`);
      }
    }, job.abort);
    job.html = stripFences(job.html);
    job.seconds = Math.round((Date.now() - job.startedAt) / 1000);
    if (!/<html/i.test(job.html)) throw new Error("model did not return HTML. First 300 chars: " + job.html.slice(0, 300));
    // Warn about structural and geometry issues so the user can ✎ fix targeted slides.
    try {
      const issues = [...deckRuleIssues(job.html), ...(await auditDeckHtml(job.html))];
      if (issues.length) {
        job.issues = issues;
        issues.forEach((issue) => log(`generate audit: slide ${issue.slide} — ${issue.msg}`));
      }
    } catch (auditError) { log(`generate audit skipped: ${auditError.message}`); }
    const file = saveDeck(job.html);
    log(`generate done: job=${job.id} ${job.html.length} chars in ${job.seconds}s → ${path.relative(__dirname, file)}`);
    job.phase = "done";
  } catch (error) {
    if (job.abort && job.abort.signal.aborted) { job.phase = "cancelled"; log(`generate cancelled: job=${job.id}`); }
    else { job.phase = "error"; job.error = error.message; log(`generate failed: job=${job.id} — ${error.message.slice(0, 120)}`); }
  } finally {
    job.config = null; job.prompt = null; job.abort = null;
  }
}

// In-memory, single-concurrency job queue. Decoupled from the HTTP request so a page
// refresh doesn't cancel a generation; the client reattaches via GET /generate/:id.
// `run` is injectable so the queue logic can be tested without a provider.
function createQueue(run, keep = 30) {
  const jobs = new Map();
  const pending = [];
  let running = false;
  let seq = 0;

  // Snapshot sent to the client — never includes credentials.
  function view(job) {
    const v = { id: job.id, phase: job.phase, chars: job.chars };
    if (job.phase === "queued") v.queuePosition = pending.indexOf(job) + 1;
    else if (job.phase === "running") v.seconds = Math.round((Date.now() - job.startedAt) / 1000);
    else v.seconds = job.seconds;
    if (job.phase === "done") { v.html = job.html; v.issues = job.issues || []; }
    if (job.phase === "error") v.error = job.error;
    return v;
  }

  // Keep memory bounded: drop the oldest finished jobs beyond `keep`.
  function prune() {
    const finished = [...jobs.values()].filter((job) => job.phase !== "queued" && job.phase !== "running");
    for (let i = 0; i < finished.length - keep; i++) jobs.delete(finished[i].id);
  }

  function pump() {
    if (running) return;
    const job = pending.shift();
    if (!job) return;
    running = true;
    job.phase = "running";
    job.startedAt = Date.now();
    Promise.resolve()
      .then(() => run(job))
      .catch((error) => { job.phase = "error"; job.error = error.message; })
      .finally(() => { running = false; pump(); });
  }

  function enqueue(config, prompt, preset) {
    const job = {
      id: `${Date.now().toString(36)}-${++seq}`,
      phase: "queued", chars: 0, html: "", seconds: 0, startedAt: 0,
      issues: null, error: null, config, prompt, preset, abort: null,
    };
    jobs.set(job.id, job);
    pending.push(job);
    prune();
    pump();
    return job;
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return null;
    if (job.phase === "queued") {
      const i = pending.indexOf(job);
      if (i >= 0) pending.splice(i, 1);
      job.phase = "cancelled";
    } else if (job.phase === "running" && job.abort) {
      job.abort.abort();
    }
    return job;
  }

  return { enqueue, cancel, view, prune, get: (id) => jobs.get(id), jobs, pending };
}

const queue = createQueue(runJob);

// ─── HTTP handlers ─────────────────────────────────────────────────
function handleModels(req, res, finish) {
  readBody(req, async (body) => {
    try {
      const { provider } = JSON.parse(body || "{}");
      const config = providerConfig(provider);
      if (!config.apiKey) return finish(400, JSON.stringify({ error: "api key required" }));
      const list = parseModelList(await smallCall(config, "/models"));
      finish(200, JSON.stringify({ models: list }));
    } catch (error) {
      finish(502, JSON.stringify({ error: error.message }));
    }
  });
}

function handleSave(req, res, finish) {
  readBody(req, (body) => {
    try {
      const { html, title } = JSON.parse(body || "{}");
      if (!html || !/<html/i.test(html)) return finish(400, JSON.stringify({ error: "html required" }));
      const outputDir = path.join(OUTPUT_DIR, title || "edited");
      fs.mkdirSync(outputDir, { recursive: true });
      // Numbered files: 1-deck.html, 2-deck.html, ...
      const existing = fs.readdirSync(outputDir).filter((name) => name.endsWith(".html"));
      const file = path.join(outputDir, `${existing.length + 1}-deck.html`);
      const doc = extractDocument(html) || html;
      fs.writeFileSync(file, doc);
      log(`saved ${path.relative(__dirname, file)} (${doc.length} chars)`);
      finish(200, JSON.stringify({ saved: path.basename(file) }));
    } catch (error) {
      finish(500, JSON.stringify({ error: error.message }));
    }
  });
}

function handleEdit(req, res, finish) {
  readBody(req, async (body) => {
    try {
      const { prompt, provider, slides, index, action, instruction, style } = JSON.parse(body || "{}");
      if (!Array.isArray(slides) || !slides.length) return finish(400, JSON.stringify({ error: "slides[] required" }));
      if (action === "replace" && (index < 0 || index >= slides.length)) return finish(400, JSON.stringify({ error: "bad index" }));
      if (!instruction || !instruction.trim()) return finish(400, JSON.stringify({ error: "instruction required" }));
      const config = providerConfig(provider);
      if (!config.apiKey) return finish(400, JSON.stringify({ error: "no API key: set it in provider settings" }));
      const messages = [
        { role: "system", content: EDIT_SYSTEM },
        { role: "user", content: editPrompt(prompt || "(brief not kept)", slides, index, action || "replace", instruction.trim(), style) },
      ];
      let output = "";
      await streamChat(config, { model: config.model, stream: true, messages }, (delta) => { output += delta; });
      output = stripFences(output);
      if (!/<section/i.test(output)) throw new Error("model did not return a <section>. First 300 chars: " + output.slice(0, 300));
      // Reuse-class violation: slide-local scope required when deck CSS provided; retry once with the reason.
      if (style && !output.toLowerCase().includes("<style")) {
        log("edit: output had no slide-local <style>, retrying with correction");
        await streamChat(config, {
          model: config.model, stream: true,
          messages: [...messages, { role: "assistant", content: "(previous attempt reused sibling classes without defining scoped CSS)" },
            { role: "user", content: `Your previous answer used classes styled only under the original slide's scope (e.g. .s4 .row) — on its own it renders unstyled. Redo it: give your section a unique class and include a <style> block defining EVERY rule your slide needs, scoped under that class. Keep all content and the design system identical otherwise.` }],
        }, (delta) => { output += delta; });
        output = stripFences(output);
      }
      if (!/<section/i.test(output)) throw new Error("no <section> after retry. First 300 chars: " + output.slice(0, 300));

      // CONTENT FIDELITY: a fix/replace must keep the target slide's facts. Inserts must not duplicate a sibling.
      const target = slides[index] || "";
      if (action === "replace") {
        const keptTokens = overlap(tokens(output), tokens(target));
        if (keptTokens < 0.3) {
          log(`edit: fidelity ${keptTokens.toFixed(2)} too low, retrying with constraint`);
          output = await callEditStream(config, messages, `YOUR PREVIOUS ANSWER DISCARDED THE TARGET SLIDE'S CONTENT (token overlap ${(keptTokens * 100).toFixed(0)}%). The user asked to restyle/fix slides, not to replace their topic. Redo the same fix, with every fact, number and name from the TARGET slide intact in your markup. Only the layout and styling change.`);
          const keptTokensAfterRetry = overlap(tokens(output), tokens(target));
          if (keptTokensAfterRetry < 0.3) log(`edit: fidelity still low after retry (${keptTokensAfterRetry.toFixed(2)}) — returning anyway`);
        }
      } else {
        // Insert: find the most similar existing slide; a near-copy is a bug worth redoing.
        const similarityToEachSlide = slides.map((slideHtml, j) => [j, overlap(tokens(output), tokens(slideHtml))]);
        const mostSimilar = similarityToEachSlide.sort((a, b) => b[1] - a[1])[0];
        const [similarSlideIndex, similarScore] = mostSimilar;
        if (similarScore > 0.85) {
          log(`edit: new slide duplicates existing slide ${similarSlideIndex + 1} (${similarScore.toFixed(2)}), retrying`);
          output = await callEditStream(config, messages, `YOUR PREVIOUS ANSWER WAS A NEAR-COPY OF THE DECK'S EXISTING SLIDE ${similarSlideIndex + 1}. Create a DIFFERENT slide instead, covering the user's instruction from a fresh angle with distinct content.`);
        }
      }

      // Render-audit the finished slide inside the deck (with the new slide swapped in),
      // and retry once with the measured geometry issues.
      const deckWithEditedSlide = slides.map((slideHtml, j) => ({ html: j === index ? output : slideHtml }));
      const audited = await auditDeck(deckWithEditedSlide, style || "");
      if (!audited.ok && audited.issues.length) {
        const issueList = audited.issues.map((issue) => `slide ${issue.slide}: ${issue.msg}`).join("; ");
        log(`edit audit: retrying — ${issueList}`);
        output = await callEditStream(config, messages, `Your slide had real geometry violations in a browser: ${issueList}. Rules: content must end above y=624 (720-96 bottom margin), start after y=64, and stay between x=76 and x=1204. Re-render the same slide, identical design & content, with corrected sizes/spacings so these measurements pass.`);
      }
      if (!/<section/i.test(output)) throw new Error("edit failed validation. First 300 chars: " + output.slice(0, 300));
      log(`edit ${action} slide ${index} → ${output.length} chars`);
      finish(200, JSON.stringify({ section: output }));
    } catch (error) {
      finish(502, JSON.stringify({ error: error.message }));
    }
  });
}

function handleExport(req, res, finish) {
  readBody(req, async (body) => {
    try {
      const { html } = JSON.parse(body || "{}");
      if (!html || !/<html/i.test(html)) return finish(400, JSON.stringify({ error: "html required" }));
      const result = await exportPdf(extractDocument(html) || html);
      if (result.skipped || !result.pdf) {
        const reason = result.error || "browser unavailable";
        return finish(503, JSON.stringify({ error: `PDF export needs the container (headless Chromium): ${reason}` }));
      }
      const pdfDir = path.join(OUTPUT_DIR, "pdf");
      fs.mkdirSync(pdfDir, { recursive: true });
      const pdfFile = path.join(pdfDir, `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.pdf`);
      fs.writeFileSync(pdfFile, result.pdf);
      log(`export pdf ${result.pdf.length} bytes → ${path.relative(__dirname, pdfFile)}`);
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": result.pdf.length, "Content-Disposition": 'attachment; filename="deck.pdf"', "Cache-Control": "no-store" });
      res.end(result.pdf);
    } catch (error) {
      finish(500, JSON.stringify({ error: error.message }));
    }
  });
}

function handleGenerate(req, res, finish) {
  readBody(req, (raw) => {
    let parsed;
    try { parsed = JSON.parse(raw || "{}"); }
    catch { return finish(400, JSON.stringify({ error: "bad json" })); }
    const { prompt, preset, provider } = parsed;
    if (!prompt || !prompt.trim()) return finish(400, JSON.stringify({ error: "prompt required" }));
    const config = providerConfig(provider);
    if (!config.apiKey) return finish(400, JSON.stringify({ error: "no API key: set it in provider settings" }));
    finish(200, JSON.stringify(queue.view(queue.enqueue(config, prompt.trim(), preset))));
  });
}

function handleJobStatus(res, finish, id) {
  const job = queue.get(id);
  if (!job) return finish(404, JSON.stringify({ error: "unknown job" }));
  finish(200, JSON.stringify(queue.view(job)));
}

function handleCancel(res, finish, id) {
  const job = queue.cancel(id);
  if (!job) return finish(404, JSON.stringify({ error: "unknown job" }));
  finish(200, JSON.stringify(queue.view(job)));
}

// Static file fallback: serve files from public/, map "/" to index.html.
function serveStatic(req, res, finish) {
  const urlPath = req.url.split("?")[0];
  const file = path.join(STATIC_DIR, urlPath === "/" ? "index.html" : urlPath);
  if (file.startsWith(STATIC_DIR) && fs.existsSync(file)) {
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
  } else {
    finish(404, "not found");
  }
}

function route(req, res, finish) {
  const jobMatch = req.method === "GET" && /^\/generate\/([\w-]+)$/.exec(req.url);
  const cancelMatch = req.method === "POST" && /^\/generate\/([\w-]+)\/cancel$/.exec(req.url);
  if (req.method === "POST" && req.url === "/models") return handleModels(req, res, finish);
  if (req.method === "POST" && req.url === "/save") return handleSave(req, res, finish);
  if (req.method === "POST" && req.url === "/edit") return handleEdit(req, res, finish);
  if (req.method === "POST" && req.url === "/export") return handleExport(req, res, finish);
  if (req.method === "POST" && req.url === "/generate") return handleGenerate(req, res, finish);
  if (jobMatch) return handleJobStatus(res, finish, jobMatch[1]);
  if (cancelMatch) return handleCancel(res, finish, cancelMatch[1]);
  return serveStatic(req, res, finish);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const finish = (code, payload) => {
    log(`${req.method} ${req.url} ${code} in ${Date.now() - started}ms`);
    send(res, code, payload);
  };
  try { route(req, res, finish); }
  catch (error) { finish(500, JSON.stringify({ error: error.message })); }
});

if (require.main === module) {
  server.requestTimeout = 0;
  server.keepAliveTimeout = 300_000;
  server.listen(PORT, () => log(`slidegen on http://localhost:${PORT} (idle watchdog ${IDLE_MS / 1000}s, total cap ${TOTAL_MS / 60000}m)`));
}

module.exports = {
  extractDocument, stripFences, parseModelList, providerConfig, textDeltaFromSseLine, tokens, overlap,
  editSlideClass, editOutline, editContext, editPrompt,
  auditDeckHtml, deckRuleIssues, saveDeck, createQueue, runJob, queue, route, server,
};
