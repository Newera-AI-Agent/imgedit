// .newera/vm/runner.mjs — NewEra headless coding agent v2 (runs inside GitHub Actions).
// Self-contained: Node 20 built-ins only. Model access is proxied through the
// NewEra control plane, so no model API keys ever enter this VM.
//
// v2: parallel sub-agents, rolling-summary context management, VM relay
// (checkpoint + handoff + continuation on a fresh VM, max 2 relays), and
// deploy-to-Cloudflare after a verified green build.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
const execFileAsync = promisify(execFile);

const API = (process.env.NEWERA_API_URL || "").replace(/\/$/, "");
const JOB_ID = process.env.NEWERA_JOB_ID || "";
const TOKEN = process.env.NEWERA_JOB_TOKEN || "";
const TASK = Buffer.from(process.env.NEWERA_TASK_B64 || "", "base64").toString("utf8");
const MAX_MINUTES = Math.max(5, Number(process.env.NEWERA_MAX_MINUTES) || 30);
const DEADLINE = Date.now() + Math.max(5, MAX_MINUTES - 6) * 60 * 1000;
const MAX_STEPS = 600;
// Resume-chain handoff (resume_vm_agent): the EXPLICIT continuation path
// seeds this VM with the previous session handoff via NEWERA_HANDOFF_B64.
// Relay children get their continuation embedded in TASK instead, so this
// stays empty there. When present, the first message points the agent at
// the handoff and forbids redoing committed work.
const HANDOFF = Buffer.from(process.env.NEWERA_HANDOFF_B64 || "", "base64").toString("utf8").trim();
const REPO = process.env.GITHUB_REPOSITORY || "";
const GIT_TOKEN = process.env.GITHUB_TOKEN || "";
const ROOT = process.cwd();

// ---------- relay: a chain of VMs for long-horizon work ----------
// RELAY_INDEX 0 = the original job; 1..2 are continuations. The control
// plane refuses to chain past MAX_RELAYS, and so does the runner.
const RELAY_INDEX = Math.max(0, Number(process.env.NEWERA_RELAY_INDEX) || 0);
const MAX_RELAYS = 2;
// The wrap-up checkpoint: this many minutes before the soft deadline the
// runner stops STARTING new work, writes the handoff, commits, and asks
// the control plane to boot the next VM. For a 240-minute budget this
// fires at about 3h39m — the VM is never killed mid-edit.
const RELAY_CHECKPOINT_MIN = 15;
// Only long-horizon jobs relay. A default 30-minute job that runs out of
// time ends honestly as unfinished instead of silently chaining on.
const RELAY_MIN_JOB_MINUTES = 45;
let relayDispatched = false;

// ---------- sub-agents ----------
const SUB_CONCURRENCY = 3;
const SUB_MAX_STEPS = 40;
const SUB_MAX_PER_SPAWN = 6;
const SUB_MAX_MINUTES = 20;
// Sub-agents get a smaller context budget and a simple splice (no extra
// summarize calls — the parent compaction already carries the big picture).
const SUB_BUDGET_CHARS = 150000;

// ---------- context management (same shape as the browser loop) ----------
// ~480k chars is roughly 130k tokens of history — safely inside the
// smallest configured coder window (256k) once system+task+summary are
// counted. The middle is compacted through the summarize model.
const CONTEXT_BUDGET_CHARS = 480000;
const KEEP_TAIL = 14;
let rollingSummary = "";
let compactions = 0;

function log(line) {
  try { fs.appendFileSync("agent.log", line + "\n"); } catch (e) {}
  console.log(line);
}

function minutesLeft() { return Math.max(0, Math.round((DEADLINE - Date.now()) / 60000)); }

async function apiPost(pathname, body, timeoutMs) {
  const res = await fetch(API + pathname, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + TOKEN,
      "Content-Type": "application/json",
      "X-Newera-Job": JOB_ID,
    },
    body: JSON.stringify(body),
    // Per-call deadline: model calls get 180 s (long generations are real);
    // progress reports 30 s; the default stays generous for safety.
    signal: AbortSignal.timeout(timeoutMs || 280000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!res.ok) {
    const detail = (data && data.error) ? data.error : ("HTTP " + res.status + " " + text.slice(0, 200));
    const err = new Error("control plane: " + detail);
    err.status = res.status;
    throw err;
  }
  return data || {};
}

// Lightweight GET with the same auth headers — used by the boot-time
// control-plane reachability check (fail fast instead of 25 silent minutes).
async function apiGet(pathname, timeoutMs) {
  const res = await fetch(API + pathname, {
    headers: {
      Authorization: "Bearer " + TOKEN,
      "X-Newera-Job": JOB_ID,
    },
    signal: AbortSignal.timeout(timeoutMs || 15000),
  });
  if (!res.ok) {
    const err = new Error("control plane: HTTP " + res.status);
    err.status = res.status;
    throw err;
  }
  return true;
}

// purpose: "steps" (the coder model — default) or "summarize" (the cheap
// rag model). The server picks the actual model id; the runner cannot shop.
async function callModel(messages, purpose) {
  const data = await apiPost("/api/vm/agent", { messages: messages, purpose: purpose || "steps" }, 180000);
  if (typeof data.content !== "string" || !data.content.trim()) {
    throw new Error("empty model response");
  }
  return data.content;
}

function reportProgress(payload) {
  return apiPost("/api/vm/agent", { progress: payload }, 30000).catch(function (e) {
    log("[progress] failed: " + e.message);
  });
}

function reportFinal(summary, unfinished, handoff) {
  const body = { event: "final", summary: String(summary || "").slice(0, 8000), unfinished: Boolean(unfinished) };
  // Optional handoff: lets the control plane store a resumable continuation
  // brief on the job even when the auto-relay could not fire (short job,
  // relay budget spent) — resume_vm_agent then seeds the next VM from it.
  if (handoff && String(handoff).trim()) body.handoff = String(handoff).slice(0, 12000);
  return apiPost("/api/vm/agent", body, 30000).catch(function (e) {
    log("[final-report] failed: " + e.message);
  });
}

// Ask the control plane to boot the NEXT VM in this chain. The handoff (and
// all work so far) is already committed on the repo main branch, so the
// next VM simply checks it out and continues. Server-side this creates a
// child VmJob linked through nextJobId and dispatches the workflow.
function reportRelay(handoff) {
  return apiPost("/api/vm/agent", { event: "relay", handoff: String(handoff || "").slice(0, 24000) }, 30000).catch(function (e) {
    log("[relay] failed: " + e.message);
  });
}

// Register a deploy request with the control plane. Cloudflare keys never
// enter the VM: the browser side deploys the uploaded build-output artifact
// through the existing /api/deploy/cloudflare route after the run completes.
function reportDeployRequest(subdomain, mode) {
  return apiPost("/api/vm/agent", { event: "deploy_request", subdomain: subdomain, mode: mode }, 30000).catch(function (e) {
    log("[deploy-request] failed: " + e.message);
  });
}

// ---------- filesystem helpers (all paths stay inside the repo) ----------
function safePath(raw) {
  const p = String(raw || "").replace(/^\/+/, "");
  const resolved = path.resolve(ROOT, p);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    throw new Error("path escapes the repository: " + raw);
  }
  return resolved;
}

function listFilesTree(dir, depth, prefix, out) {
  if (out.length > 400) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  entries.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules" || e.name === ".venv" || e.name === "__pycache__") continue;
    const rel = prefix ? prefix + "/" + e.name : e.name;
    if (e.isDirectory()) {
      out.push(rel + "/");
      if (depth > 0) listFilesTree(path.join(dir, e.name), depth - 1, rel, out);
    } else {
      let size = 0;
      try { size = fs.statSync(path.join(dir, e.name)).size; } catch (err) {}
      out.push(rel + " (" + size + "b)");
    }
  }
}

function toolListFiles(args) {
  const dir = safePath(args.path || ".");
  const out = [];
  listFilesTree(dir, 4, "", out);
  return { ok: true, output: out.length ? out.join("\n") : "(empty directory)" };
}

/* ---- VM skill pack (.newera/skills/) -------------------------------- *
 * list_skills: one-line catalog (name — description).
 * read_skill: full body, capped, greenfield guidance points here. */
const SKILLS_DIR = ".newera/skills";
function skillCatalog() {
  const out = [];
  try {
    const names = fs.readdirSync(SKILLS_DIR).filter(function (n) { return n.endsWith(".md"); }).sort();
    for (const n of names) {
      let desc = "";
      try {
        const raw = fs.readFileSync(SKILLS_DIR + "/" + n, "utf8");
        const m = raw.match(/^description:s*(.+)$/m);
        if (m) desc = m[1].trim().slice(0, 160);
        else {
          const h = raw.match(/^#s*(.+)$/m);
          if (h) desc = h[1].trim().slice(0, 160);
        }
      } catch (e) {}
      out.push("- " + n.replace(/.md$/, "") + (desc ? " — " + desc : ""));
    }
  } catch (e) {
    return "(no skills bundled in this job)";
  }
  return out.length ? "Available skills (read_skill{name}):\n" + out.join("\n") : "(no skills bundled in this job)";
}
function toolListSkills() {
  return { ok: true, output: skillCatalog() };
}
function toolReadSkill(args) {
  const name = String(args.name || "").trim().replace(/.md$/, "");
  if (!name) return { ok: false, output: "name is required — call list_skills first" };
  if (!/^[a-z0-9-]+$/.test(name)) return { ok: false, output: "invalid skill name" };
  const p = safePath(SKILLS_DIR + "/" + name + ".md");
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    return { ok: false, output: "skill not found: " + name + "\n" + skillCatalog() };
  }
  const st = fs.statSync(p);
  if (st.size > 200 * 1024) return { ok: false, output: "skill too large (" + st.size + "b) — read in slices" };
  const raw = fs.readFileSync(p, "utf8");
  const lines = raw.split("\n");
  const start = Math.max(1, Number(args.start) || 1);
  const end = Math.min(lines.length, Number(args.end) || start + 499);
  const body = lines.slice(start - 1, end).map(function (l, i) { return (start + i) + ": " + l; }).join("\n");
  return {
    ok: true,
    output: "skill " + name + " [lines " + start + "-" + end + " of " + lines.length + "]\n" + body +
      (end < lines.length ? "\n[more — read with start=" + (end + 1) + "]" : ""),
  };
}

function toolReadFile(args) {
  if (!args.path) return { ok: false, output: "path is required" };
  const p = safePath(args.path);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return { ok: false, output: "file not found: " + args.path };
  const st = fs.statSync(p);
  if (st.size > 2 * 1024 * 1024) return { ok: false, output: "file is larger than 2 MB (" + st.size + " bytes) — read it in slices with shell tools" };
  const lines = fs.readFileSync(p, "utf8").split("\n");
  const start = Math.max(1, Number(args.start) || 1);
  const end = Math.min(lines.length, Number(args.end) || start + 399);
  const body = lines.slice(start - 1, end).map(function (l, i) { return (start + i) + ": " + l; }).join("\n");
  return {
    ok: true,
    output: args.path + " [lines " + start + "-" + end + " of " + lines.length + "]\n" + body +
      (end < lines.length ? "\n[more lines follow — read with start=" + (end + 1) + "]" : ""),
  };
}

function toolWriteFile(args) {
  if (!args.path) return { ok: false, output: "path is required" };
  if (typeof args.content !== "string") return { ok: false, output: "content (string) is required" };
  const p = safePath(args.path);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, args.content, "utf8");
  const n = args.content.split("\n").length;
  return { ok: true, output: "wrote " + args.path + " (" + n + " lines)" };
}

function toolEditFile(args) {
  if (!args.path) return { ok: false, output: "path is required" };
  if (typeof args.find !== "string" || !args.find) return { ok: false, output: "find (string) is required" };
  const p = safePath(args.path);
  if (!fs.existsSync(p)) return { ok: false, output: "file not found: " + args.path };
  const current = fs.readFileSync(p, "utf8");
  const find = args.find;
  const replace = typeof args.replace === "string" ? args.replace : "";
  const occurrences = current.split(find).length - 1;
  if (occurrences === 0) return { ok: false, output: "find text is not present in " + args.path };
  if (occurrences > 1 && args.all !== true) {
    return { ok: false, output: "find text matches " + occurrences + " places — add more surrounding lines to make it unique, or pass all:true" };
  }
  const next = args.all === true ? current.split(find).join(replace) : current.replace(find, replace);
  fs.writeFileSync(p, next, "utf8");
  return { ok: true, output: "patched " + args.path + " (" + occurrences + " occurrence(s) replaced)" };
}

function toolDeleteFile(args) {
  if (!args.path) return { ok: false, output: "path is required" };
  const p = safePath(args.path);
  if (!fs.existsSync(p)) return { ok: false, output: "file not found: " + args.path };
  fs.rmSync(p, { recursive: true });
  return { ok: true, output: "deleted " + args.path };
}

async function toolShell(args, step) {
  const command = String(args.command || "").trim();
  if (!command) return { ok: false, output: "command is required" };
  const requestedMin = Number(args.timeout_minutes) || 10;
  const timeoutMs = Math.min(30, Math.max(1, requestedMin)) * 60 * 1000;
  // Never let one command eat the packaging headroom or the relay window.
  const budgetMs = Math.max(60000, DEADLINE - Date.now() - 180000);
  const effMs = Math.min(timeoutMs, budgetMs);
  // spawn (not execFile) so long installs can REPORT progress instead of
  // looking like a hang: every 45s the last output line is pushed to the
  // control plane, which watch_vm_agent streams into the chat transcript.
  return await new Promise(function (resolve) {
    const child = spawn("bash", ["-lc", command], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { CI: "1", NO_COLOR: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let lastLine = "";
    function onData(chunk) {
      out += String(chunk);
      if (out.length > 4 * 1024 * 1024) out = out.slice(-2 * 1024 * 1024);
      const lines = out.split("\n").filter(function (l) { return l.trim(); });
      if (lines.length) lastLine = lines[lines.length - 1].slice(0, 160);
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let done = false;
    const heartbeat = setInterval(function () {
      reportProgress({
        step: step,
        lastTool: "shell",
        thought: "(still running)",
        lastResult: lastLine ? "running… " + lastLine : "running… (no output yet)",
        ok: true,
        minutesLeft: minutesLeft(),
      });
    }, 45000);
    const killTimer = setTimeout(function () { child.kill("SIGKILL"); }, effMs);
    function finish(code, signal) {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      clearTimeout(killTimer);
      const tail = (out || "").trim();
      if (code === 0) {
        resolve({ ok: true, output: cap(tail || "(no output)") });
      } else {
        const why = code === null ? "killed by " + (signal || "timeout") : String(code);
        resolve({ ok: false, output: cap(tail + "\n[exit " + why + "]") });
      }
    }
    child.on("close", finish);
    child.on("error", function (err) {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      clearTimeout(killTimer);
      resolve({ ok: false, output: "spawn failed: " + (err.message || String(err)) });
    });
  });
}

// Write the run summary INTO THE REPO so the package artifact always
// carries it — collect_vm_agent reads it back and shows it to the user.
function writeResultSummary(text) {
  try {
    fs.mkdirSync(path.join(ROOT, ".newera", "vm"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, ".newera", "vm", "result-summary.md"), "# VM agent result\n\n" + String(text || "") + "\n");
  } catch (e) {}
}

function cap(text) {
  const t = String(text || "");
  if (t.length <= 24000) return t || "(no output)";
  return t.slice(0, 14000) + "\n... [" + (t.length - 24000) + " chars elided] ...\n" + t.slice(-9000);
}

// ---------- JSON envelope parsing ----------
function extractJsonObjects(text) {
  const out = [];
  let depth = 0; let start = -1; let inStr = false; let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return out;
}

function parseTurn(raw) {
  const blocks = extractJsonObjects(raw);
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(blocks[i]);
      if (obj && (obj.action || obj.final)) return obj;
    } catch (e) {}
  }
  return null;
}

// ---------- git progress commits ----------
async function git(args) {
  return execFileAsync("git", args, { cwd: ROOT, timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
}

async function gitCommitIfNeeded(label) {
  if (!GIT_TOKEN || !REPO) return;
  try {
    try {
      fs.mkdirSync(path.join(ROOT, ".git", "info"), { recursive: true });
      fs.appendFileSync(path.join(ROOT, ".git", "info", "exclude"), "node_modules/\n.venv/\n__pycache__/\n*.zip\nagent.log\n");
    } catch (e) {}
    await git(["add", "-A"]);
    const status = await git(["status", "--porcelain"]);
    if (!status.stdout.trim()) return;
    await git(["-c", "user.name=NewEra VM Agent", "-c", "user.email=newera-vm@users.noreply.github.com", "commit", "-m", label]);
    await git(["push", "https://x-access-token:" + GIT_TOKEN + "@github.com/" + REPO + ".git", "HEAD:" + (process.env.GITHUB_REF_NAME || "main")]);
    log("[git] progress commit pushed: " + label);
  } catch (err) {
    log("[git] progress commit skipped: " + (err.message || err));
  }
}

// ---------- rolling-summary context management ----------
// Ported from the browser loop (context/agent/summarize.ts): when history
// grows past the budget, the MIDDLE is handed to the cheap summarize model
// and replaced with one durable "## Progress so far" block. The head
// (system + task) and the freshest KEEP_TAIL messages stay verbatim. A
// multi-hour job therefore never forgets decisions, verified facts or file
// state — and the block doubles as the relay handoff skeleton.
const SUMMARY_MARKER = "## Progress so far";

const SUMMARY_PROMPT = [
  "You compress an autonomous coding agent working memory.",
  "Given the transcript below, produce a dense markdown brief with EXACTLY these sections:",
  "",
  "## Progress so far",
  "### Decisions",
  "- durable choices (stack, file layout, naming, trade-offs already settled)",
  "### Files written or changed",
  "- path — what it now contains",
  "### Verified facts",
  "- commands run + exit codes, URLs that work, errors already diagnosed",
  "### Open items",
  "- what still has to happen, in order",
  "",
  "Rules: no prose outside those sections, no speculation, keep every path, command,",
  "version number, port and error string exactly as written. Under 2500 characters.",
].join("\n");

function historyChars(history) {
  let n = 0;
  for (const m of history) n += String(m.content || "").length;
  return n;
}

async function compactHistory(history) {
  if (historyChars(history) <= CONTEXT_BUDGET_CHARS) return false;
  if (history.length <= 4 + KEEP_TAIL) return false;
  const keepHead = 2; // system + task
  const middle = history.slice(keepHead, history.length - KEEP_TAIL);
  const transcript = middle
    .map(function (m) { return m.role.toUpperCase() + ": " + m.content; })
    .filter(Boolean)
    .join("\n\n")
    .slice(-90000);
  try {
    const brief = await callModel([
      { role: "system", content: "You produce terse, dense memory briefs. No thinking tags, no prose outside the requested sections." },
      { role: "user", content: SUMMARY_PROMPT + "\n\n## TRANSCRIPT\n" + (rollingSummary ? "## Prior brief (carry its facts forward)\n" + rollingSummary + "\n\n" : "") + transcript },
    ], "summarize");
    if (brief && brief.trim()) {
      rollingSummary = brief.trim().slice(0, 6000);
      compactions++;
      log("[context] compacted: " + history.length + " -> " + (keepHead + 1 + KEEP_TAIL) + " messages (compaction #" + compactions + ")");
    }
  } catch (err) {
    log("[context] summarize failed, falling back to prune: " + err.message);
  }
  // Rebuild the history: head + rolling summary + fresh tail. When the
  // summarize call failed we still prune the middle (facts survive in the
  // prior summary if one exists, and in the repo itself).
  const tail = history.slice(history.length - KEEP_TAIL);
  const head = history.slice(0, keepHead);
  history.length = 0;
  for (const m of head) history.push(m);
  if (rollingSummary) {
    history.push({ role: "user", content: rollingSummary + "\n\n(This block is your durable memory of earlier steps — treat it as fact.)" });
  }
  for (const m of tail) history.push(m);
  return true;
}

// ---------- deploy after green build ----------
// The static output dirs the deploy pipeline understands (same order as
// pickStaticRoot on the server). guessStaticOutDir finds one that really
// holds an index.html so the artifact prefix matches what deploy expects.
const STATIC_OUT_DIRS = [".newera/out", "out", "build/web", "dist/public", "dist/static", "dist", "build", "public"];

function guessStaticOutDir() {
  for (const d of STATIC_OUT_DIRS) {
    const full = path.join(ROOT, d);
    try {
      if (fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, "index.html"))) return d;
    } catch (e) {}
  }
  return null;
}

function sanitizeSubdomain(raw) {
  const s = String(raw || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  if (s.length < 3 || s.length > 63) return null;
  return s;
}

async function toolRequestDeploy(args) {
  const subdomain = sanitizeSubdomain(args.subdomain);
  if (!subdomain) {
    return { ok: false, output: "request_deploy requires a valid subdomain (3-63 chars, letters/digits/hyphens). The URL will be subdomain.newera.page.dev." };
  }
  const mode = args.mode === "permanent" ? "permanent" : "preview";
  let outDir = null;
  if (typeof args.build_output_path === "string" && args.build_output_path.trim()) {
    const rel = String(args.build_output_path).replace(/^\/+/, "");
    const full = safePath(rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
      return { ok: false, output: "build_output_path does not exist or is not a directory: " + rel + " — build FIRST, then request the deploy." };
    }
    outDir = rel;
  } else {
    outDir = guessStaticOutDir();
  }
  if (!outDir) {
    return { ok: false, output: "No static build output found (looked for: " + STATIC_OUT_DIRS.join(", ") + " with an index.html). Run the real build first, then request the deploy — a deploy without a verified build is forbidden." };
  }
  const indexPath = path.join(safePath(outDir), "index.html");
  if (!fs.existsSync(indexPath)) {
    return { ok: false, output: "No index.html inside " + outDir + " — this is not a deployable static site. Check the build output directory." };
  }
  try {
    fs.mkdirSync(path.join(ROOT, ".newera", "vm"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, ".newera", "vm", "build-output-path.txt"), outDir + "\n", "utf8");
    fs.writeFileSync(path.join(ROOT, ".newera", "vm", "deploy-request.json"), JSON.stringify({ subdomain: subdomain, mode: mode, build_output: outDir, job: JOB_ID, at: new Date().toISOString() }, null, 2) + "\n", "utf8");
  } catch (err) {
    return { ok: false, output: "could not write the deploy request file: " + (err.message || String(err)) };
  }
  await reportDeployRequest(subdomain, mode);
  log("[deploy] requested: " + subdomain + " (" + mode + ") from " + outDir);
  return {
    ok: true,
    output: "Deploy requested for " + subdomain + ".newera.page.dev (" + mode + " mode, output: " + outDir + "). The workflow uploads the build output as an artifact when this job ends, and NewEra deploys it to Cloudflare Pages automatically — the live URL is delivered by watch_vm_agent. Cloudflare keys stay outside this VM by design.",
  };
}

// ---------- sub-agents ----------
// Each sub-agent is a full agent loop with its own context, its own file
// ownership and its own scratch folder, sharing the SAME tools and the SAME
// model proxy as the parent. They may not spawn further agents, may not
// finish the overall task and may not request deploys — those belong to the
// parent only. Bounded concurrency keeps 429s away.
const SUB_SYSTEM_PROMPT = [
  "You are a NewEra VM sub-agent — a focused software engineer working inside a real Ubuntu Linux VM (a GitHub Actions runner) alongside sibling agents.",
  "You have a real shell, the repository on disk, Node 20 + npm and Python 3 + pip (python3 -m pip).",
  "",
  "Every reply is EXACTLY ONE JSON object — no prose, no markdown fences:",
  '{"thought":"brief reasoning","action":{"tool":"<tool>","args":{...}}}',
  "or, when YOUR slice of the work is done:",
  '{"thought":"...","final":"what you did, commands run + exit codes, files changed, anything left"}',
  "",
  "TOOLS: shell{command, timeout_minutes?}, list_files{path?}, read_file{path,start?,end?}, write_file{path,content}, edit_file{path,find,replace,all?}, delete_file{path}.",
  "",
  "RULES:",
  "1. You may only MODIFY the files assigned to you (plus your scratch folder). Reads are unrestricted.",
  "2. Verify your own work: run the build/tests for your slice and fix real errors. Never claim success without a green command.",
  "3. Do not git commit or push — the harness commits. Never touch .github/workflows/ or .newera/.",
  "4. No long-running servers left alive: background them, curl them, kill them.",
  "5. Finish with an honest summary — partial is fine, silent failure is not.",
].join("\n");

function subScratchDir(name) {
  const safe = String(name || "agent").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return "work/" + (safe || "agent");
}

function subOwnershipError(action, owned, scratch) {
  const MUTATORS = ["write_file", "edit_file", "delete_file"];
  if (MUTATORS.indexOf(action.tool) === -1) return null;
  const raw = String((action.args || {}).path || "");
  const rel = raw.replace(/^\/+/, "");
  if (!rel) return "path is missing";
  if (rel === scratch || rel.indexOf(scratch + "/") === 0) return null;
  for (const ownedPath of owned) {
    const o = String(ownedPath).replace(/^\/+/, "");
    if (rel === o || rel.indexOf(o + "/") === 0) return null;
  }
  return "Ownership violation: you may only modify " + owned.join(", ") + " (plus " + scratch + "/). Not " + rel + ".";
}

// Runs ONE sub-agent to completion. Returns a summary string. Progress is
// reported with the agent name in lastTool so the live feed shows the team.
async function runSubagent(spec, parentStep) {
  const name = String(spec.name || "agent");
  const task = String(spec.task || "").trim();
  if (!task) return "### " + name + "\nFAILED: no task text given.";
  const owned = Array.isArray(spec.files) ? spec.files.map(String) : [];
  const scratch = subScratchDir(name);
  const tree = [];
  listFilesTree(ROOT, 3, "", tree);
  const history = [
    { role: "system", content: SUB_SYSTEM_PROMPT },
    {
      role: "user",
      content: "YOUR SLICE OF THE WORK: " + task + "\n\n" +
        (owned.length ? "FILES YOU OWN (only you may modify these): " + owned.join(", ") + "\n" : "") +
        "SCRATCH FOLDER: " + scratch + "/ is yours alone for notes and drafts.\n" +
        "THE OVERALL TASK (context only — do your slice, not all of it):\n" + TASK.slice(0, 4000) + "\n\n" +
        "Repository tree (top):\n" + tree.slice(0, 120).join("\n") + "\n\nStart now. ONE JSON object per reply.",
    },
  ];
  const subDeadline = Math.min(Date.now() + SUB_MAX_MINUTES * 60000, DEADLINE - 8 * 60000);
  const parseFailures0 = { n: 0 };
  let summary = null;
  let step;
  for (step = 1; step <= SUB_MAX_STEPS; step++) {
    if (Date.now() >= subDeadline) {
      return "### " + name + "\nPARTIAL (out of time after " + step + " steps). " + (summary || "See the repo for partial work.");
    }
    let raw = "";
    let modelError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        raw = await callModel(history, "steps");
        modelError = null;
        break;
      } catch (err) {
        modelError = err;
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) break;
        await new Promise(function (r) { setTimeout(r, 3000 * (attempt + 1)); });
      }
    }
    if (modelError) {
      return "### " + name + "\nFAILED (model proxy unreachable after 3 attempts): " + modelError.message;
    }
    const turn = parseTurn(raw);
    if (!turn) {
      parseFailures0.n++;
      history.push({ role: "assistant", content: raw.slice(0, 1500) });
      history.push({ role: "user", content: "PROTOCOL: reply with EXACTLY one JSON object: {\"thought\":\"...\",\"action\":{\"tool\":\"...\",\"args\":{...}}} — no prose." });
      if (parseFailures0.n >= 3) return "### " + name + "\nFAILED (protocol violations x3).";
      continue;
    }
    if (turn.final) {
      return "### " + name + "\n" + String(turn.final).slice(0, 3000);
    }
    const action = turn.action || {};
    const toolName = String(action.tool || "");
    const args = action.args || {};
    if (toolName === "spawn_agents" || toolName === "request_deploy" || toolName === "finish") {
      history.push({ role: "user", content: "[" + toolName + "] is reserved for the parent agent. Do the work yourself, or reply with your final summary." });
      continue;
    }
    const ownership = subOwnershipError(action, owned, scratch);
    if (ownership) {
      history.push({ role: "user", content: "[ownership guard] " + ownership });
      continue;
    }
    await reportProgress({
      step: parentStep,
      lastTool: "[" + name + "] " + toolName,
      thought: String(turn.thought || "").slice(0, 200),
      lastResult: "(executing…)",
      ok: true,
      minutesLeft: minutesLeft(),
    });
    let result;
    try {
      if (toolName === "shell") result = await toolShell(args, parentStep);
      else if (toolName === "list_files") result = toolListFiles(args);
      else if (toolName === "list_skills") result = toolListSkills();
      else if (toolName === "read_skill") result = toolReadSkill(args);
      else if (toolName === "read_file") result = toolReadFile(args);
      else if (toolName === "write_file") result = toolWriteFile(args);
      else if (toolName === "edit_file") result = toolEditFile(args);
      else if (toolName === "delete_file") result = toolDeleteFile(args);
      else result = { ok: false, output: "unknown tool: " + toolName };
    } catch (err) {
      result = { ok: false, output: "tool error: " + (err.message || String(err)) };
    }
    await reportProgress({
      step: parentStep,
      lastTool: "[" + name + "] " + toolName,
      thought: String(turn.thought || "").slice(0, 200),
      lastResult: String(result.output || "").slice(0, 400),
      ok: result.ok,
      minutesLeft: minutesLeft(),
    });
    history.push({ role: "assistant", content: JSON.stringify({ thought: String(turn.thought || "").slice(0, 400), action: { tool: toolName, args: compactArgs(args) } }) });
    history.push({ role: "user", content: "[" + toolName + (result.ok ? " ok" : " FAILED") + "]\n" + cap(String(result.output || "")).slice(0, 8000) });
    // Sub-agent context: simple budget splice (head + tail kept).
    if (historyChars(history) > SUB_BUDGET_CHARS && history.length > 14) {
      const head = history.slice(0, 2);
      const tail = history.slice(-10);
      history.length = 0;
      for (const m of head) history.push(m);
      history.push({ role: "user", content: "[earlier steps elided to save context — the repo and your scratch notes hold the facts]" });
      for (const m of tail) history.push(m);
    }
  }
  return "### " + name + "\nPARTIAL (hit the " + SUB_MAX_STEPS + "-step limit). " + (summary || "See the repo for partial work.");
}

// spawn_agents{tasks:[{name, task, files?}]} — runs 1..6 sub-agents with
// bounded concurrency and returns one markdown block per agent. The parent
// BLOCKS until all agents finish (a VM job is single-purpose — fire and
// forget would let the parent finish the task while children still edit).
async function toolSpawnAgents(args, step) {
  const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
  if (rawTasks.length === 0) {
    return { ok: false, output: "spawn_agents requires tasks: [{name, task, files}] — a non-empty array." };
  }
  if (rawTasks.length > SUB_MAX_PER_SPAWN) {
    return { ok: false, output: "Too many sub-agents (" + rawTasks.length + ", max " + SUB_MAX_PER_SPAWN + "). Split the work into fewer, bigger slices or do some yourself." };
  }
  if (minutesLeft() < 12) {
    return { ok: false, output: "Not enough time left (" + minutesLeft() + " min) to supervise sub-agents — do the critical work yourself and finish." };
  }
  const specs = [];
  const usedNames = {};
  for (let i = 0; i < rawTasks.length; i++) {
    const t = rawTasks[i] && typeof rawTasks[i] === "object" ? rawTasks[i] : {};
    let name = String(t.name || "agent-" + (i + 1)).slice(0, 40);
    let n = 2;
    while (usedNames[name]) { name = String(t.name || "agent-" + (i + 1)).slice(0, 36) + "-" + n; n++; }
    usedNames[name] = true;
    specs.push({ name: name, task: String(t.task || ""), files: Array.isArray(t.files) ? t.files.map(String) : [] });
  }
  // Ownership overlap check — two agents editing the same file is a caller bug.
  const owners = [];
  for (let i = 0; i < specs.length; i++) {
    for (const rawPath of specs[i].files) {
      const p = String(rawPath).replace(/^\/+/, "");
      for (let j = 0; j < owners.length; j++) {
        if (p === owners[j].path || p.indexOf(owners[j].path + "/") === 0 || owners[j].path.indexOf(p + "/") === 0) {
          return { ok: false, output: "Overlapping ownership: " + specs[owners[j].i].name + " owns " + owners[j].path + " and " + specs[i].name + " also wants " + p + ". Split the files." };
        }
      }
      owners.push({ path: p, i: i });
    }
  }
  log("[team] spawning " + specs.length + " sub-agent(s): " + specs.map(function (s) { return s.name; }).join(", "));
  await reportProgress({
    step: step,
    lastTool: "spawn_agents",
    thought: "dispatching " + specs.length + " sub-agent(s)",
    lastResult: "team: " + specs.map(function (s) { return s.name; }).join(", "),
    ok: true,
    minutesLeft: minutesLeft(),
  });
  const outcomes = new Array(specs.length);
  let nextIndex = 0;
  const workers = [];
  const workerCount = Math.min(SUB_CONCURRENCY, specs.length);
  for (let w = 0; w < workerCount; w++) {
    workers.push((async function () {
      if (w > 0) await new Promise(function (r) { setTimeout(r, w * 1500); });
      for (;;) {
        const i = nextIndex++;
        if (i >= specs.length) return;
        const started = Date.now();
        const summary = await runSubagent(specs[i], step);
        outcomes[i] = summary;
        log("[team] " + specs[i].name + " finished in " + Math.round((Date.now() - started) / 1000) + "s");
        await reportProgress({
          step: step,
          lastTool: "[" + specs[i].name + "] done",
          thought: "sub-agent finished",
          lastResult: String(summary).slice(0, 300),
          ok: !/^### .*\nFAILED/.test(summary),
          minutesLeft: minutesLeft(),
        });
      }
    })());
  }
  await Promise.all(workers);
  await gitCommitIfNeeded("agent: sub-agent batch checkpoint");
  const blocks = [];
  for (let i = 0; i < specs.length; i++) {
    blocks.push(outcomes[i] || ("### " + specs[i].name + "\n(no summary)"));
  }
  return {
    ok: true,
    output: "SUB-AGENTS REPORT:\n\n" + cap(blocks.join("\n\n")) + "\n\nEach agent summary above is authoritative for its slice. Verify their claims with your own commands before finishing; commit-worthy work is already committed.",
  };
}

// ---------- relay handoff ----------
// The handoff is the contract between two VMs: original task, durable
// progress (the rolling summary), the exact repo state, and what to do
// next. It is committed to the repo AND sent to the control plane, which
// boots the next VM with it as the task brief.
async function gitStateBlock() {
  let changed = "";
  let log15 = "";
  try {
    const status = await git(["status", "--porcelain"]);
    changed = status.stdout.split("\n").filter(Boolean).slice(0, 200).join("\n") || "(clean tree)";
  } catch (e) { changed = "(git status unavailable: " + (e.message || e) + ")"; }
  try {
    const lg = await git(["log", "--oneline", "-15"]);
    log15 = lg.stdout.trim() || "(no commits yet)";
  } catch (e) { log15 = "(git log unavailable)"; }
  return "## Repository state\nChanged/added files:\n" + changed + "\n\nRecent commits:\n" + log15;
}

async function buildHandoff(step) {
  const gitBlock = await gitStateBlock();
  const parts = [
    "# RELAY HANDOFF — job " + JOB_ID + " (VM " + (RELAY_INDEX + 1) + " of " + (MAX_RELAYS + 1) + ")",
    "Written at the " + RELAY_CHECKPOINT_MIN + "-minute checkpoint with " + minutesLeft() + " min left, after " + step + " steps.",
    "",
    "## Original task",
    TASK,
    "",
    "## Progress so far",
    rollingSummary || "(no rolling summary was generated — reconstruct state from the git log below and the repo itself)",
    "",
    gitBlock,
    "",
    "## What the next VM must do",
    "1. Check the repo state above — everything committed so far is real and on disk.",
    "2. Do NOT redo finished work. Verify what exists (build, tests) before touching anything.",
    "3. Continue the ORIGINAL task to completion, then finish with an honest summary.",
    "4. If a deploy was requested and the build is green, make sure request_deploy was called (see .newera/vm/deploy-request.json).",
  ];
  return parts.join("\n");
}

async function relayNow(step) {
  relayDispatched = true;
  const handoff = await buildHandoff(step);
  try {
    fs.mkdirSync(path.join(ROOT, ".newera", "vm"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, ".newera", "vm", "handoff.md"), handoff + "\n", "utf8");
  } catch (e) {}
  writeResultSummary("RELAYED to a fresh VM (relay " + (RELAY_INDEX + 1) + " of " + MAX_RELAYS + ") after " + step + " steps. All work is committed; the handoff brief is .newera/vm/handoff.md.");
  await gitCommitIfNeeded("agent: relay checkpoint (handoff + progress committed)");
  await reportRelay(handoff);
  log("[relay] handoff committed and reported — the control plane boots VM " + (RELAY_INDEX + 2) + " of " + (MAX_RELAYS + 1));
}

// ---------- system prompt ----------
const SYSTEM_PROMPT = [
  "You are NewEra VM Agent — an autonomous software engineer running with full access inside a real Ubuntu Linux VM (a GitHub Actions runner: 4 vCPU, 16 GB RAM, ~14 GB free disk).",
  "You have a real shell, a real filesystem, git, Node 20 + npm, and Python 3 + pip (python3, python3 -m pip) — all preinstalled on the runner. This is NOT a sandboxed browser: npm install, pip install, running tests and building the project all actually work.",
  "",
  "## SKILL PACK (bundled knowledge)",
  "A curated skill library is bundled in .newera/skills/ — stack playbooks (nextjs-app-router, react-vite-spa, node-express-api, flutter-web, python-project), UI style systems (style-bento, style-brutalism, style-clean, …) and craft rules (craft-anti-ai-slop, craft-color, craft-accessibility, …). Each encodes the scaffold commands, the build loop that converges, the failure→fix table and the static-output contract the deploy stage requires.",
  "RULE: before touching an unfamiliar stack, call list_skills, then read_skill the relevant stack skill. Before styling ANY user-facing page, read one style skill + craft-anti-ai-slop. This is not optional — it is the difference between a two-step scaffold and a forty-step spiral.",
  "",
  "## THE TASK",
  "Execute the build plan below against the repository in the current working directory. Build, fix and TEST the project for real. Leave the repository in a state where its own build passes.",
  "",
  "## WORK LOOP",
  "Every reply is EXACTLY ONE JSON object — no prose, no markdown fences:",
  '{"thought":"brief reasoning","action":{"tool":"<tool>","args":{...}}}',
  "or, when the task is genuinely done:",
  '{"thought":"...","final":"a complete summary: what was built, test/build results, anything unfinished"}',
  "",
  "## TOOLS",
  "- shell{command, timeout_minutes?} — run ANY bash command in the repo root (10 min default, 30 max). Use it for npm/pip install, builds, tests, git inspection, curl. Long-running commands report live progress automatically.",
  "- list_files{path?} — repository tree (4 levels deep).",
  "- list_skills{} — the bundled skill catalog (stacks, styles, craft).",
  "- read_skill{name, start?, end?} — one full skill doc, 500 lines per call.",
  "- read_file{path, start?, end?} — numbered lines, 400 per call.",
  "- write_file{path, content} — create/overwrite a file (UTF-8).",
  "- edit_file{path, find, replace, all?} — exact-string patch; unique match required unless all:true.",
  "- delete_file{path} — remove a file or directory.",
  "- spawn_agents{tasks:[{name, task, files?}]} — dispatch 1-6 PARALLEL sub-agents (3 run at once). Each is a full agent loop with its own context, its own file ownership and its own work/<name>/ scratch folder. Give each a complete, self-contained slice and disjoint file lists. Blocks until all finish; their summaries come back as your observation. Use it for genuinely parallel work (independent modules, assets, tests).",
  "- request_deploy{subdomain, mode?, build_output_path?} — after the build VERIFIABLY passes, request a Cloudflare Pages deploy for subdomain.newera.page.dev. Requires a real static output dir with index.html (out/, dist/, build/web/ …). The URL is delivered after this job ends — Cloudflare keys never enter this VM.",
  "- finish{summary} — task complete. Requires: dependencies installed, build/test commands actually run and passing (or the exact blocker documented).",
  "",
  "## RULES",
  "1. Start by looking around: list_files (a greenfield repo contains only .newera/ and .github/ — that is EXPECTED, you are building from scratch), list_skills, read_skill the stack skill for THIS task, then scaffold/install/build to get the REAL current state.",
  "2. Fix real errors reported by real tools. Never claim a fix without re-running the failing command.",
  "3. Do not git commit or push — the harness commits progress for you. Never modify .github/workflows/ or .newera/vm/. Skills in .newera/skills/ are reference docs — read them, do not edit or delete them.",
  "4. Do not leave long-running servers alive: background them, curl them, then kill them.",
  "5. Watch the clock — every observation ends with [N minutes left]. A relay checkpoint fires automatically ~15 min before the deadline: get in-flight work into FILES (not just your head) before then, so the next VM can pick it up.",
  "6. If a blocker cannot be resolved (missing API key, unfixable upstream), finish and state exactly what is blocked.",
  "7. Stay inside this repository: never touch anything outside it, never run destructive system-wide commands.",
  "8. Sub-agents are for PARALLEL slices with disjoint files. A job that is mostly sequential (one bug, one build) does not need them — do it yourself.",
  "9. Deploy only when the task brief authorizes it AND the build is green. Never request a deploy off a red or untested build.",
  "",
  "## QUALITY BAR",
  "Production-quality code. No placeholder stubs unless the plan asks for them. Run the project own test suite when present; otherwise add a minimal smoke test and run it.",
].join("\n");

// ---------- main loop ----------
async function main() {
  log("[boot] NewEra VM agent v2 — job " + JOB_ID + ", repo " + REPO + ", budget " + MAX_MINUTES + " min, relay " + RELAY_INDEX + "/" + MAX_RELAYS);
  if (!API || !TOKEN) {
    log("[fatal] missing NEWERA_API_URL or NEWERA_JOB_TOKEN");
    process.exit(2);
  }
  // CONTROL-PLANE REACHABILITY (fail fast, like a human SSH-ing in and
  // checking the network first): if this deployment cannot be reached from
  // GitHub (localhost / LAN URL, dead host, firewall), the OLD behavior was
  // 5 model retries with 280 s timeouts — ~25 silent minutes before the
  // runner gave up. Now: one 15 s probe, an explicit reason in the log
  // (surfaced by watch_vm_agent as a fast FAILED), exit immediately.
  try {
    await apiGet("/api/vm/jobs/" + encodeURIComponent(JOB_ID), 15000);
    log("[boot] control plane reachable at " + API);
  } catch (e) {
    log("[fatal] CONTROL PLANE UNREACHABLE at " + API + " — " + (e.message || e));
    log("[fatal] VM jobs need a PUBLIC NewEra deployment: GitHub Actions runners cannot reach localhost or LAN addresses.");
    process.exit(2);
  }
  const tree = [];
  listFilesTree(ROOT, 3, "", tree);
  const relayNote = RELAY_INDEX > 0
    ? "You are the CONTINUATION VM (relay " + RELAY_INDEX + " of " + MAX_RELAYS + "). The prior VM wrote .newera/vm/handoff.md — read it FIRST, verify the repo state, then continue the task. Do not redo finished work.\n\n"
    : "";
  const resumeNote = HANDOFF
    ? "You are a RESUMED session (the user asked to continue a finished job). The previous session left this handoff — obey it, verify the repo state with one fast command, then CONTINUE. Do not redo committed work.\n\n--- HANDOFF ---\n" + HANDOFF.slice(0, 8000) + "\n--- END HANDOFF ---\n\n"
    : "";
  const history = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: relayNote + resumeNote + "## BUILD PLAN / TASK\n" + TASK + "\n\n## REPOSITORY (top of tree)\n" + tree.slice(0, 200).join("\n") +
        "\n\nStart now. Remember: ONE JSON object per reply.",
    },
  ];

  let parseFailures = 0;
  let lastCommitStep = 0;
  let wroteSinceCommit = false;
  let step = 0;

  for (step = 1; step <= MAX_STEPS; step++) {
    const left = minutesLeft();

    // Relay checkpoint: stop STARTING new work, wrap up onto a fresh VM.
    // Fires once, only for long jobs (MAX_MINUTES >= RELAY_MIN_JOB_MINUTES)
    // that have not finished, and only while the chain has VMs left.
    if (
      !relayDispatched &&
      RELAY_INDEX < MAX_RELAYS &&
      MAX_MINUTES >= RELAY_MIN_JOB_MINUTES &&
      left <= RELAY_CHECKPOINT_MIN
    ) {
      log("[relay] checkpoint reached (" + left + " min left) — wrapping up for handoff");
      await relayNow(step);
      await reportFinal("RELAYED: the job needs more time than this VM has. A fresh VM continues from the committed handoff — keep watching the same job chain for the final result.", true);
      return;
    }

    if (Date.now() >= DEADLINE) {
      log("[deadline] time budget exhausted");
      // Write a handoff so the work is resumable even when the auto-relay
      // cannot fire (short budget / relay budget spent): resume_vm_agent
      // boots the next VM from exactly this document.
      const deadlineHandoff = await buildHandoff(step);
      try {
        fs.mkdirSync(path.join(ROOT, ".newera", "vm"), { recursive: true });
        fs.writeFileSync(path.join(ROOT, ".newera", "vm", "handoff.md"), deadlineHandoff + "\n", "utf8");
      } catch (e) {}
      const summary = "TIME LIMIT REACHED after " + step + " steps. All work so far is committed to the repo and packaged in the artifact; the handoff at .newera/vm/handoff.md carries the continuation plan.";
      await reportFinal(summary, true, deadlineHandoff);
      writeResultSummary(summary);
      await gitCommitIfNeeded("agent: checkpoint at time limit");
      return;
    }

    let raw = "";
    let modelError = null;
    let timeoutErrors = 0;
    // 5 attempts with growing backoff: a provider-side 429/503 burst must
    // not kill a job that has 20 minutes of budget left. Hard 4xx (auth,
    // schema) still abort immediately — retrying those is pointless. Three
    // consecutive TIMEOUTS also abort early: a hanging control plane or
    // provider is a structural fault, not a burst to wait out.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        raw = await callModel(history, "steps");
        modelError = null;
        break;
      } catch (err) {
        modelError = err;
        log("[model] attempt " + (attempt + 1) + " failed: " + err.message);
        var isTimeout = err && (err.name === "TimeoutError" || /aborted|timed out|timeout/i.test(String(err.message || "")));
        if (isTimeout) timeoutErrors++;
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) break;
        if (timeoutErrors >= 3) {
          log("[model] three timeouts — control plane or provider is hanging; aborting early instead of burning the budget.");
          break;
        }
        await new Promise(function (r) { setTimeout(r, 4000 * (attempt + 1)); });
      }
    }
    if (modelError) {
      await reportFinal("ABORTED: model proxy unreachable — " + modelError.message + " (control plane: " + API + ")", true);
      writeResultSummary("ABORTED: model proxy unreachable — " + modelError.message + " (control plane: " + API + ")");
      await gitCommitIfNeeded("agent: abort (model proxy unreachable)");
      process.exit(3);
    }

    const turn = parseTurn(raw);
    if (!turn) {
      parseFailures++;
      history.push({ role: "assistant", content: raw.slice(0, 2000) });
      history.push({
        role: "user",
        content: "PROTOCOL: your last reply was not a valid JSON envelope. Reply with EXACTLY one JSON object: {\"thought\":\"...\",\"action\":{\"tool\":\"...\",\"args\":{...}}} — no prose, no fences.",
      });
      if (parseFailures >= 4) {
        await reportFinal("ABORTED: model kept replying outside the JSON protocol.", true);
        writeResultSummary("ABORTED: model kept replying outside the JSON protocol after " + step + " steps.");
        await gitCommitIfNeeded("agent: abort (protocol)");
        return;
      }
      continue;
    }
    parseFailures = 0;

    if (turn.final) {
      log("[final] " + String(turn.final).slice(0, 400));
      await reportFinal(turn.final, false);
      writeResultSummary(turn.final);
      await gitCommitIfNeeded("agent: final state");
      return;
    }

    const action = turn.action || {};
    const toolName = String(action.tool || "");
    const args = action.args || {};
    // Pre-report the step BEFORE executing it: a 10-minute npm install then
    // shows up as "[step 7] shell — (executing…)" immediately, instead of
    // silence that looks exactly like a dead job. The shell tool also
    // heartbeats its last output line every 45 s while it runs.
    if (toolName !== "finish") {
      await reportProgress({
        step: step,
        lastTool: toolName,
        thought: String(turn.thought || "").slice(0, 300),
        lastResult: "(executing…)",
        ok: true,
        minutesLeft: left,
      });
    }
    let result;
    try {
      if (toolName === "shell") result = await toolShell(args, step);
      else if (toolName === "list_files") result = toolListFiles(args);
      else if (toolName === "list_skills") result = toolListSkills();
      else if (toolName === "read_skill") result = toolReadSkill(args);
      else if (toolName === "read_file") result = toolReadFile(args);
      else if (toolName === "write_file") { result = toolWriteFile(args); wroteSinceCommit = true; }
      else if (toolName === "edit_file") { result = toolEditFile(args); wroteSinceCommit = true; }
      else if (toolName === "delete_file") { result = toolDeleteFile(args); wroteSinceCommit = true; }
      else if (toolName === "spawn_agents") { result = await toolSpawnAgents(args, step); wroteSinceCommit = true; }
      else if (toolName === "request_deploy") result = await toolRequestDeploy(args);
      else if (toolName === "finish") {
        const summary = String(args.summary || "done");
        await reportFinal(summary, false);
        writeResultSummary(summary);
        await gitCommitIfNeeded("agent: final state");
        return;
      }
      else result = { ok: false, output: "unknown tool: " + toolName + " — available: shell, list_files, list_skills, read_skill, read_file, write_file, edit_file, delete_file, spawn_agents, request_deploy, finish" };
    } catch (err) {
      result = { ok: false, output: "tool error: " + (err.message || String(err)) };
    }

    log("[step " + step + "] " + toolName + " -> " + (result.ok ? "ok" : "FAILED"));
    await reportProgress({
      step: step,
      lastTool: toolName,
      thought: String(turn.thought || "").slice(0, 300),
      lastResult: String(result.output || "").slice(0, 500),
      ok: result.ok,
      minutesLeft: left,
    });

    history.push({
      role: "assistant",
      content: JSON.stringify({ thought: String(turn.thought || "").slice(0, 600), action: { tool: toolName, args: compactArgs(args) } }),
    });
    history.push({
      role: "user",
      content: "[" + toolName + (result.ok ? " ok" : " FAILED") + "]\n" + String(result.output || "") + "\n\n[" + left + " minutes left | step " + step + "/" + MAX_STEPS + "]",
    });

    // Rolling compaction — long jobs keep their memory instead of degrading.
    await compactHistory(history);

    if ((wroteSinceCommit && step - lastCommitStep >= 8) || step - lastCommitStep >= 25) {
      await gitCommitIfNeeded("agent progress: step " + step);
      lastCommitStep = step;
      wroteSinceCommit = false;
    }
  }

  const stepSummary = "STEP LIMIT reached (" + MAX_STEPS + " steps). Work so far is committed and packaged; the handoff at .newera/vm/handoff.md carries the continuation plan.";
  const stepHandoff = await buildHandoff(MAX_STEPS);
  await reportFinal(stepSummary, true, stepHandoff);
  try {
    fs.mkdirSync(path.join(ROOT, ".newera", "vm"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, ".newera", "vm", "handoff.md"), stepHandoff + "\n", "utf8");
  } catch (e) {}
  writeResultSummary(stepSummary);
  await gitCommitIfNeeded("agent: step limit checkpoint");
}

function compactArgs(args) {
  const out = {};
  for (const k of Object.keys(args || {})) {
    const v = args[k];
    if (typeof v === "string" && v.length > 300) out[k] = v.slice(0, 200) + "…(" + v.length + " chars)";
    else out[k] = v;
  }
  return out;
}

main().then(function () {
  log("[boot] agent loop finished");
  process.exit(0);
}).catch(function (err) {
  log("[fatal] " + (err.stack || err.message || String(err)));
  reportFinal("CRASHED: " + (err.message || String(err)), true);
  writeResultSummary("CRASHED: " + (err.stack || err.message || String(err)));
  gitCommitIfNeeded("agent: crash checkpoint").finally(function () { process.exit(1); });
});