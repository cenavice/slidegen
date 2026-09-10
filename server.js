const http = require("http");
const fs = require("fs");
const path = require("path");
const { SYSTEMS } = require("./design/systems.js");

const PORT = process.env.PORT || 3000;
const STATIC_DIR = path.join(__dirname, "public");
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
  res.writeHead(code, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, onDone) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => onDone(body));
}

// Provider config: everything comes from the UI request; env vars are fallback only, never credentials in code.
function providerConfig(provider = {}) {
  const baseUrl = String(provider.baseUrl || process.env.SLIDEGEN_BASE_URL || "https://opencode.ai/zen/go/v1").replace(/\/+$/, "");
  const model = provider.model || process.env.SLIDEGEN_MODEL || "mimo-v2.5";
  const apiKey = provider.apiKey || process.env.OPENCODE_API_KEY || "";
  const headers = (provider.headers && typeof provider.headers === "object" && !Array.isArray(provider.headers)) ? provider.headers : {};
  return { baseUrl, model, apiKey, headers: { "User-Agent": "slidegen/0.1", ...headers } };
}

async function smallCall(config, urlPath, body, timeoutMs = 60_000) {
  const h = { "Content-Type": "application/json", ...config.headers };
  if (config.apiKey) h.Authorization = `Bearer ${config.apiKey}`;
  const r = await fetch(config.baseUrl + urlPath, { method: "POST", headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`provider ${r.status}: ${(await r.text()).slice(0, 500)}`);
  return r.json();
}

function parseModelList(data) {
  const raw = data.data || data.models || data || [];
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => (typeof m === "string" ? m : m.id || m.model || m.name)).filter((x) => typeof x === "string");
}

// Stream a chat completion, invoking onChunk(delta, received, seconds) per text delta.
function streamChat(config, body, onChunk) {
  return new Promise((resolve, reject) => {
    const headers = { "Content-Type": "application/json", ...config.headers };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const started = Date.now();
    let lastData = started;
    let received = 0;
    let settled = false;
    let reader = null;
    const abort = new AbortController();
    const fail = (e) => { if (settled) return; settled = true; cleanup(); reject(e); };
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
    }).then(async (r) => {
      if (!r.ok) return fail(new Error(`provider ${r.status}: ${(await r.text()).slice(0, 500)}`));
      if (!r.body) return fail(new Error("provider sent no body"));
      reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastData = Date.now();
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const delta = JSON.parse(payload).choices?.[0]?.delta?.content || "";
            if (delta) { received += delta.length; onChunk(delta, received, (Date.now() - started) / 1000); }
          } catch {}
        }
      }
      const ms = Date.now() - started;
      log(`provider stream done in ${Math.round(ms / 1000)}s chars=${received} model=${config.model}`);
      if (!settled) { settled = true; cleanup(); resolve(received); }
    }).catch((e) => { if (!settled) { settled = true; cleanup(); reject(e); } else { try { reader?.cancel(); } catch {} } });
  });
}

// Build the single-slide regeneration/insertion prompt.
function editPrompt(brief, slides, index, action, instruction) {
  const n = slides.length;
  const snap = (i, label) => `<!-- ${label} (slide ${i + 1} of ${n}) -->\n${slides[i]}`;
  let ctx = "";
  if (index > 0 && action !== "insert_before") ctx += snap(index - 1, "previous slide") + "\n\n";
  let target = "";
  if (action === "replace") target = snap(index, "target slide");
  else {
    // Insertion: style-match to the closest slide.
    if (index > 0) ctx += snap(Math.min(index, n - 1), "slide before insertion point") + "\n\n";
    if (index < n) target = snap(index, "slide after insertion point");
  }
  const task = action === "replace"
    ? `REGENERATE the TARGET slide. Keep its role in the deck, apply the user's fix below, and improve layout/typography per the design system.`
    : `CREATE ONE NEW slide to insert at that position, matching the visual system of the neighboring slides (same CSS is already global; your slide inherits the deck's <style>).`;
  return `${task}

Original brief:
${brief}

${ctx}
${target}

User instruction for the slide:
${instruction}

Output rules:
- Respond with ONLY the single slide markup: one <section class="slide">…</section> block.
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
- No <html>, no fences, no commentary — start the answer directly with the <section> tag.`;
}

// Extract slide sections from a deck's HTML via regex (safe for offset tracking client-side).
function extractSlides(html) {
  const re = /<section[^>]*class="[^"]*slide[^"]*"[^>]*>[\s\S]*?<\/section>/gi;
  const found = html.match(re) || [];
  return found;
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const done = (code, payload) => {
    log(`${req.method} ${req.url} ${code} in ${Date.now() - t0}ms`);
    send(res, code, payload);
  };

  if (req.method === "POST" && req.url === "/models") {
    readBody(req, async (body) => {
      try {
        const { provider } = JSON.parse(body || "{}");
        const config = providerConfig(provider);
        if (!config.apiKey) return done(400, JSON.stringify({ error: "api key required" }));
        const list = parseModelList(await smallCall(config, "/models", {}));
        done(200, JSON.stringify({ models: list }));
      } catch (e) {
        done(502, JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/edit") {
    readBody(req, async (body) => {
      try {
        const { prompt, preset, provider, slides, index, action, instruction } = JSON.parse(body || "{}");
        if (!Array.isArray(slides) || !slides.length) return done(400, JSON.stringify({ error: "slides[] required" }));
        if (action === "replace" && (index < 0 || index >= slides.length)) return done(400, JSON.stringify({ error: "bad index" }));
        if (!instruction || !instruction.trim()) return done(400, JSON.stringify({ error: "instruction required" }));
        const config = providerConfig(provider);
        if (!config.apiKey) return done(400, JSON.stringify({ error: "no API key: set it in provider settings" }));
        const messages = [
          { role: "system", content: SYSTEMS[preset] || SYSTEMS.swiss },
          { role: "user", content: editPrompt(prompt || "(brief not kept)", slides, index, action || "replace", instruction.trim()) },
        ];
        let out = "";
        await streamChat(config, { model: config.model, stream: true, messages }, (d) => { out += d; });
        out = out.replace(/^\s*```[a-z]*\n?/, "").replace(/```\s*$/, "").trim();
        if (!/<section/i.test(out)) throw new Error("model did not return a <section>. First 300 chars: " + out.slice(0, 300));
        log(`edit ${action} slide ${index} → ${out.length} chars`);
        done(200, JSON.stringify({ section: out }));
      } catch (e) {
        done(502, JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/generate") {
    readBody(req, async (raw) => {
      let parsed;
      try { parsed = JSON.parse(raw || "{}"); }
      catch { return send(res, 400, JSON.stringify({ error: "bad json" })); }
      const { prompt, preset, provider } = parsed;
      if (!prompt || !prompt.trim()) return send(res, 400, JSON.stringify({ error: "prompt required" }));
      const config = providerConfig(provider);
      if (!config.apiKey) return send(res, 400, JSON.stringify({ error: "no API key: set it in provider settings" }));

      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
      const write = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch {} };
      const started = Date.now();
      let html = "";
      let lastLoggedChar = 0;
      try {
        log(`generate started: model=${config.model} preset=${preset || "swiss"} brief=${prompt.length} chars`);
        await streamChat(config, {
          model: config.model,
          stream: true,
          messages: [
            { role: "system", content: SYSTEMS[preset] || SYSTEMS.swiss },
            { role: "user", content: prompt.trim() },
          ],
        }, (delta, chars) => {
          html += delta;
          if (chars - lastLoggedChar > 2000) {
            lastLoggedChar = chars;
            log(`generate stream: ${chars} chars in ${Math.round((Date.now() - started) / 1000)}s`);
          }
          write({ phase: "progress", chars, seconds: Math.round((Date.now() - started) / 1000) });
        });
        html = html.replace(/^\s*```[a-z]*\n?/, "").replace(/```\s*$/, "").trim();
        if (!/<html/i.test(html)) throw new Error("model did not return HTML. First 300 chars: " + html.slice(0, 300));
        log(`${req.method} ${req.url} 200 in ${Date.now() - t0}ms (${html.length} chars)`);
        write({ phase: "done", html });
      } catch (e) {
        log(`${req.method} ${req.url} 502 in ${Date.now() - t0}ms — ${e.message.slice(0, 120)}`);
        write({ phase: "error", error: e.message });
      }
      res.end();
    });
    return;
  }

  const urlPath = req.url.split("?")[0];
  const file = path.join(STATIC_DIR, urlPath === "/" ? "index.html" : urlPath);
  if (file.startsWith(STATIC_DIR) && fs.existsSync(file)) {
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
  } else {
    done(404, "not found");
  }
});

server.requestTimeout = 0;
server.keepAliveTimeout = 300_000;
server.listen(PORT, () => log(`slidegen on http://localhost:${PORT} (idle watchdog ${IDLE_MS / 1000}s, total cap ${TOTAL_MS / 60000}m)`));
