// ============================================================
// claude-sessions v2 — sidebar restored, date-grouped, pinning
// ============================================================

const STORAGE = "cs:v2";

// ============================================================
// State
// ============================================================
const sessions = new Map();
const pinned = new Set();           // session ids pinned by user
let visibleIds = [];
let selectedId = null;
let transcriptExpanded = false;
let paletteOpen = false;
let paletteQuery = "";
let paletteCursor = 0;
let paletteRows = [];
let helpOpen = false;

const filters = {
  state: "all",   // "all" | "live" | "waiting"
  repos: new Set(),
  search: "",
};

// ============================================================
// DOM
// ============================================================
const $ = id => document.getElementById(id);

const sidebar      = $("sidebar");
const sbList       = $("sb-list");
const sbEmpty      = $("sb-empty");
const searchEl     = $("search");
const chipsEl      = $("chips");
const scopeCountEl = $("scope-count");
const collapseBtn  = $("collapse-btn");
const resizeEl     = $("sb-resize");
const emptyClear   = $("empty-clear");

const detailEl     = $("detail");
const emptyMain    = $("empty-main");

const paletteEl    = $("palette");
const paletteScrim = $("palette-scrim");
const paletteInput = $("palette-input");
const paletteResults = $("palette-results");

const helpEl       = $("help");
const helpScrim    = $("help-scrim");

const repoBtn      = $("repo-btn");
const repoLabel    = $("repo-label");
const repoMenu     = $("repo-menu");
const repoWrap     = $("repo-dropdown");

// ============================================================
// Helpers
// ============================================================
function esc(s) {
  return (s ?? "").toString().replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
}

function fmtAge(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const s = ms / 1000;
  if (s < 5) return "now";
  if (s < 60)    return `${Math.floor(s)}s`;
  if (s < 3600)  return `${Math.floor(s/60)}m`;
  if (s < 86400) return `${Math.floor(s/3600)}h`;
  if (s < 86400*7)  return `${Math.floor(s/86400)}d`;
  if (s < 86400*28) return `${Math.floor(s/86400/7)}w`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(1)} MB`;
}

function topicOf(s) {
  return (s.firstUserMessage || s.lastUserMessage || "").replace(/\s+/g, " ").trim();
}

function truncate(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + "…"; }

function rowKind(s) {
  if (!s.live) return "exited";
  return s.state || "idle";
}

function matchesSearch(s, q) {
  if (!q) return true;
  const lc = q.toLowerCase();
  return (s.project || "").toLowerCase().includes(lc)
      || (s.cwd || "").toLowerCase().includes(lc)
      || (s.gitBranch || "").toLowerCase().includes(lc)
      || (s.firstUserMessage || "").toLowerCase().includes(lc)
      || (s.lastUserMessage || "").toLowerCase().includes(lc)
      || (s.lastAssistantText || "").toLowerCase().includes(lc);
}

function passesFilters(s) {
  if (filters.state === "live" && !s.live) return false;
  if (filters.state === "waiting" && (!s.live || s.state !== "waiting_user")) return false;
  if (filters.repos.size > 0 && !filters.repos.has(s.project || "")) return false;
  if (!matchesSearch(s, filters.search)) return false;
  return true;
}

// ChatGPT-style date buckets — Today / Yesterday / Last 7d / Last 30d / Older
function dateBucket(iso) {
  if (!iso) return "older";
  const now = new Date();
  const d   = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYest  = startOfToday - 86400_000;
  const t = d.getTime();
  if (t >= startOfToday) return "today";
  if (t >= startOfYest)  return "yesterday";
  if (t >= startOfToday - 7  * 86400_000) return "last7";
  if (t >= startOfToday - 30 * 86400_000) return "last30";
  return "older";
}

const BUCKET_LABEL = {
  today:     "Today",
  yesterday: "Yesterday",
  last7:     "Previous 7 days",
  last30:    "Previous 30 days",
  older:     "Older",
};
const BUCKET_ORDER = ["today", "yesterday", "last7", "last30", "older"];

// ============================================================
// Persistence
// ============================================================
function persist() {
  try {
    localStorage.setItem(STORAGE, JSON.stringify({
      state: filters.state,
      repos: [...filters.repos],
      pinned: [...pinned],
      sidebarW: parseInt(getComputedStyle(document.body).getPropertyValue("--sidebar-w")) || 280,
      collapsed: document.body.classList.contains("sidebar-collapsed"),
    }));
  } catch {}
}
function restore() {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return;
    const j = JSON.parse(raw);
    if (typeof j.state === "string") filters.state = j.state;
    filters.repos = new Set(j.repos || []);
    for (const id of (j.pinned || [])) pinned.add(id);
    if (j.sidebarW && j.sidebarW > 160 && j.sidebarW < 600) {
      document.body.style.setProperty("--sidebar-w", `${j.sidebarW}px`);
    }
    if (j.collapsed) document.body.classList.add("sidebar-collapsed");
  } catch {}
}

// ============================================================
// Sidebar render
// ============================================================
function renderSidebar() {
  const all = [...sessions.values()].filter(passesFilters);
  all.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  // Partition: pinned section + date buckets
  const pinnedRows = [];
  const buckets = {};
  for (const k of BUCKET_ORDER) buckets[k] = [];

  for (const s of all) {
    if (pinned.has(s.id)) {
      pinnedRows.push(s);
    } else {
      buckets[dateBucket(s.lastActivity)].push(s);
    }
  }

  visibleIds = [
    ...pinnedRows.map(s => s.id),
    ...BUCKET_ORDER.flatMap(k => buckets[k].map(s => s.id)),
  ];

  if (visibleIds.length === 0) {
    sbList.innerHTML = "";
    sbEmpty.classList.remove("hidden");
    updateCounts();
    return;
  }
  sbEmpty.classList.add("hidden");

  const parts = [];
  if (pinnedRows.length > 0) parts.push(sectionHTML("Pinned", pinnedRows, true));
  for (const k of BUCKET_ORDER) {
    if (buckets[k].length > 0) parts.push(sectionHTML(BUCKET_LABEL[k], buckets[k], false));
  }
  sbList.innerHTML = parts.join("");

  // Re-select
  if (selectedId) {
    const row = sbList.querySelector(`[data-id="${CSS.escape(selectedId)}"]`);
    if (row) row.setAttribute("aria-selected", "true");
  }

  updateCounts();
}

function sectionHTML(label, items, isPinned) {
  return `
    <div class="sb-section${isPinned ? " pinned" : ""}">
      <div class="sb-section-head">
        <span>${esc(label)}</span>
        <span class="sb-section-count">${items.length}</span>
      </div>
      ${items.map(rowHTML).join("")}
    </div>
  `;
}

const PIN_ICON_FILLED = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M16 4l4 4-5 1-3 3-1 5-4-4-5 1 1-5-4-4 5-1 4-4z"/></svg>';
const PIN_ICON_OUTLINE = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 17v5M9 10.76V6h-.5a1 1 0 0 1 0-2H15.5a1 1 0 0 1 0 2H15v4.76l3 4.24v2H6v-2z"/></svg>';

function rowHTML(s) {
  const kind = rowKind(s);
  const topic = topicOf(s);
  const isPinned = pinned.has(s.id);

  const topicHTML = topic
    ? `<span class="sb-topic">${esc(truncate(topic, 70))}</span>`
    : `<span class="sb-topic placeholder">(no prompts yet)</span>`;

  const branch = s.gitBranch && s.gitBranch !== "HEAD" ? s.gitBranch : "";
  const tooltip = [topic, branch ? `${s.project} / ${branch}` : (s.project || ""), s.cwd || ""].filter(Boolean).join("\n");

  return `
    <div class="sb-row ${kind}${isPinned ? " pinned" : ""}" role="option" data-id="${esc(s.id)}" tabindex="-1" title="${esc(tooltip)}">
      <span class="sb-dot"></span>
      ${topicHTML}
      <button class="sb-pin-btn" data-pin="${esc(s.id)}" title="${isPinned ? "Unpin" : "Pin"}" aria-label="${isPinned ? "Unpin" : "Pin"}">${isPinned ? PIN_ICON_FILLED : PIN_ICON_OUTLINE}</button>
      <span class="sb-age">${fmtAge(s.lastActivity)}</span>
    </div>
  `;
}

function patchRow(s) {
  const row = sbList.querySelector(`[data-id="${CSS.escape(s.id)}"]`);
  if (!row) return false;
  row.classList.remove("running","thinking","waiting","idle","exited");
  row.classList.add(rowKind(s));

  const topicEl = row.querySelector(".sb-topic");
  const topic = topicOf(s);
  if (topicEl) {
    if (topic) { topicEl.classList.remove("placeholder"); topicEl.textContent = truncate(topic, 70); }
    else       { topicEl.classList.add("placeholder");    topicEl.textContent = "(no prompts yet)"; }
  }
  const ageEl = row.querySelector(".sb-age");
  if (ageEl) ageEl.textContent = fmtAge(s.lastActivity);
  return true;
}

function updateCounts() {
  const counts = { all: 0, live: 0, waiting: 0 };
  for (const s of sessions.values()) {
    counts.all++;
    if (s.live) {
      counts.live++;
      if (s.state === "waiting_user") counts.waiting++;
    }
  }
  for (const el of chipsEl.querySelectorAll(".chip-count")) {
    const k = el.dataset.count;
    if (k in counts) el.textContent = counts[k];
  }
  scopeCountEl.textContent = counts.live;
}

function renderChips() {
  for (const btn of chipsEl.querySelectorAll(".chip[data-chip]")) {
    const k = btn.dataset.chip;
    btn.classList.toggle("active", filters.state === k);
    btn.setAttribute("aria-pressed", String(filters.state === k));
  }
  if (filters.repos.size > 0) {
    repoWrap.dataset.active = "true";
    repoLabel.textContent = filters.repos.size === 1 ? truncate([...filters.repos][0], 12) : `${filters.repos.size}`;
  } else {
    repoWrap.dataset.active = "false";
    repoLabel.textContent = "Repo";
  }
}

function renderRepoMenu() {
  const byRepo = new Map();
  for (const s of sessions.values()) {
    const k = s.project || "(no project)";
    byRepo.set(k, (byRepo.get(k) || 0) + 1);
  }
  const sorted = [...byRepo.entries()].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const html = [];
  if (filters.repos.size > 0) html.push(`<div class="repo-opt-clear" data-action="clear">Clear repo filter</div>`);
  for (const [repo, n] of sorted) {
    const checked = filters.repos.has(repo);
    html.push(`
      <label class="repo-opt">
        <input type="checkbox" ${checked ? "checked" : ""} data-repo="${esc(repo)}" />
        <span>${esc(repo)}</span>
        <span class="repo-opt-count">${n}</span>
      </label>
    `);
  }
  repoMenu.innerHTML = html.join("");
  for (const cb of repoMenu.querySelectorAll("input[data-repo]")) {
    cb.addEventListener("change", e => {
      const r = e.target.dataset.repo;
      if (e.target.checked) filters.repos.add(r); else filters.repos.delete(r);
      persist(); renderChips(); renderSidebar();
    });
  }
  const clear = repoMenu.querySelector('[data-action="clear"]');
  if (clear) clear.addEventListener("click", () => {
    filters.repos.clear(); persist(); renderChips(); renderRepoMenu(); renderSidebar();
  });
}

// ============================================================
// Detail
// ============================================================
function selectAndOpen(id) {
  selectedId = id;
  for (const row of sbList.querySelectorAll(".sb-row")) {
    row.setAttribute("aria-selected", row.dataset.id === id ? "true" : "false");
  }
  renderDetail();
}

function moveSelection(delta) {
  if (visibleIds.length === 0) return;
  let idx = selectedId ? visibleIds.indexOf(selectedId) : -1;
  idx = Math.max(0, Math.min(visibleIds.length - 1, idx + delta));
  if (idx < 0) idx = 0;
  const id = visibleIds[idx];
  selectedId = id;
  for (const row of sbList.querySelectorAll(".sb-row")) {
    row.setAttribute("aria-selected", row.dataset.id === id ? "true" : "false");
  }
  const row = sbList.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
  renderDetail();
}

function stateChipHTML(s) {
  const map = {
    running_tool: { c: "running",  l: "Running tool" },
    thinking:     { c: "thinking", l: "Thinking" },
    waiting_user: { c: "waiting",  l: "Waiting for input" },
    idle:         { c: "idle",     l: "Idle" },
  };
  const item = s.live ? (map[s.state] || map.idle) : { c: "exited", l: "Exited" };
  return `<span class="state-chip ${item.c}"><span class="state-chip-dot"></span>${item.l}</span>`;
}

function renderDetail() {
  const s = sessions.get(selectedId);
  if (!s) {
    detailEl.classList.add("hidden");
    emptyMain.classList.remove("hidden");
    return;
  }
  emptyMain.classList.add("hidden");
  detailEl.classList.remove("hidden");

  const branch = s.gitBranch && s.gitBranch !== "HEAD" ? s.gitBranch : "—";
  const topic = topicOf(s);
  const isPinned = pinned.has(s.id);

  detailEl.innerHTML = `
    <div class="detail-head">
      <div class="detail-title-row">
        <span class="detail-project">${esc(s.project || "(no project)")}</span>
        <span class="detail-branch">${esc(branch)}</span>
        ${stateChipHTML(s)}
        <button class="btn-tonal" id="pin-toggle" style="margin-left:auto">${isPinned ? "Unpin" : "Pin"}</button>
      </div>
      <div class="detail-cwd">${esc(s.cwd || "")}</div>
    </div>

    <div class="section">
      <h3>Topic</h3>
      <div class="summary-card ${topic ? "" : "placeholder"}">${esc(topic || "(no user messages yet)")}</div>
      <div class="metric-row">
        <div class="metric"><div class="metric-value">${fmtAge(s.lastActivity)}</div><div class="metric-label">Last activity</div></div>
        <div class="metric"><div class="metric-value">${fmtAge(s.startedAt)}</div><div class="metric-label">Started</div></div>
        <div class="metric"><div class="metric-value">${s.messageCount}</div><div class="metric-label">Messages</div></div>
        <div class="metric"><div class="metric-value">${s.userMessageCount}</div><div class="metric-label">User turns</div></div>
      </div>
    </div>

    <div class="section">
      <h3>Metadata</h3>
      <dl class="kv-list">
        <div class="kv"><dt>Session ID</dt><dd>${esc(s.id)}</dd><dd></dd></div>
        <div class="kv"><dt>Last tool</dt><dd>${esc(s.lastToolName || "—")}</dd><dd></dd></div>
        <div class="kv"><dt>Permission</dt><dd>${esc(s.permissionMode || "—")}</dd><dd></dd></div>
        <div class="kv"><dt>Claude version</dt><dd>${esc(s.version || "—")}</dd><dd></dd></div>
        <div class="kv"><dt>JSONL size</dt><dd>${fmtBytes(s.sizeBytes)}</dd><dd></dd></div>
        <div class="kv"><dt>Resume</dt><dd><code style="background:var(--surface-hi);padding:2px 6px;border-radius:4px;font-size:11px;">claude --resume ${esc(s.id)}</code></dd><dd><button class="btn-tonal" id="copy-resume">Copy</button></dd></div>
      </dl>
    </div>

    <div class="section">
      <div class="transcript-head">
        <h3>Conversation</h3>
        <div class="segmented">
          <button id="seg-recent" class="${transcriptExpanded ? "" : "active"}">Last 4</button>
          <button id="seg-all"    class="${transcriptExpanded ? "active" : ""}">Full</button>
        </div>
      </div>
      <div id="transcript"><p style="color:var(--text-mute);font-size:12px;">Loading…</p></div>
    </div>
  `;

  $("copy-resume").addEventListener("click", () => {
    navigator.clipboard.writeText(`claude --resume ${s.id}`);
    const b = $("copy-resume");
    b.textContent = "Copied";
    setTimeout(() => { b.textContent = "Copy"; }, 1200);
  });

  $("pin-toggle").addEventListener("click", () => togglePin(s.id));
  $("seg-recent").addEventListener("click", () => { transcriptExpanded = false; renderDetail(); });
  $("seg-all").addEventListener("click",    () => { transcriptExpanded = true;  renderDetail(); });

  loadTranscript(s.id);
}

async function loadTranscript(id) {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/transcript`);
    const turns = await r.json();
    if (id !== selectedId) return;
    const el = $("transcript");
    if (!turns || turns.length === 0) {
      el.innerHTML = `<p style="color:var(--text-mute);font-size:12px;">No turns yet.</p>`;
      return;
    }
    const slice = transcriptExpanded ? turns : turns.slice(-4);
    el.innerHTML = slice.map(t => `
      <div class="turn ${t.role}">
        <div class="turn-head"><span>${t.role}</span><span class="turn-time">${fmtAge(t.timestamp)}</span></div>
        ${t.text ? `<div class="turn-text">${esc(t.text)}</div>` : ""}
        ${t.toolName ? `<div class="turn-tool">↳ ${esc(t.toolName)}</div>` : ""}
      </div>
    `).join("");
  } catch {
    const el = $("transcript");
    if (el) el.innerHTML = `<p style="color:var(--text-mute);font-size:12px;">Failed to load transcript.</p>`;
  }
}

// ============================================================
// Pinning
// ============================================================
function togglePin(id) {
  if (pinned.has(id)) pinned.delete(id);
  else pinned.add(id);
  persist();
  renderSidebar();
  if (selectedId === id) renderDetail();
}

// ============================================================
// Command palette
// ============================================================
function openPalette() {
  paletteOpen = true;
  paletteEl.classList.remove("hidden");
  paletteScrim.classList.remove("hidden");
  paletteInput.value = "";
  paletteQuery = "";
  paletteCursor = 0;
  renderPalette();
  paletteInput.focus();
}
function closePalette() {
  paletteOpen = false;
  paletteEl.classList.add("hidden");
  paletteScrim.classList.add("hidden");
}

function parsePaletteQuery(q) {
  const tokens = q.trim().split(/\s+/);
  const out = { isLive: null, isWaiting: null, isExited: null, repo: null, words: [] };
  for (const t of tokens) {
    if (!t) continue;
    const m = /^([a-z]+):(.+)$/i.exec(t);
    if (!m) { out.words.push(t.toLowerCase()); continue; }
    const k = m[1].toLowerCase(), v = m[2].toLowerCase();
    if (k === "is") {
      if (v === "live") out.isLive = true;
      if (v === "waiting") { out.isLive = true; out.isWaiting = true; }
      if (v === "exited") out.isExited = true;
    } else if (k === "repo") out.repo = v;
    else out.words.push(t.toLowerCase());
  }
  return out;
}

function paletteScore(s, parsed) {
  if (parsed.isLive    && !s.live) return -1;
  if (parsed.isWaiting && s.state !== "waiting_user") return -1;
  if (parsed.isExited  && s.live) return -1;
  if (parsed.repo      && !(s.project || "").toLowerCase().includes(parsed.repo)) return -1;
  if (parsed.words.length === 0) return 1;
  let score = 0;
  const hay = [s.project, s.gitBranch, s.cwd, s.firstUserMessage, s.lastUserMessage, s.lastAssistantText].filter(Boolean).join(" ").toLowerCase();
  for (const w of parsed.words) {
    if (!hay.includes(w)) return -1;
    score += w.length;
  }
  return score;
}

function renderPalette() {
  const parsed = parsePaletteQuery(paletteQuery);
  const ranked = [];
  for (const s of sessions.values()) {
    const sc = paletteScore(s, parsed);
    if (sc < 0) continue;
    ranked.push({ s, sc });
  }
  ranked.sort((a, b) => b.sc - a.sc || new Date(b.s.lastActivity) - new Date(a.s.lastActivity));
  const top = ranked.slice(0, 20).map(r => r.s);

  paletteRows = top.map(s => ({ type: "session", id: s.id, s }));

  if (!paletteQuery.trim()) {
    paletteRows.push({ type: "action", id: "act-pin",    label: selectedId && pinned.has(selectedId) ? "Unpin selected" : "Pin selected", hint: "p" });
    paletteRows.push({ type: "action", id: "act-toggle-live",   label: filters.state === "live" ? "Show all" : "Show live only", hint: "is:live" });
    paletteRows.push({ type: "action", id: "act-clear",  label: "Clear filters", hint: "" });
    paletteRows.push({ type: "action", id: "act-help",   label: "Show keyboard shortcuts", hint: "?" });
  }

  if (paletteRows.length === 0) {
    paletteResults.innerHTML = `<div class="palette-empty">No matches</div>`;
    return;
  }

  paletteCursor = Math.min(paletteCursor, paletteRows.length - 1);
  let html = "";
  let lastType = null;
  paletteRows.forEach((row, i) => {
    if (row.type !== lastType) {
      html += `<div class="palette-section-head">${row.type === "session" ? "Sessions" : "Actions"}</div>`;
      lastType = row.type;
    }
    if (row.type === "session") {
      const s = row.s;
      const kind = rowKind(s);
      const topic = topicOf(s) || "(no prompts yet)";
      const meta = [s.project, s.gitBranch && s.gitBranch !== "HEAD" ? s.gitBranch : ""].filter(Boolean).join(" / ");
      html += `
        <div class="palette-row ${kind} ${i === paletteCursor ? "active" : ""}" data-idx="${i}">
          <span class="palette-dot"></span>
          <span class="palette-title">${esc(truncate(topic, 60))}</span>
          <span class="palette-sub">${esc(meta)}</span>
          <span class="palette-kbd">${fmtAge(s.lastActivity)}</span>
        </div>
      `;
    } else {
      html += `
        <div class="palette-row ${i === paletteCursor ? "active" : ""}" data-idx="${i}">
          <span></span>
          <span class="palette-title">${esc(row.label)}</span>
          <span class="palette-sub">${esc(row.hint || "")}</span>
          <span></span>
        </div>
      `;
    }
  });
  paletteResults.innerHTML = html;

  for (const r of paletteResults.querySelectorAll(".palette-row")) {
    r.addEventListener("click", () => { paletteCursor = +r.dataset.idx; paletteExecute(); });
    r.addEventListener("mouseenter", () => {
      paletteCursor = +r.dataset.idx;
      for (const x of paletteResults.querySelectorAll(".palette-row")) x.classList.remove("active");
      r.classList.add("active");
    });
  }
}

function paletteMove(delta) {
  if (paletteRows.length === 0) return;
  paletteCursor = (paletteCursor + delta + paletteRows.length) % paletteRows.length;
  for (const [i, r] of [...paletteResults.querySelectorAll(".palette-row")].entries()) {
    r.classList.toggle("active", i === paletteCursor);
    if (i === paletteCursor) r.scrollIntoView({ block: "nearest" });
  }
}

function paletteExecute() {
  const row = paletteRows[paletteCursor];
  if (!row) return;
  if (row.type === "session") { closePalette(); selectAndOpen(row.id); return; }
  switch (row.id) {
    case "act-pin": if (selectedId) togglePin(selectedId); break;
    case "act-toggle-live":
      filters.state = filters.state === "live" ? "all" : "live";
      persist(); renderChips(); renderSidebar(); break;
    case "act-clear":
      filters.state = "all"; filters.repos.clear(); filters.search = ""; searchEl.value = "";
      persist(); renderChips(); renderRepoMenu(); renderSidebar(); break;
    case "act-help": closePalette(); openHelp(); return;
  }
  closePalette();
}

// ============================================================
// Help
// ============================================================
function openHelp()  { helpOpen = true;  helpEl.classList.remove("hidden"); helpScrim.classList.remove("hidden"); }
function closeHelp() { helpOpen = false; helpEl.classList.add("hidden");    helpScrim.classList.add("hidden"); }

// ============================================================
// Sidebar collapse + resize
// ============================================================
function toggleSidebar() {
  document.body.classList.toggle("sidebar-collapsed");
  persist();
}

let resizing = false;
resizeEl.addEventListener("mousedown", e => {
  resizing = true;
  document.body.classList.add("resizing");
  e.preventDefault();
});
document.addEventListener("mousemove", e => {
  if (!resizing) return;
  const w = Math.max(200, Math.min(540, e.clientX));
  document.body.style.setProperty("--sidebar-w", `${w}px`);
});
document.addEventListener("mouseup", () => {
  if (!resizing) return;
  resizing = false;
  document.body.classList.remove("resizing");
  persist();
});

// ============================================================
// Event wiring
// ============================================================
chipsEl.addEventListener("click", e => {
  const btn = e.target.closest(".chip[data-chip]");
  if (!btn) return;
  const k = btn.dataset.chip;
  filters.state = (filters.state === k && k !== "all") ? "all" : k;
  persist(); renderChips(); renderSidebar();
});

repoBtn.addEventListener("click", e => {
  e.stopPropagation();
  repoMenu.classList.toggle("hidden");
  repoBtn.setAttribute("aria-expanded", String(!repoMenu.classList.contains("hidden")));
});
document.addEventListener("click", e => {
  if (!repoWrap.contains(e.target)) {
    repoMenu.classList.add("hidden");
    repoBtn.setAttribute("aria-expanded", "false");
  }
});

searchEl.addEventListener("input", e => {
  filters.search = e.target.value.trim();
  renderSidebar();
});

sbList.addEventListener("click", e => {
  const pinBtn = e.target.closest(".sb-pin-btn");
  if (pinBtn) { e.stopPropagation(); togglePin(pinBtn.dataset.pin); return; }
  const row = e.target.closest(".sb-row");
  if (row) selectAndOpen(row.dataset.id);
});

collapseBtn.addEventListener("click", toggleSidebar);
emptyClear.addEventListener("click", () => {
  filters.state = "all"; filters.repos.clear(); filters.search = ""; searchEl.value = "";
  persist(); renderChips(); renderRepoMenu(); renderSidebar();
});

paletteInput.addEventListener("input", e => {
  paletteQuery = e.target.value;
  paletteCursor = 0;
  renderPalette();
});
paletteScrim.addEventListener("click", closePalette);
helpScrim.addEventListener("click", closeHelp);

// Global keyboard
document.addEventListener("keydown", e => {
  const inField = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";

  if (paletteOpen) {
    if (e.key === "Escape")    { e.preventDefault(); closePalette(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); paletteMove(1); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); paletteMove(-1); return; }
    if (e.key === "Enter")     { e.preventDefault(); paletteExecute(); return; }
    return;
  }
  if (helpOpen) {
    if (e.key === "Escape") closeHelp();
    return;
  }

  // Global shortcuts
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === "\\")              { e.preventDefault(); toggleSidebar(); return; }

  if (inField) {
    if (e.key === "Escape" && e.target === searchEl) {
      searchEl.value = ""; filters.search = ""; renderSidebar(); searchEl.blur();
    }
    return;
  }

  if (e.key === "/") { e.preventDefault(); searchEl.focus(); return; }
  if (e.key === "?") { e.preventDefault(); openHelp(); return; }
  if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); moveSelection(1);  return; }
  if (e.key === "ArrowUp"   || e.key === "k") { e.preventDefault(); moveSelection(-1); return; }
  if (e.key === "Enter" && selectedId) { e.preventDefault(); selectAndOpen(selectedId); return; }
  if (e.key.toLowerCase() === "p" && selectedId) { e.preventDefault(); togglePin(selectedId); return; }
  if (e.key.toLowerCase() === "c" && selectedId) {
    e.preventDefault();
    navigator.clipboard.writeText(`claude --resume ${selectedId}`);
    return;
  }
});

// ============================================================
// SSE
// ============================================================
function onUpsert(s) {
  const existing = sessions.get(s.id);
  sessions.set(s.id, s);
  if (!existing
      || existing.live !== s.live
      || existing.state !== s.state
      || existing.project !== s.project
      || dateBucket(existing.lastActivity) !== dateBucket(s.lastActivity)) {
    renderSidebar();
    renderRepoMenu();
  } else {
    patchRow(s);
    updateCounts();
  }
  if (selectedId === s.id) renderDetail();
}

function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("upsert", e => onUpsert(JSON.parse(e.data)));
  es.addEventListener("delete", e => {
    const { id } = JSON.parse(e.data);
    sessions.delete(id);
    if (pinned.has(id)) { pinned.delete(id); persist(); }
    if (selectedId === id) { selectedId = null; renderDetail(); }
    renderSidebar();
    renderRepoMenu();
  });
  es.addEventListener("snapshot-done", () => {
    renderSidebar();
    renderRepoMenu();
  });
}

// Refresh "ago" labels every 30s without re-sorting the list
setInterval(() => {
  for (const row of sbList.querySelectorAll(".sb-row")) {
    const s = sessions.get(row.dataset.id);
    if (!s) continue;
    const ageEl = row.querySelector(".sb-age");
    if (ageEl) ageEl.textContent = fmtAge(s.lastActivity);
  }
  if (selectedId) {
    const vals = detailEl.querySelectorAll(".metric-value");
    const s = sessions.get(selectedId);
    if (s && vals.length >= 2) {
      vals[0].textContent = fmtAge(s.lastActivity);
      vals[1].textContent = fmtAge(s.startedAt);
    }
  }
}, 30000);

// ============================================================
// Boot
// ============================================================
restore();
renderChips();
renderSidebar();
connect();
