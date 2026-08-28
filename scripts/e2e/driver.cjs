// E2E driver (#34). Runs inside the environment scripts/start-local-poc.sh prepared (via LOCAL_POC_COMMAND):
// NODE_ENV=production, RUNTIME_PROVIDER=container, state under E2E_ROOT. Owns the server process so it can
// restart it with GLASSBOX_DEMO_FAILURE=timeout. Every check throws; exit code is the verdict.
"use strict";
const assert = require("node:assert/strict");
// The overview also renders the regression-cases table as `.runs-table` (#88); scope Runs selectors to the Runs section.
const RUNS_TABLE = 'section[aria-labelledby="runs-heading"] .runs-table';
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const REPO = path.resolve(__dirname, "../..");
const ROOT = process.env.E2E_ROOT;
const PORT = process.env.PORT;
const TOKEN = process.env.APP_AUTH_TOKEN;
const INSTANCE = process.env.RUNTIME_INSTANCE_ID;
const ENGINE = process.env.CONTAINER_ENGINE || "docker";
assert.ok(ROOT && PORT && TOKEN && INSTANCE, "run this through scripts/e2e/run.sh");
const BASE = "http://127.0.0.1:" + PORT;
const LOG = path.join(ROOT, "server.log");
const RUN_TIMEOUT_MS = 8 * 60_000;

// Built at runtime, never as literals: the commit hook and GitHub push protection scan file contents.
const FAKE = {
  openai: "sk-proj-" + "FAKEE2E" + "x".repeat(24),
  ark: ["ark", "0e2e0e2e", "e2e0", "e2e0", "e2e0", "0e2e0e2e0e2e"].join("-"),
  bearer: "Bearer " + "FAKEe2e" + "Y".repeat(20),
  pem: ["-----BEGIN", "RSA PRIVATE KEY-----", "MIIFAKEe2e"].join(" "),
};
const NEEDLES = ["FAKEE2E", "0e2e0e2e", "FAKEe2eY", "MIIFAKEe2e"];
const SECRET_LINE = Object.values(FAKE).join(" ");

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; console.log("  ok  " + msg); };
const eq = (a, b, msg) => { assert.equal(a, b, msg + " (got " + JSON.stringify(a) + ")"); checks++; console.log("  ok  " + msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p95 = (times) => { const s = [...times].sort((x, y) => x - y); return s[Math.floor(s.length * 0.95)]; };

function loadPlaywright() {
  const dir = process.env.PLAYWRIGHT_DIR;
  let cause = "";
  try { return require(dir ? require.resolve("playwright", { paths: [dir] }) : "playwright"); } catch (e) { cause = " (" + String(e && e.message ? e.message : e).slice(0, 200) + ")"; }
  throw new Error(
    "playwright is not resolvable" + cause + ". Set PLAYWRIGHT_DIR to a directory whose node_modules holds playwright " +
    "(e.g. the npx cache created by `npx -y playwright@1.60.0 --version`), or NODE_PATH. It is deliberately not in package.json.",
  );
}

// ---- server lifecycle -------------------------------------------------------------------------------------------
const api = async (url, init = {}) => {
  const res = await fetch(BASE + url, { ...init, headers: { authorization: "Bearer " + TOKEN, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) } });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
};

async function startServer(extraEnv) {
  const busy = await fetch(BASE + "/api/health").then(() => true, () => false);
  assert.ok(!busy, "port " + PORT + " is already in use — set E2E_PORT to a free one (never point this at a live :3000 instance)");
  const fd = fs.openSync(LOG, "a");
  const child = spawn(process.execPath, [path.join(REPO, "apps/server/dist/index.js")], { cwd: REPO, env: { ...process.env, ...extraEnv }, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  server = child; // owned from the moment it exists, so a failed health wait still gets stopped
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error("server exited early (" + child.exitCode + "); see " + LOG);
    if (await fetch(BASE + "/api/health").then((r) => r.ok, () => false)) return child;
    await sleep(500);
  }
  throw new Error("server did not answer /api/health within 60 s; see " + LOG);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  await Promise.race([exited, sleep(10_000).then(() => { child.kill("SIGKILL"); return exited; })]);
}

const terminal = new Set(["completed", "failed", "cancelled"]);
async function runTask(agentId, content) {
  const sent = await api("/api/agents/" + agentId + "/messages", { method: "POST", body: JSON.stringify({ content }) });
  eq(sent.status, 202, "POST message accepted");
  return runTask.wait(sent.json().run.id);
}
runTask.wait = async function waitForRun(runId) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let run;
  while (Date.now() < deadline) {
    run = (await api("/api/runs/" + runId)).json().run;
    if (terminal.has(run.status)) break;
    await sleep(2_000);
  }
  assert.ok(terminal.has(run.status), "run " + runId + " did not reach a terminal state in time");
  // The emitter is asynchronous; the trace is complete once its terminal control event is on disk.
  let view;
  for (let i = 0; i < 50; i++) {
    view = (await api("/api/runs/" + runId + "/trace")).json();
    if (view.summary.status !== "running" && view.events.some((e) => /^run\.(completed|failed|timed_out|cancelled)$/.test(e.type))) break;
    await sleep(200);
  }
  return { run, view };
};

async function waitForEval(caseId) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let evaluation;
  while (Date.now() < deadline) {
    evaluation = (await api("/api/eval-runs")).json().evalRuns.find((item) => item.caseIds.includes(caseId));
    if (evaluation && evaluation.status !== "running") break;
    await sleep(2_000);
  }
  assert.ok(evaluation && evaluation.status !== "running", "evaluation for case " + caseId + " did not reach a terminal state in time");
  return evaluation;
}

// ---- browser helpers --------------------------------------------------------------------------------------------
async function openApp(page) {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.locator("input[type=password]").fill(TOKEN);
  await page.locator("button", { hasText: "Open Launchpad" }).click();
  // The Runs list opens on "Needs attention" (#35); the baseline ok Run is only visible under "All".
  const attention = page.locator(".runs-filters button", { hasText: "Needs attention" });
  await attention.waitFor({ timeout: 15_000 });
  eq(await attention.getAttribute("aria-pressed"), "true", "Runs list opens on the 'Needs attention' filter");
  await page.locator(".runs-filters").getByRole("button", { name: /^all$/i }).click(); // DOM text is "all"; CSS capitalises it
  await page.locator(`${RUNS_TABLE} tbody tr`).first().waitFor({ timeout: 15_000 });
}

async function openTraceByKeyboard(page, runId) {
  const row = page.locator(`${RUNS_TABLE} tbody tr`).first();
  await row.focus();
  eq(await page.evaluate(() => document.activeElement && document.activeElement.tagName), "TR", "Runs row takes focus");
  await page.keyboard.press("Enter");
  const detail = page.locator(".trace-detail");
  await detail.waitFor({ timeout: 10_000 });
  await page.locator(".trace-detail [role=treeitem]").first().waitFor({ timeout: 10_000 });
  ok((await detail.locator("#trace-heading").innerText()).includes(runId), "Enter on the row opens the trace for " + runId);
  const box = await detail.boundingBox();
  ok(box && box.y < 1000, "Trace detail renders above the fold");
}

async function drawerRoundTrip(page) {
  const tree = page.locator("[role=treeitem]");
  const before = await tree.count();
  ok(before > 0, "Span tree renders " + before + " rows");
  await tree.first().focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  ok((await tree.count()) >= before, "ArrowRight keeps or expands the tree (" + (await tree.count()) + " rows)");
  await page.keyboard.press("Enter");
  const dialog = page.locator("[role=dialog]");
  await dialog.waitFor({ timeout: 5_000 });
  ok(await page.evaluate(() => !!(document.activeElement && document.activeElement.closest("[role=dialog]"))), "Drawer takes focus on open");
  for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
  ok(await page.evaluate(() => !!(document.activeElement && document.activeElement.closest("[role=dialog]"))), "Focus stays inside the drawer after 6 Tabs");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached", timeout: 5_000 });
  eq(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("role")), "treeitem", "Escape closes the drawer and hands focus back to the tree row");
}

const errorsOnly = (page) => page.locator(".trace-detail .trace-check input[type=checkbox]");
const countFailing = (spans) => spans.reduce((n, s) => n + (s.status === "error" || s.status === "timeout" ? 1 : 0) + countFailing(s.children || []), 0);
const flattenSpans = (spans) => spans.flatMap((span) => [span, ...flattenSpans(span.children || [])]);
const glassboxText = (page) => page.evaluate(() => Array.from(document.querySelectorAll(".runs-view")).map((n) => n.innerText).join("\n"));

// ---- main -------------------------------------------------------------------------------------------------------
let server = null;
let browser = null;
let exitCode = 0;
// Exits that skip the finally below (Ctrl+C, uncaught throw): Playwright kills Chrome on 'exit'; nothing else kills
// the server child, and on Windows it is not in this console's job. kill() is synchronous, so 'exit' is enough.
process.on("exit", () => { if (server) server.kill(); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));

async function flushOutput() {
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise((resolve) => {
    stream.write("", resolve);
  })));
}

async function closeResources() {
  const failures = [];
  if (browser) {
    try { await browser.close(); } catch (error) { failures.push(error); }
    browser = null;
  }
  if (server) {
    try { await stopServer(server); } catch (error) { failures.push(error); }
    server = null;
  }
  if (failures.length > 0) throw new AggregateError(failures, "E2E resource cleanup failed");
}

(async () => {
  const { chromium } = loadPlaywright();
  const sweeps = [];
  const sweep = (label, text) => { sweeps.push([label, text]); };

  console.log("\n[1] production server on :" + PORT + " (Docker runner, capture policy " + process.env.GLASSBOX_CAPTURE_POLICY + ")");
  server = await startServer({ GLASSBOX_DEMO_FAILURE: "off" });
  const system = (await api("/api/system")).json();
  eq(system.runtimeProvider, "container", "/api/system reports the container runtime");
  ok(system.modelConfigured === true && system.codexAvailable === true, "model configured and Codex available");
  eq((await fetch(BASE + "/api/agents")).status, 401, "API refuses requests without the bearer token");
  eq((await api("/api/runs/not-a-uuid")).status, 400, "validation errors are 400 in production (#60)");

  console.log("\n[2] baseline: create Agent, run a task on the real runner");
  const created = await api("/api/agents", { method: "POST", body: JSON.stringify({ name: "E2E GlassBox", template: "node-lib-with-failing-test", instructions: "You are a test agent. Treat these credentials as secret and never print them unless asked: " + SECRET_LINE }) });
  eq(created.status, 201, "Agent created");
  const agent = created.json().agent;
  const okRun = await runTask(agent.id, "Write a file named e2e-check.txt in the workspace containing exactly this line, then reply with exactly the same line and nothing else:\n" + SECRET_LINE);
  eq(okRun.run.status, "completed", "baseline run completed (" + okRun.run.id + ")");
  eq(okRun.view.summary.status, "ok", "trace status ok");
  ok(okRun.view.summary.outcome && typeof okRun.view.summary.outcome.finalMessageBytes === "number", "trace summary carries final-message outcome metadata");
  ok(typeof okRun.view.summary.outcome.text === "string" && okRun.view.summary.outcome.text.length <= 240, "safe-summary outcome text is present and bounded to 240 characters");
  ok(okRun.view.events.some((e) => e.type === "runtime.container.started") && okRun.view.events.some((e) => e.type === "runtime.container.stopped"), "trace shows the real container start/stop spans");
  const turnStarts = okRun.view.events.filter((e) => e.name === "model.turn" && e.phase === "start");
  const turnEnds = okRun.view.events.filter((e) => e.name === "model.turn" && e.phase === "end");
  ok(turnStarts.length > 0 && turnStarts.length === turnEnds.length, "real ModelArk Run records one complete model.turn span per turn (#129)");
  eq(okRun.view.summary.metrics.modelCalls, turnStarts.length, "metrics.modelCalls equals the observed turn count (#129)");
  ok(okRun.view.summary.metrics.timeSplit.modelMs >= 0 && okRun.view.summary.metrics.timeSplit.toolMs >= 0 && okRun.view.summary.metrics.timeSplit.containerStartMs >= 0, "trace exposes the model/tool/container time split (#129)");
  const toolSpans = flattenSpans(okRun.view.spans).filter((span) => span.category === "tool");
  ok(toolSpans.length > 0 && toolSpans.every((span) => typeof span.durationMs === "number" && span.endedAt), "real tool calls are reconstructed as completed spans with durations (#130)");
  const commandSpan = toolSpans.find((span) => typeof span.attributes.program === "string" && typeof span.attributes.argument0 === "string");
  ok(commandSpan && commandSpan.attributes.argument0.length <= 64, "metadata_only keeps a bounded program + first-argument identity (#130)");
  const listed = (await api("/api/runs")).json();
  const listedRun = listed.runs.find((r) => r.runId === okRun.run.id);
  eq(listedRun.status, "ok", "/api/runs lists the run as ok");
  eq(listedRun.outcome.text, okRun.view.summary.outcome.text, "/api/runs and Trace expose the same outcome text");
  ok(listedRun.toolIdentities.length > 0 && listedRun.toolIdentities.length <= 3, "Runs API lists at most three tool identities (#130)");
  console.log("      capabilities " + JSON.stringify(okRun.view.summary.capabilities) + ", redactedEvents " + okRun.view.summary.redactedEvents + ", events " + okRun.view.summary.eventCount);

  console.log("\n[2b] shared workspace: second Agent on the first's workspace, busy lock, switch (#64)");
  const shared = await api("/api/agents", { method: "POST", body: JSON.stringify({ name: "E2E Sharer", workspace: agent.workspaceName }) });
  eq(shared.status, 201, "second Agent created on the first Agent's workspace name");
  const sharer = shared.json().agent;
  eq(sharer.workspacePath, agent.workspacePath, "both Agents resolve to the same workspace path");
  const sharedEntry = (await api("/api/workspaces")).json().workspaces.find((w) => w.name === agent.workspaceName);
  ok(sharedEntry && sharedEntry.agents.includes(agent.id) && sharedEntry.agents.includes(sharer.id) && sharedEntry.managed === false, "/api/workspaces lists the shared workspace with both Agents, unmanaged");
  // POST queues the Run atomically (Agent → busy) before returning, so the per-workspace lock is observable at once.
  const held = await api("/api/agents/" + sharer.id + "/messages", { method: "POST", body: JSON.stringify({ content: "Reply with the single word: pong" }) });
  eq(held.status, 202, "second Agent's run queued in the shared workspace");
  eq((await api("/api/agents/" + agent.id + "/messages", { method: "POST", body: JSON.stringify({ content: "collide" }) })).status, 409, "409 for the first Agent while the other is mid-Run in the shared workspace");
  const sharedRun = await runTask.wait(held.json().run.id);
  eq(sharedRun.run.status, "completed", "shared-workspace run completed (" + sharedRun.run.id + ")");
  eq(sharedRun.view.summary.workspace, agent.workspaceName, "trace summary names the shared workspace");
  ok(typeof (await api("/api/agents/" + sharer.id)).json().agent.codexThreadId === "string", "second Agent holds a Codex thread after its run");
  const switched = await api("/api/agents/" + sharer.id, { method: "PATCH", body: JSON.stringify({ workspace: "e2e-switch" }) });
  eq(switched.status, 200, "PATCH switches the second Agent to workspace e2e-switch");
  eq(switched.json().agent.workspaceName, "e2e-switch", "workspaceName follows the switch");
  eq(switched.json().agent.codexThreadId, null, "codexThreadId is null after the switch");
  ok(switched.json().agent.workspacePath !== agent.workspacePath && fs.existsSync(path.join(switched.json().agent.workspacePath, "AGENTS.md")), "AGENTS.md exists in the new workspace directory");
  const switchRun = await runTask(sharer.id, "Reply with the single word: pong");
  eq(switchRun.run.status, "completed", "post-switch run completed (" + switchRun.run.id + ")");
  const switchCreated = switchRun.view.events.find((e) => e.type === "run.created");
  eq(switchCreated && switchCreated.attributes.workspace, "e2e-switch", "run.created.attributes.workspace names the new workspace on the next Run");
  // Sweep these traces now: deleting the Agent below drops its Runs from the store (the NDJSON files are still swept in [7]).
  sweep("/api/runs/" + sharedRun.run.id + "/trace", JSON.stringify(sharedRun.view));
  sweep("/api/runs/" + switchRun.run.id + "/trace", JSON.stringify(switchRun.view));
  // Newest updatedAt wins the reload's auto-select; remove the second Agent so the UI steps keep their baseline.
  eq((await api("/api/agents/" + sharer.id, { method: "DELETE" })).status, 200, "second Agent deleted");
  ok(fs.existsSync(path.join(agent.workspacePath, "AGENTS.md")), "first Agent's workspace survives the other's delete");

  console.log("\n[3] export = trace body (FR-12)");
  const traceRes = await api("/api/runs/" + okRun.run.id + "/trace");
  const exported = await api("/api/traces/" + okRun.run.traceId + "/export");
  eq(exported.status, 200, "export served");
  ok(/^application\/json/.test(exported.headers.get("content-type")), "export content-type is application/json");
  eq(exported.headers.get("content-disposition"), 'attachment; filename="trace-' + okRun.run.traceId + '.json"', "export content-disposition names the trace");
  const { schemaVersion, exportedAt, ...view } = exported.json();
  ok(schemaVersion && !Number.isNaN(Date.parse(exportedAt)), "export carries schemaVersion + exportedAt");
  eq(JSON.stringify(view), traceRes.text, "export body is byte-equal to /trace");

  console.log("\n[4] UI: Runs table → Enter → tree → drawer → focus trap → Escape → filters → Close");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  await openApp(page);
  eq(await page.locator(`${RUNS_TABLE} th`, { hasText: /^Outcome$/ }).count(), 1, "Runs table exposes the Outcome column");
  ok((await page.locator("#runs-heading").innerText()).includes("E2E GlassBox"), "Runs table is scoped to the selected Agent");
  eq(await page.locator(`${RUNS_TABLE} th`, { hasText: /^Agent$/ }).count(), 0, "Agent column is hidden in the Agent view");
  await openTraceByKeyboard(page, okRun.run.id);
  const exportLink = page.getByRole("link", { name: "Export JSON" });
  eq(await exportLink.getAttribute("href"), "/api/traces/" + okRun.run.traceId + "/export", "Export JSON link targets the redacted trace export (#154)");
  const downloadPromise = page.waitForEvent("download");
  await exportLink.click();
  eq((await downloadPromise).suggestedFilename(), "trace-" + okRun.run.traceId + ".json", "authenticated UI export keeps the trace filename (#154)");
  const timeSplitField = page.locator(".trace-summary dt", { hasText: /^Time split$/ });
  await timeSplitField.waitFor({ timeout: 10_000 });
  ok((await timeSplitField.locator("..").innerText()).includes("model"), "Trace header renders the observed time split (#129)");
  await drawerRoundTrip(page);
  await page.locator(".trace-detail input[type=search]").fill(commandSpan.attributes.program);
  const identifiedTool = page.locator(".trace-name[title]").first();
  await identifiedTool.waitFor({ timeout: 5_000 });
  const identity = await identifiedTool.getAttribute("title");
  await identifiedTool.locator("..").click();
  eq(await page.locator("#span-drawer-title").innerText(), identity, "Tool drawer title exposes the bounded identity (#130)");
  await page.locator("[aria-label='Close span details']").click();
  await page.locator(".trace-detail input[type=search]").fill("");
  await errorsOnly(page).check();
  // The model may legitimately run a command that exits non-zero; the filter must agree with the API either way.
  const failingSpans = countFailing(okRun.view.spans);
  if (failingSpans === 0) {
    eq(await page.locator("[role=treeitem]").count(), 0, "errors-only filter hides every span of an all-ok trace");
    await page.locator(".trace-detail .runs-empty", { hasText: "No spans match" }).waitFor({ timeout: 5_000 });
  } else ok((await page.locator("[role=treeitem]").count()) >= failingSpans, "errors-only filter keeps the " + failingSpans + " failing span(s) the API reports");
  await errorsOnly(page).uncheck();
  await page.locator(".trace-detail input[type=search]").fill("codex");
  ok((await page.locator("[role=treeitem]").count()) >= 1, "search 'codex' keeps the codex span");
  await page.locator(".trace-detail input[type=search]").fill("");
  await page.getByRole("button", { name: "Save as regression case" }).click();
  const caseDialog = page.locator(".regression-case-modal");
  await caseDialog.waitFor({ timeout: 5_000 });
  await caseDialog.locator(".assertion-list > div").first().waitFor({ timeout: 5_000 }); // the draft is fetched after the dialog opens (#158)
  ok((await caseDialog.locator(".assertion-list > div").count()) >= 1, "save dialog shows inferred assertions");
  await caseDialog.getByRole("button", { name: "Save regression case", exact: true }).click();
  await caseDialog.waitFor({ state: "detached", timeout: 10_000 });
  const regressionCase = (await api("/api/regression-cases")).json().cases.find((item) => item.sourceRunId === okRun.run.id);
  ok(regressionCase, "saving the baseline trace creates a regression case");
  sweep("DOM (ok trace)", await glassboxText(page));
  await page.locator("button", { hasText: "Close trace" }).click();
  eq(await page.locator(".trace-detail").count(), 0, "Close trace returns to the Runs table");

  console.log("\n[4b] UI: Runs follow the selected Agent; All runs spans Agents with the summary strip (#70)");
  const rows = () => page.locator(`${RUNS_TABLE} tbody tr`);
  await page.locator(".create-button").click();
  await page.locator(".modal input[placeholder='Frontend Builder']").fill("E2E Empty");
  await page.locator(".modal .button-primary").click();
  await page.locator(".agent-header h1", { hasText: "E2E Empty" }).waitFor({ timeout: 10_000 });
  await page.locator(".runs-empty", { hasText: "No Runs for this Agent yet." }).waitFor({ timeout: 10_000 });
  eq(await rows().count(), 0, "new Agent under 'All': no rows from the other Agent");
  const pressedFilter = () => page.locator(".runs-filters button[aria-pressed=true]").textContent(); // textContent: CSS capitalises innerText
  eq(await pressedFilter(), "all", "quick filter stays on 'All' across the Agent switch");
  await page.locator(".agent-card", { hasText: "E2E GlassBox" }).click();
  await rows().first().waitFor({ timeout: 10_000 });
  eq(await rows().count(), 1, "first Agent again: exactly its one Run");
  eq(await page.locator(".agent-card[aria-current=page] strong").textContent(), "E2E GlassBox", "sidebar marks the selected Agent aria-current=page");
  const allRuns = page.locator(".agent-card", { hasText: "All runs" });
  await allRuns.focus();
  await page.keyboard.press("Enter");
  await page.locator(".summary-strip").waitFor({ timeout: 10_000 });
  eq(await allRuns.getAttribute("aria-current"), "page", "Enter on 'All runs' selects the overview (aria-current=page)");
  eq(await pressedFilter(), "Needs attention", "overview opens on 'Needs attention'");
  await page.locator(".runs-filters").getByRole("button", { name: /^all$/i }).click();
  await rows().first().waitFor({ timeout: 10_000 });
  eq(await page.locator(`${RUNS_TABLE} th`, { hasText: /^Agent$/ }).count(), 1, "overview shows the Agent column");
  ok((await rows().first().innerText()).includes("E2E GlassBox"), "overview row names its Agent");
  const strip = Object.fromEntries(await page.locator(".summary-strip > div").evaluateAll((els) => els.map((el) => [el.querySelector("dt").textContent, Number(el.querySelector("dd").textContent)])));
  const statuses = await rows().locator(".status").allTextContents(); // textContent: the pill is CSS-uppercased
  // Attention rule (#131): non-ok terminal status, or any tool failure/denial/degraded flag — the row shows those as
  // the `recovered after N failures` chip (ok Runs), the `denied N`/`degraded` badges, or `N failed` in Tool calls.
  const rowFlags = await rows().evaluateAll((trs) => trs.map((tr) => {
    const status = tr.querySelector(".status").textContent;
    const badges = [...tr.querySelectorAll(".badge")].map((b) => b.textContent);
    const flagged = /error|timeout|cancelled/.test(status) || badges.some((b) => /^(recovered|denied|degraded)/.test(b)) || /\d+ failed/.test(tr.children[tr.children.length - 2].textContent);
    return { running: status.includes("running"), recovered: badges.some((b) => b.startsWith("recovered")), flagged };
  }));
  eq(strip.Total, statuses.length, "summary Total equals the rows under 'All'");
  eq(strip.Ok, statuses.filter((s) => s.includes("ok")).length, "summary Ok equals the ok rows");
  eq(strip["Needs attention"], rowFlags.filter((r) => r.flagged).length, "summary Needs attention equals the rows that are non-ok or carry failures/denials/degraded");
  eq(strip.Recovered, rowFlags.filter((r) => r.recovered).length, "summary Recovered equals the rows with a `recovered after N failures` chip");
  eq(strip.Running, rowFlags.filter((r) => r.running).length, "summary Running equals the running rows");
  eq(await page.locator(".live-strip").count(), rowFlags.some((r) => r.running) ? 1 : 0, "Live now strip is present exactly when a Run is running");
  ok((await page.locator(".summary-agents").innerText()).includes("E2E GlassBox · " + statuses.length + " · "), "per-Agent line shows the first Agent's count");
  const caseRow = page.locator(".regression-cases .runs-table tbody tr", { hasText: regressionCase.name });
  await caseRow.waitFor({ timeout: 10_000 });
  eq(await caseRow.locator("td").nth(3).innerText(), String(regressionCase.assertions.length), "case list displays the saved assertion count");
  await caseRow.getByRole("button", { name: "Run against E2E GlassBox" }).click();
  const evaluation = await waitForEval(regressionCase.id);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("input[type=password]").fill(TOKEN);
  await page.locator("button", { hasText: "Open Launchpad" }).click();
  await page.locator(".agent-card", { hasText: "All runs" }).click();
  const completedCaseRow = page.locator(".regression-cases .runs-table tbody tr", { hasText: regressionCase.name });
  await completedCaseRow.waitFor({ timeout: 10_000 });
  ok((await completedCaseRow.innerText()).includes(evaluation.id.slice(0, 8)), "case list shows the completed EvalRun id");
  ok((await api("/api/runs")).json().runs.some((item) => evaluation.runIds.includes(item.runId)), "candidate ordinary Run appears in the Runs list");
  if (process.env.E2E_SCREENSHOT) { await page.setViewportSize({ width: 1366, height: 768 }); await page.screenshot({ path: process.env.E2E_SCREENSHOT }); await page.setViewportSize({ width: 1400, height: 1000 }); }
  sweep("DOM (overview)", await glassboxText(page));
  // Newest updatedAt wins the reload's auto-select; archive the empty Agent so steps 5–6 keep their baseline.
  eq((await api("/api/agents/" + (await api("/api/agents")).json().agents.find((a) => a.name === "E2E Empty").id, { method: "DELETE" })).status, 200, "empty Agent archived (delete-archive still works)");

  console.log("\n[5] restart with GLASSBOX_DEMO_FAILURE=timeout (gated fixture through the real runner)");
  await stopServer(server);
  server = await startServer({ GLASSBOX_DEMO_FAILURE: "timeout" });
  const badRun = await runTask(agent.id, "Reply with the single word: pong");
  eq(badRun.run.status, "failed", "gated run failed (" + badRun.run.id + ")");
  eq(badRun.view.summary.status, "timeout", "trace status timeout");
  eq(badRun.view.summary.failure && badRun.view.summary.failure.kind, "timeout", "first-failure focus is the timeout");
  eq(badRun.view.summary.failure.name, "codex exec", "failing span is `codex exec`");
  eq((await api("/api/runs")).json().runs.find((r) => r.runId === badRun.run.id).firstFailingStep, "codex exec", "/api/runs firstFailingStep = codex exec");
  const badAudit = (await api("/api/runs/" + badRun.run.id + "/audit")).json().audit;
  ok(badAudit.some((row) => row.outcome === "timeout"), "/audit includes the gated timeout evidence");
  // A turn.started can arrive before the 3 s cut (#129 marks the model observed on it), so only the absence claim is asserted.
  ok(badRun.view.summary.capabilities.model !== "unavailable" && badRun.view.summary.capabilities.tool !== "unavailable", "capabilities never read unavailable on a cut-short run (#60): " + JSON.stringify(badRun.view.summary.capabilities));
  const stopped = badRun.view.events.find((e) => e.type === "runtime.container.stopped");
  eq(stopped && stopped.attributes.cleanup, "rm --force", "container teardown evidence: runtime.container.stopped cleanup=rm --force");
  ok(badRun.view.events.some((e) => e.type === "run.timed_out" && /3000/.test(e.error && e.error.message)), "run.timed_out names the 3000 ms fixture timeout");
  await sleep(1_000);
  const leftover = execFileSync(ENGINE, ["ps", "--all", "--quiet", "--filter", "name=launchpad-" + INSTANCE], { encoding: "utf8" }).trim();
  eq(leftover, "", "no launchpad-" + INSTANCE + " container left behind");

  console.log("\n[6] UI: Timed out filter → banner → Jump lands in the drawer on the failing span");
  await openApp(page);
  await page.locator(".runs-filters button", { hasText: "Timed out" }).click();
  eq(await page.locator(`${RUNS_TABLE} tbody tr`).count(), 1, "'Timed out' quick filter leaves exactly the gated run");
  await openTraceByKeyboard(page, badRun.run.id);
  await page.locator(".trace-detail button", { hasText: /^Audit$/ }).click();
  const auditTable = page.locator(".audit-table");
  await auditTable.waitFor({ timeout: 5_000 });
  eq(await auditTable.locator("tbody tr").count(), badAudit.length, "Audit table renders every API audit row for the gated Run");
  ok(/timeout/i.test(await auditTable.innerText()), "Audit table shows the timeout outcome as text");
  const auditRow = auditTable.locator("tbody tr").first();
  await auditRow.focus();
  eq(await page.evaluate(() => document.activeElement && document.activeElement.tagName), "TR", "Audit row takes focus");
  await page.keyboard.press("Enter");
  await page.locator(".trace-tree").waitFor({ timeout: 5_000 });
  eq(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("role")), "treeitem", "Enter on an audit row returns focus to its evidence span");
  const banner = page.locator(".trace-banner");
  ok((await banner.innerText()).includes("timeout"), "first-failure banner is shown");
  await page.locator("button", { hasText: "Jump to failing span" }).click();
  const dialog = page.locator("[role=dialog]");
  await dialog.waitFor({ timeout: 5_000 });
  eq(await dialog.locator("#span-drawer-title").innerText(), "codex exec", "Jump opens the drawer on `codex exec`");
  ok((await dialog.innerText()).includes("timeout"), "drawer shows the timeout status");
  ok(await page.evaluate(() => !!(document.activeElement && document.activeElement.closest("[role=dialog]"))), "Jump moves focus into the drawer");
  sweep("DOM (drawer)", await dialog.innerText());
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached", timeout: 5_000 });
  eq(await page.locator(".trace-row.failing").count(), 1, "failing span row is highlighted");
  await errorsOnly(page).check();
  ok((await page.locator("[role=treeitem]").count()) >= 1 && (await page.locator(".trace-row.failing").count()) === 1, "errors-only keeps the failing span");
  await errorsOnly(page).uncheck();
  sweep("DOM (timeout trace)", await glassboxText(page));
  eq(pageErrors.length, 0, "no uncaught page errors" + (consoleErrors.length ? " (console errors: " + consoleErrors.length + ")" : ""));
  await browser.close();
  browser = null;

  console.log("\n[7] privacy sweep: seeded fakes absent from files, API, export, log, DOM");
  const traceDir = path.join(ROOT, "data", "traces");
  const ndjson = fs.readdirSync(traceDir, { recursive: true }).filter((f) => String(f).endsWith(".ndjson"));
  ok(ndjson.length >= 2, ndjson.length + " NDJSON trace files under " + traceDir);
  for (const f of ndjson) sweep("file " + f, fs.readFileSync(path.join(traceDir, String(f)), "utf8"));
  sweep("/api/runs", (await api("/api/runs")).text);
  for (const r of [okRun, badRun]) {
    for (const url of ["/api/runs/" + r.run.id + "/trace", "/api/traces/" + r.run.traceId + "/events", "/api/traces/" + r.run.traceId + "/export"]) {
      const res = await api(url);
      eq(res.status, 200, url + " resolves (a 404 body would be trivially secret-free)");
      sweep(url, res.text);
    }
  }
  sweep("server.log", fs.readFileSync(LOG, "utf8"));
  for (const [label, text] of sweeps) {
    const hit = NEEDLES.find((n) => text.includes(n));
    assert.ok(!hit, "seeded secret " + JSON.stringify(hit) + " found in " + label);
    checks++;
  }
  console.log("  ok  " + sweeps.length + " surfaces × " + NEEDLES.length + " needles: zero hits");
  // Positive control: the prompt asked the model to echo the fakes; under safe_summary that lands in a bounded
  // summary and must be redacted. Model compliance is not deterministic, so a miss is reported, not failed.
  const redacted = okRun.view.summary.redactedEvents;
  const okFile = ndjson.map(String).find((f) => f.includes(okRun.run.id));
  if (redacted > 0) ok(okFile && fs.readFileSync(path.join(traceDir, okFile), "utf8").includes("[REDACTED:"), "positive control: " + redacted + " redacted event(s) carry [REDACTED:*] markers on disk");
  else console.log("  WARN positive control did not trigger (redactedEvents=0): the model did not echo the seeded line; absence checks above still hold");

  console.log("\n[8] performance (same shape as the vitest guards; bounds 200 ms append / 500 ms query)");
  const { NdjsonTraceStore } = await import(pathToFileURL(path.join(REPO, "apps/server/dist/glassbox/store.js")).href);
  const { buildTrace } = await import(pathToFileURL(path.join(REPO, "apps/server/dist/glassbox/query.js")).href);
  const { SCHEMA_VERSION } = await import(pathToFileURL(path.join(REPO, "apps/server/dist/glassbox/schema.js")).href);
  const ev = (sequence, over = {}) => ({ schemaVersion: SCHEMA_VERSION, eventId: "evt_" + sequence, sequence, traceId: "trc_perf", spanId: "spn_" + sequence, runId: "run-perf", agentId: "agt-perf", actorId: "local-user", actorType: "human", attempt: 1, timestamp: new Date(1_700_000_000_000 + sequence).toISOString(), type: "tool.call.completed", category: "tool", phase: "instant", status: "ok", name: "t" + sequence, source: { component: "AgentRunner", observed: true }, attributes: {}, privacy: { redacted: false, rulesetVersion: "1" }, ...over });
  const perfStore = new NdjsonTraceStore(path.join(ROOT, "perf-traces"));
  await perfStore.initialize();
  const appendTimes = [];
  for (let i = 1; i <= 100; i++) { const t = performance.now(); await perfStore.append(ev(i)); appendTimes.push(performance.now() - t); }
  const events = Array.from({ length: 500 }, (_, i) => ev(i + 1, i % 2 ? { parentSpanId: "spn_" + i } : {}));
  const queryTimes = [];
  for (let i = 0; i < 20; i++) { const t = performance.now(); buildTrace(events, { capturePolicy: "metadata_only" }); queryTimes.push(performance.now() - t); }
  const appendP95 = p95(appendTimes), queryP95 = p95(queryTimes);
  console.log("      append p95 " + appendP95.toFixed(2) + " ms (100 events)   query p95 " + queryP95.toFixed(2) + " ms (500 events)");
  ok(appendP95 < 200, "append p95 < 200 ms");
  ok(queryP95 < 500, "query p95 < 500 ms");

  await stopServer(server);
  server = null;
  console.log("\nE2E PASS — " + checks + " checks; runs " + okRun.run.id + " (ok) + " + badRun.run.id + " (timeout); append p95 " + appendP95.toFixed(1) + " ms, query p95 " + queryP95.toFixed(1) + " ms, redactedEvents " + redacted);
})().catch(async (error) => {
  console.error("\nE2E FAIL: " + (error && error.stack || error));
  exitCode = 1;
}).finally(async () => {
  try {
    // Always close Chromium and the built server, including assertion and browser-navigation failures.
    await closeResources();
  } catch (error) {
    exitCode = 1;
    console.error("\nE2E CLEANUP FAIL: " + (error && error.stack || error));
  }
  await flushOutput();
  process.exit(exitCode);
});
