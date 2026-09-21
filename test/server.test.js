const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

// Keep generated decks out of the repo's output/ and away from root-owned files.
const OUTPUT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "slidegen-out-"));
process.env.SLIDEGEN_OUTPUT_DIR = OUTPUT_TMP;

const {
  extractDocument, stripFences, parseModelList, providerConfig, textDeltaFromSseLine,
  tokens, overlap, editSlideClass, editOutline, editContext, editPrompt,
  auditDeckHtml, deckRuleIssues, saveDeck, createQueue, server,
} = require("../server.js");
const { geometryIssues, exportPdf, closeChrome } = require("../audit.js");
const { SYSTEMS, EDIT_SYSTEM } = require("../design/systems.js");

let base;
before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await closeChrome();
  fs.rmSync(OUTPUT_TMP, { recursive: true, force: true });
});

// Start a throwaway OpenAI-compatible endpoint that streams `content` as one SSE chunk.
async function startProvider(content) {
  const provider = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((resolve) => provider.listen(0, resolve));
  return { provider, baseUrl: `http://127.0.0.1:${provider.address().port}/v1` };
}

async function generate(prompt, provider) {
  const created = await fetch(`${base}/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, preset: "swiss", provider: { baseUrl: provider.baseUrl, apiKey: "test" } }),
  });
  assert.equal(created.status, 200);
  const { id } = await created.json();
  let status;
  for (let i = 0; i < 200; i++) {
    status = await (await fetch(`${base}/generate/${id}`)).json();
    if (status.phase === "done" || status.phase === "error") break;
    await flush();
  }
  return status;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ─── extractDocument / stripFences ──────────────────────────────────
test("extractDocument drops prose before <!DOCTYPE> and after </html>", () => {
  const raw = "Here is your deck.\n```html\n<!DOCTYPE html>\n<html><body><section class=\"slide\">hi</section></body></html>\nThanks for watching.";
  assert.equal(extractDocument(raw), '<!DOCTYPE html>\n<html><body><section class="slide">hi</section></body></html>');
});

test("extractDocument accepts <html> without a doctype", () => {
  assert.equal(extractDocument('intro <html lang="en"><body>x</body></html> tail'), '<html lang="en"><body>x</body></html>');
});

test("extractDocument cuts at </body> when </html> is missing", () => {
  assert.equal(extractDocument("<!DOCTYPE html><html><body>x</body>trailing prose"), "<!DOCTYPE html><html><body>x</body>");
});

test("extractDocument returns null when there is no document", () => {
  assert.equal(extractDocument("<style>x</style><section class=\"slide\">hi</section>"), null);
  assert.equal(extractDocument("just some prose"), null);
});

test("stripFences extracts full documents and de-fences slide fragments", () => {
  assert.equal(stripFences("prose\n```html\n<!DOCTYPE html><html><body></body></html>\n"), "<!DOCTYPE html><html><body></body></html>");
  assert.equal(stripFences("```html\n<section class=\"slide\">hi</section>\n```"), '<section class="slide">hi</section>');
  assert.equal(stripFences('<section class="slide">hi</section>'), '<section class="slide">hi</section>');
});

// ─── provider / SSE parsing ─────────────────────────────────────────
test("parseModelList handles the shapes providers return", () => {
  assert.deepEqual(parseModelList({ data: ["gpt-4", "o3"] }), ["gpt-4", "o3"]);
  assert.deepEqual(parseModelList({ models: [{ id: "a" }, { name: "b" }, { model: "c" }] }), ["a", "b", "c"]);
  assert.deepEqual(parseModelList(["x", "y"]), ["x", "y"]);
  assert.deepEqual(parseModelList({ data: "nope" }), []);
  assert.deepEqual(parseModelList({}), []);
});

test("textDeltaFromSseLine extracts content, ignores pings, [DONE] and bad JSON", () => {
  assert.equal(textDeltaFromSseLine('data: {"choices":[{"delta":{"content":"hello"}}]}'), "hello");
  assert.equal(textDeltaFromSseLine("data: [DONE]"), "");
  assert.equal(textDeltaFromSseLine(": keepalive"), "");
  assert.equal(textDeltaFromSseLine("data: not json"), "");
  assert.equal(textDeltaFromSseLine('data: {"choices":[{"delta":{}}]}'), "");
});

test("providerConfig strips trailing slashes, merges headers, and uses env fallbacks", () => {
  const keys = ["SLIDEGEN_BASE_URL", "SLIDEGEN_MODEL", "SLIDEGEN_API_KEY"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  keys.forEach((k) => delete process.env[k]);
  try {
    const config = providerConfig({ baseUrl: "https://x.test/v1///", apiKey: "k", model: "m", headers: { "X-A": "1" } });
    assert.equal(config.baseUrl, "https://x.test/v1");
    assert.equal(config.apiKey, "k");
    assert.equal(config.model, "m");
    assert.equal(config.headers["User-Agent"], "slidegen/0.1");
    assert.equal(config.headers["X-A"], "1");
    // Non-object headers must not leak into the request headers.
    assert.deepEqual(Object.keys(providerConfig({ headers: ["nope"] }).headers), ["User-Agent"]);
    process.env.SLIDEGEN_MODEL = "envmodel";
    assert.equal(providerConfig({}).model, "envmodel");
  } finally {
    keys.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
  }
});

// ─── fidelity helpers ───────────────────────────────────────────────
test("tokens drops markup/stopwords, overlap measures shared fraction", () => {
  const a = tokens("<style>ignored</style><h1>The water table rises</h1>");
  assert.ok(a.has("water") && a.has("table") && a.has("rises"));
  assert.ok(!a.has("the")); // stopword
  const b = tokens("water table rises");
  assert.equal(overlap(a, b), 1);
  assert.equal(overlap(tokens("alpha beta"), tokens("gamma delta")), 0);
  assert.equal(overlap(new Set(), b), 0);
});

// ─── edit prompt builders ───────────────────────────────────────────
test("editSlideClass keeps the target slot on replace, next free class on insert", () => {
  assert.equal(editSlideClass("replace", 1, 5), "s2");
  assert.equal(editSlideClass("insert_after", 1, 5), "s6");
  assert.equal(editSlideClass("insert_before", 0, 3), "s4");
});

test("editOutline marks the target and its neighbour", () => {
  const slides = ["<h1>Alpha</h1>", "<h1>Beta</h1>", "<h1>Gamma</h1>"];
  const outline = editOutline(slides, 1, "<h1>Beta rewritten</h1>").split("\n");
  assert.match(outline[1], /→ TARGET\[2\] Beta rewritten/);
  assert.match(outline[0], /↖\[1\] Alpha/);
  assert.doesNotMatch(outline[2], /TARGET|↖/);
});

test("editContext snapshots the target for replace, neighbours for insert", () => {
  const slides = ["<h1>A</h1>", "<h1>B</h1>", "<h1>C</h1>"];
  const replace = editContext(slides, 1, "replace");
  assert.match(replace.target, /target slide \(slide 2 of 3\)/);
  assert.match(replace.context, /previous slide \(slide 1 of 3\)/);

  const insert = editContext(slides, 1, "insert_before");
  assert.match(insert.target, /slide after insertion point \(slide 2 of 3\)/);
  assert.match(insert.context, /slide before insertion point \(slide 2 of 3\)/);

  const first = editContext(slides, 0, "replace");
  assert.equal(first.context, "");
  assert.match(first.target, /target slide \(slide 1 of 3\)/);
});

test("editPrompt embeds brief, instruction, target and output rules", () => {
  const slides = ["<h1>A</h1>", "<h1>B</h1>"];
  const prompt = editPrompt("My brief", slides, 1, "replace", "make it denser", ".s2{color:red}");
  assert.match(prompt, /My brief/);
  assert.match(prompt, /make it denser/);
  assert.match(prompt, /class "s2"/);
  assert.match(prompt, /\.s2\{color:red\}/);
  assert.match(prompt, /Output rules:/);
});

// ─── audit / persistence ────────────────────────────────────────────
test("auditDeckHtml resolves to an array of issues", async () => {
  assert.deepEqual(await auditDeckHtml("no slides here"), []);
  const issues = await auditDeckHtml('<html><body><section class="slide">hi</section></body></html>');
  assert.ok(Array.isArray(issues));
});

test("saveDeck writes deck.html under a timestamped directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slidegen-"));
  try {
    const file = saveDeck("<html>x</html>", root, new Date("2026-01-02T03:04:05.678Z"));
    assert.equal(path.basename(file), "deck.html");
    assert.equal(path.basename(path.dirname(file)), "2026-01-02T03-04-05");
    assert.equal(fs.readFileSync(file, "utf8"), "<html>x</html>");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── queue ──────────────────────────────────────────────────────────
test("createQueue runs jobs one at a time and exposes progress snapshots", async () => {
  const ran = [];
  let release;
  const queue = createQueue((job) => new Promise((resolve) => {
    ran.push(job.id);
    job.phase = "running";
    release = () => { job.phase = "done"; job.html = `<html>${job.prompt}</html>`; job.seconds = 1; resolve(); };
  }));

  const first = queue.enqueue({ model: "m" }, "one", "swiss");
  await flush(); // first is now running
  const second = queue.enqueue({ model: "m" }, "two", "swiss");

  assert.equal(queue.view(first).phase, "running");
  assert.equal(queue.view(second).phase, "queued");
  assert.equal(queue.view(second).queuePosition, 1);
  assert.equal(queue.view(first).config, undefined, "snapshot never leaks credentials");

  release(); // finish first -> second starts
  await flush();
  assert.equal(queue.view(first).phase, "done");
  assert.equal(queue.view(first).html, "<html>one</html>");
  assert.equal(queue.view(second).phase, "running");
  assert.deepEqual(ran, [first.id, second.id]);
});

test("createQueue cancel removes a queued job without running it", async () => {
  const started = [];
  let release;
  const queue = createQueue((job) => new Promise((resolve) => {
    started.push(job.id);
    release = () => { job.phase = "done"; resolve(); };
  }));

  const running = queue.enqueue({ model: "m" }, "one", "swiss");
  await flush();
  const waiting = queue.enqueue({ model: "m" }, "two", "swiss");

  const cancelled = queue.cancel(waiting.id);
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(queue.view(waiting).phase, "cancelled");

  release();
  await flush();
  assert.deepEqual(started, [running.id], "cancelled job must never start");
});

test("createQueue cancel aborts a running job via its controller", async () => {
  const queue = createQueue((job) => new Promise(() => { job.abort = new AbortController(); }));
  const job = queue.enqueue({ model: "m" }, "one", "swiss");
  await flush();
  queue.cancel(job.id);
  assert.equal(job.abort.signal.aborted, true);
});

test("createQueue prune keeps memory bounded", async () => {
  const queue = createQueue((job) => { job.phase = "done"; }, 2);
  for (let i = 0; i < 5; i++) { queue.enqueue({ model: "m" }, `p${i}`, "swiss"); await flush(); }
  assert.ok(queue.jobs.size <= 3, `expected <= 3 jobs, got ${queue.jobs.size}`);
});

// ─── geometry rules (the 1280x720 house rules) ──────────────────────
const BOX_OK = { slide: 1, top: 64, bottom: 624, left: 76, right: 1204 };

test("geometryIssues passes a slide inside the safe area", () => {
  assert.deepEqual(geometryIssues([BOX_OK]), []);
});

test("geometryIssues flags overflow past the 1280x720 stage", () => {
  assert.match(geometryIssues([{ ...BOX_OK, bottom: 721 }])[0].msg, /overflows: content reaches y=721px/);
  assert.match(geometryIssues([{ ...BOX_OK, right: 1281 }])[0].msg, /overflows right/);
});

test("geometryIssues flags tight margins within the allowed tolerance", () => {
  // bottom must be <= 632 (720-96 plus the +8 slack); 624 sits right at the margin.
  assert.deepEqual(geometryIssues([{ ...BOX_OK, bottom: 624 }]), []);
  assert.match(geometryIssues([{ ...BOX_OK, bottom: 640 }])[0].msg, /tight bottom/);
  assert.match(geometryIssues([{ ...BOX_OK, top: 30 }])[0].msg, /tight top/);
  assert.match(geometryIssues([{ ...BOX_OK, right: 1220 }])[0].msg, /tight right/);
  assert.match(geometryIssues([{ ...BOX_OK, left: 40 }])[0].msg, /tight left/);
});

test("geometryIssues flags content outside the stage", () => {
  assert.match(geometryIssues([{ ...BOX_OK, top: -1 }])[0].msg, /content above slide top/);
  assert.match(geometryIssues([{ ...BOX_OK, left: -1 }])[0].msg, /content left of slide edge/);
});

test("geometryIssues reports every offending slide", () => {
  const issues = geometryIssues([BOX_OK, { ...BOX_OK, slide: 2, bottom: 800 }]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].slide, 2);
});

// ─── structural rules ───────────────────────────────────────────────
test("deckRuleIssues accepts a clean, self-contained deck", () => {
  const deck = '<!DOCTYPE html><html><head><style>.slide{width:1280px;height:720px}</style></head><body><section class="slide"><svg></svg></section></body></html>';
  assert.deepEqual(deckRuleIssues(deck), []);
});

test("deckRuleIssues flags missing document/style/slide and external resources", () => {
  assert.match(deckRuleIssues("<section class=slide>x</section>").map((i) => i.msg).join(";"), /not a complete HTML document/);
  assert.match(deckRuleIssues("<html><body><section class=slide>x</section></body></html>").map((i) => i.msg).join(";"), /no <style> block/);
  assert.match(deckRuleIssues("<html><body></body></html>").map((i) => i.msg).join(";"), /no <section class="slide">/);
  assert.match(deckRuleIssues('<html><body><section class="slide"><img src="http://x/y.png"></section></body></html>').map((i) => i.msg).join(";"), /external <img/);
  assert.match(deckRuleIssues('<html><body><section class="slide"><script src="https://x/y.js"></script></section></body></html>').map((i) => i.msg).join(";"), /external <script/);
});

// ─── design-system prompt invariants ────────────────────────────────
test("every preset prompt encodes the fixed 16:9 stage rules", () => {
  for (const [name, prompt] of Object.entries(SYSTEMS)) {
    assert.match(prompt, /1280×720|1280x720/, `${name} preset must state the 1280x720 stage`);
    assert.match(prompt, /16:9/, `${name} preset must state the 16:9 ratio`);
    assert.match(prompt, /scale\(/, `${name} preset must specify the single scale transform`);
  }
  assert.match(EDIT_SYSTEM, /1280x720|1280×720/);
  assert.ok(EDIT_SYSTEM.trim().length > 0);
});

// ─── HTTP integration ───────────────────────────────────────────────
test("HTTP endpoints: static, 404, validation, and queue lifecycle", async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/does-not-exist`)).status, 404);
  assert.equal((await fetch(`${base}/generate/unknown`)).status, 404);

  const noKey = await fetch(`${base}/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "hi", provider: { apiKey: "" } }),
  });
  assert.equal(noKey.status, 400);

  const provider = await startProvider('<!DOCTYPE html><html><head><style>.slide{}</style></head><body><section class="slide">hi</section></body></html>');
  const status = await generate("one slide", provider);
  provider.provider.close();

  assert.equal(status.phase, "done", `job failed: ${status.error || JSON.stringify(status)}`);
  assert.match(status.html, /<section class="slide">hi<\/section>/);
  assert.deepEqual(status.issues, [], "a clean deck must report no rule violations");
});

test("generation normalizes misbehaving model output to the document rules", async () => {
  // Prose before the doctype, a ```html fence, and explanation after </html>.
  const raw = 'Sure, here is the deck.\n```html\n<!DOCTYPE html><html><head><style>.slide{}</style></head><body><section class="slide">hi</section></body></html>\n```\nThat is all.';
  const provider = await startProvider(raw);
  const status = await generate("one slide", provider);
  provider.provider.close();

  assert.equal(status.phase, "done");
  assert.ok(status.html.startsWith("<!DOCTYPE html>"), "preamble must be stripped");
  assert.ok(status.html.trimEnd().endsWith("</html>"), "trailing prose must be stripped");
  assert.doesNotMatch(status.html, /Sure, here|That is all/);
  assert.deepEqual(status.issues, [], "normalized deck must satisfy the rules");
});

test("generation surfaces rule violations instead of silently accepting them", async () => {
  const provider = await startProvider('<html><head><style>.slide{}</style></head><body><section class="slide"><img src="http://evil.test/x.png"></section></body></html>');
  const status = await generate("one slide", provider);
  provider.provider.close();

  assert.equal(status.phase, "done");
  assert.ok(status.issues.some((i) => /external <img/.test(i.msg)), `expected an external-image warning, got ${JSON.stringify(status.issues)}`);
});

// ─── PDF pagination rule (needs a browser) ──────────────────────────
test("exportPdf produces exactly one 1280x720 page per slide", async (t) => {
  const deck = "<!DOCTYPE html><html><head><style>*{box-sizing:border-box}.slide{display:block;width:1280px;height:720px;page-break-after:always}</style></head><body>" +
    [1, 2, 3].map((n) => `<section class="slide">Slide ${n}</section>`).join("") + "</body></html>";
  const result = await exportPdf(deck);
  if (result.skipped) return t.skip(`no headless Chromium: ${result.error}`);
  const pdf = result.pdf.toString("latin1");
  assert.equal((pdf.match(/\/Type\s*\/Page[^s]/g) || []).length, 3);
  // 1280x720 CSS px at 96dpi == 960x540 PDF points (PDF uses 72dpi).
  assert.match(pdf, /\/MediaBox\s*\[\s*0\s+0\s+960\s+540\s*\]/);
});
