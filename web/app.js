// ============================================================
// claude-sessions v1
// One list. One drawer. Every action a keystroke away.
// ============================================================

const STORAGE = "cs:v1";

// ============================================================
// State
// ============================================================
const sessions = new Map();   // id -> session
let visibleIds = [];          // ordered list IDs currently in DOM
let selectedId = null;
let drawerOpen = false;
let drawerSplit = false;
let paletteOpen = false;
let paletteQuery = "";
let paletteCursor = 0;
let paletteRows = [];         // current rows in the palette
let helpOpen = false;
let transcriptExpanded = false;

const filters = {
  live: true,                 // default: Live ON
  waiting: false,
  exited: false,
  repos: new Set(),           // selected repo names (empty = all)
  search: "",                 // top-bar search query
};

// ============================================================
// DOM
// ============================================================
const $ = id => document.getElementById(id);

const listEl       = $("list");
const emptyEl      = $("empty-state");
const emptyClearBtn= $("empty-clear");
const searchEl     = $("search");
const chipsEl      = $("chips");
const scopePill    = $("scope-pill");
const scopeCountEl = $("scope-count");
const helpBtn      = $("help-btn");

const drawerEl     = $("drawer");
const drawerTitle  = $("drawer-title");
const drawerSub    = $("drawer-sub");
const drawerBody   = $("drawer-body");
const drawerClose  = $("drawer-close");
const drawerExpand = $("drawer-expand");

const paletteEl    = $("palette");
const paletteScrim = $("palette-scrim");
const paletteInput = $("palette-input");
const paletteResults= $("palette-results");

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
  if (s < 60)   return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s/60)}m`;
  if (s < 86400)return `${Math.floor(s/3600)}h`;
  if (s < 86400*7)  return `${Math.floor(s/86400)}d`;
  if (s < 86400*28) return `${Math.floor(s/86400/7)}w`;
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(1)} MB`;
}

function rowKind(s) {
  if (!s.live) return "exited";
  return s.state || "idle";
}

function topicOf(s) {
  return (s.firstUserMessage || s.lastUserMessage || "").replace(/\s+/g, " ").trim();
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function matches(s, q) {
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
  const anyStateFilter = filters.live || filters.waiting || filters.exited;
  if (anyStateFilter) {
    let pass = false;
    if (filters.live    && s.live) pass = true;
    if (filters.waiting && s.live && s.state === "waiting_user") pass = true;
    if (filters.exited  && !s.live) pass = true;
    if (!pass) return false;
  }
  if (filters.repos.size > 0 && !filters.repos.has(s.project || "")) return false;
  if (!matches(s, filters.search)) return false;
  return true;
}

function anyFilterActive() {
  // "Live default" is the baseline; if only Live is true and nothing else, treat as default scope
  return filters.waiting || filters.exited
      || filters.repos.size > 0
      || filters.search.length > 0
      || !filters.live;   // user turned off Live
}

function clearAllFilters() {
  filters.live = true;
  filters.waiting = false;
  filters.exited = false;
  filters.repos.clear();
  filters.search = "";
  searchEl.value = "";
  persist();
  renderChips();
  renderRepoMenu();
  renderList();
  updateScopePill();
}

// ============================================================
// Persistence
// ============================================================
function persist() {
  try {
    localStorage.setItem(STORAGE, JSON.stringify({
      live: filters.live,
      waiting: filters.waiting,
      exited: filters.exited,
      repos: [...filters.repos],
    }));
  } catch {}
}
function restore() {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return;
    const j = JSON.parse(raw);
    filters.live    = !!j.live;
    filters.waiting = !!j.waiting;
    filters.exited  = !!j.exited;
    filters.repos   = new Set(j.repos || []);
  } catch {}
}

// ============================================================
// Render: list
// ============================================================
function renderList() {
  const all = [...sessions.values()].filter(passesFilters);
  all.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  visibleIds = all.map(s => s.id);
  listEl.innerHTML = all.map(rowHTML).join("");

  if (all.length === 0) {
    emptyEl.classList.remove("hidden");
    listEl.classList.add("hidden");
  } else {
    emptyEl.classList.add("hidden");
    listEl.classList.remove("hidden");
  }

  // restore selection visual
  if (selectedId) {
    const r = listEl.querySelector(`[data-id="${CSS.escape(selectedId)}"]`);
    if (r) r.setAttribute("aria-selected", "true");
  }

  updateCounts();
}

function rowHTML(s) {
  const kind = rowKind(s);
  const topic = topicOf(s);
  const topicHTML = topic
    ? `<span class="topic">${esc(truncate(topic, 80))}</span>`
    : `<span class="topic placeholder">(no prompts yet)</span>`;

  const branch = s.gitBranch && s.gitBranch !== "HEAD" ? s.gitBranch : "";
  const metaParts = [];
  if (s.project) metaParts.push(esc(s.project));
  if (branch)    metaParts.push(esc(truncate(branch, 36)));
  const meta = metaParts.length
    ? metaParts.join(`<span class="sep">/</span>`)
    : esc(s.cwd || "");

  return `
    <li class="row ${kind}" role="option" data-id="${esc(s.id)}" tabindex="-1" title="${esc(s.cwd || "")}\n${esc(topic)}">
      <span class="dot"></span>
      ${topicHTML}
      <span class="meta">${meta}</span>
      <span class="age">${fmtAge(s.lastActivity)}</span>
    </li>
  `;
}

function patchRow(s) {
  const row = listEl.querySelector(`[data-id="${CSS.escape(s.id)}"]`);
  if (!row) return false;

  const kinds = ["running","thinking","waiting","idle","exited"];
  row.classList.remove(...kinds);
  row.classList.add(rowKind(s));

  const topicEl = row.querySelector(".topic");
  const topic = topicOf(s);
  if (topicEl) {
    if (topic) {
      topicEl.classList.remove("placeholder");
      topicEl.textContent = truncate(topic, 80);
    } else {
      topicEl.classList.add("placeholder");
      topicEl.textContent = "(no prompts yet)";
    }
  }
  const ageEl = row.querySelector(".age");
  if (ageEl) ageEl.textContent = fmtAge(s.lastActivity);
  return true;
}

// ============================================================
// Render: chips + scope pill + repo menu
// ============================================================
function renderChips() {
  for (const btn of chipsEl.querySelectorAll(".chip[data-chip]")) {
    const k = btn.dataset.chip;
    btn.setAttribute("aria-pressed", String(!!filters[k]));
  }
  if (filters.repos.size > 0) {
    repoWrap.dataset.active = "true";
    repoLabel.textContent = filters.repos.size === 1 ? [...filters.repos][0] : `${filters.repos.size}`;
  } else {
    repoWrap.dataset.active = "false";
    repoLabel.textContent = "All";
  }
}

function updateCounts() {
  const counts = { live: 0, waiting: 0, exited: 0 };
  for (const s of sessions.values()) {
    if (s.live) {
      counts.live++;
      if (s.state === "waiting_user") counts.waiting++;
    } else {
      counts.exited++;
    }
  }
  for (const el of chipsEl.querySelectorAll(".chip-count")) {
    const k = el.dataset.count;
    el.textContent = counts[k];
  }
  scopeCountEl.textContent = counts.live;
}

function updateScopePill() {
  if (anyFilterActive()) {
    scopePill.classList.add("actionable");
    scopePill.title = "Clear all filters";
  } else {
    scopePill.classList.remove("actionable");
    scopePill.title = "";
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
  if (filters.repos.size > 0) {
    html.push(`<div class="repo-opt-clear" data-action="clear">Clear repo filter</div>`);
  }
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
      if (e.target.checked) filters.repos.add(r);
      else filters.repos.delete(r);
      persist();
      renderChips();
      renderList();
      updateScopePill();
    });
  }
  const clear = repoMenu.querySelector('[data-action="clear"]');
  if (clear) clear.addEventListener("click", () => {
    filters.repos.clear();
    persist();
    renderChips();
    renderRepoMenu();
    renderList();
    updateScopePill();
  });
}

// ============================================================
// Selection + drawer
// ============================================================
function selectAndOpen(id) {
  selectedId = id;
  for (const r of listEl.querySelectorAll(".row")) {
    r.setAttribute("aria-selected", r.dataset.id === id ? "true" : "false");
  }
  openDrawer();
  renderDrawer();
}

function moveSelection(delta) {
  if (visibleIds.length === 0) return;
  let idx = selectedId ? visibleIds.indexOf(selectedId) : -1;
  if (idx < 0) idx = -1;
  idx = Math.max(0, Math.min(visibleIds.length - 1, idx + delta));
  const id = visibleIds[idx];
  selectedId = id;
  for (const r of listEl.querySelectorAll(".row")) {
    r.setAttribute("aria-selected", r.dataset.id === id ? "true" : "false");
  }
  const row = listEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
  if (drawerOpen) renderDrawer();
}

function openDrawer() {
  drawerOpen = true;
  drawerEl.classList.remove("hidden");
}

function closeDrawer() {
  drawerOpen = false;
  drawerEl.classList.add("hidden");
}

function toggleDrawerSplit() {
  drawerSplit = !drawerSplit;
  drawerEl.classList.toggle("split", drawerSplit);
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

function renderDrawer() {
  const s = sessions.get(selectedId);
  if (!s) return;

  drawerTitle.textContent = s.project || "(no project)";
  const branch = s.gitBranch && s.gitBranch !== "HEAD" ? s.gitBranch : "—";
  drawerSub.innerHTML = `${esc(branch)} <span style="color:var(--text-mute)">·</span> ${esc(s.cwd || "")}`;

  const topic = topicOf(s);
  drawerBody.innerHTML = `
    <div class="section">
      <h3>State</h3>
      ${stateChipHTML(s)}
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
      <h3>Resume</h3>
      <div class="resume">
        <code id="resume-code">claude --resume ${esc(s.id)}</code>
        <button class="btn-tonal" id="copy-resume">Copy</button>
      </div>
    </div>

    <div class="section">
      <h3>Metadata</h3>
      <dl class="kv-list">
        <div class="kv"><dt>Session ID</dt><dd>${esc(s.id)}</dd></div>
        <div class="kv"><dt>Last tool</dt><dd>${esc(s.lastToolName || "—")}</dd></div>
        <div class="kv"><dt>Permission</dt><dd>${esc(s.permissionMode || "—")}</dd></div>
        <div class="kv"><dt>Version</dt><dd>${esc(s.version || "—")}</dd></div>
        <div class="kv"><dt>JSONL size</dt><dd>${fmtBytes(s.sizeBytes)}</dd></div>
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
  $("seg-recent").addEventListener("click", () => { transcriptExpanded = false; renderDrawer(); });
  $("seg-all").addEventListener("click",    () => { transcriptExpanded = true;  renderDrawer(); });

  loadTranscript(s.id);
}

async function loadTranscript(id) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/transcript`);
    const turns = await res.json();
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
// Cmd+K command palette
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
  // Extract is:foo / repo:foo tokens; remaining text is fuzzy
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
    } else if (k === "repo") {
      out.repo = v;
    } else {
      out.words.push(t.toLowerCase());
    }
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
  const hay = [
    s.project || "",
    s.gitBranch || "",
    s.cwd || "",
    s.firstUserMessage || "",
    s.lastUserMessage || "",
    s.lastAssistantText || "",
  ].join(" ").toLowerCase();
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
    // Suggested actions when empty query
    paletteRows.push({ type: "action", id: "act-toggle-exited", label: "Toggle Exited filter", hint: "is:exited" });
    paletteRows.push({ type: "action", id: "act-toggle-live",   label: filters.live ? "Hide live sessions" : "Show live sessions", hint: "is:live" });
    paletteRows.push({ type: "action", id: "act-clear",         label: "Clear all filters", hint: "" });
    paletteRows.push({ type: "action", id: "act-help",          label: "Show keyboard shortcuts", hint: "?" });
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
          <span class="dot"></span>
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
    r.addEventListener("click", () => {
      paletteCursor = parseInt(r.dataset.idx, 10);
      paletteExecute();
    });
    r.addEventListener("mouseenter", () => {
      paletteCursor = parseInt(r.dataset.idx, 10);
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
  if (row.type === "session") {
    closePalette();
    selectAndOpen(row.id);
  } else if (row.type === "action") {
    switch (row.id) {
      case "act-toggle-exited":
        filters.exited = !filters.exited; persist(); renderChips(); renderList(); updateScopePill(); break;
      case "act-toggle-live":
        filters.live = !filters.live; persist(); renderChips(); renderList(); updateScopePill(); break;
      case "act-clear":
        clearAllFilters(); break;
      case "act-help":
        closePalette(); openHelp(); return;
    }
    closePalette();
  }
}

// ============================================================
// Help
// ============================================================
function openHelp() {
  helpOpen = true;
  helpEl.classList.remove("hidden");
  helpScrim.classList.remove("hidden");
}
function closeHelp() {
  helpOpen = false;
  helpEl.classList.add("hidden");
  helpScrim.classList.add("hidden");
}

// ============================================================
// Event wiring
// ============================================================
chipsEl.addEventListener("click", e => {
  const btn = e.target.closest(".chip[data-chip]");
  if (!btn) return;
  const k = btn.dataset.chip;
  filters[k] = !filters[k];
  persist();
  renderChips();
  renderList();
  updateScopePill();
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

scopePill.addEventListener("click", () => {
  if (anyFilterActive()) clearAllFilters();
});

searchEl.addEventListener("input", e => {
  filters.search = e.target.value.trim();
  renderList();
  updateScopePill();
});

listEl.addEventListener("click", e => {
  const row = e.target.closest(".row");
  if (!row) return;
  selectAndOpen(row.dataset.id);
});

drawerClose.addEventListener("click", closeDrawer);
drawerExpand.addEventListener("click", toggleDrawerSplit);

helpBtn.addEventListener("click", openHelp);
helpScrim.addEventListener("click", closeHelp);
paletteScrim.addEventListener("click", closePalette);

paletteInput.addEventListener("input", e => {
  paletteQuery = e.target.value;
  paletteCursor = 0;
  renderPalette();
});

emptyClearBtn.addEventListener("click", clearAllFilters);

// Global keyboard
document.addEventListener("keydown", e => {
  const inField = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";

  // Palette is open
  if (paletteOpen) {
    if (e.key === "Escape") { e.preventDefault(); closePalette(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); paletteMove(1); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); paletteMove(-1); return; }
    if (e.key === "Enter")     { e.preventDefault(); paletteExecute(); return; }
    return;
  }

  // Help is open
  if (helpOpen) {
    if (e.key === "Escape") { closeHelp(); return; }
    return;
  }

  // Cmd+K / Ctrl+K opens palette from anywhere
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openPalette();
    return;
  }

  if (inField) return;   // remaining shortcuts ignored while typing

  if (e.key === "/") {
    e.preventDefault();
    searchEl.focus();
    return;
  }
  if (e.key === "?") {
    e.preventDefault();
    openHelp();
    return;
  }
  if (e.key === "Escape") {
    if (drawerOpen) { closeDrawer(); return; }
  }
  if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); moveSelection(1); return; }
  if (e.key === "ArrowUp"   || e.key === "k") { e.preventDefault(); moveSelection(-1); return; }
  if (e.key === "Enter" && selectedId) { e.preventDefault(); selectAndOpen(selectedId); return; }
  if (e.key.toLowerCase() === "c" && selectedId) {
    e.preventDefault();
    navigator.clipboard.writeText(`claude --resume ${selectedId}`);
    return;
  }
});

// ============================================================
// SSE — incoming updates
// ============================================================
function onUpsert(s) {
  const existing = sessions.get(s.id);
  sessions.set(s.id, s);
  // Decide whether the structural set changed enough to re-render the list
  if (!existing) {
    renderList();
    renderRepoMenu();
    return;
  }
  // Liveness or state change can shift filtering
  if (existing.live !== s.live || existing.state !== s.state || existing.project !== s.project) {
    renderList();
    renderRepoMenu();
  } else {
    patchRow(s);
  }
  if (selectedId === s.id && drawerOpen) renderDrawer();
  updateCounts();
}

function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("upsert", e => onUpsert(JSON.parse(e.data)));
  es.addEventListener("delete", e => {
    const { id } = JSON.parse(e.data);
    sessions.delete(id);
    if (selectedId === id) { selectedId = null; closeDrawer(); }
    renderList();
    renderRepoMenu();
  });
  es.addEventListener("snapshot-done", () => {
    renderList();
    renderRepoMenu();
    updateScopePill();
  });
  es.onerror = () => {
    // EventSource auto-reconnects; nothing to do
  };
}

// Refresh age labels every 30s without re-sorting
setInterval(() => {
  for (const row of listEl.querySelectorAll(".row")) {
    const s = sessions.get(row.dataset.id);
    if (!s) continue;
    const ageEl = row.querySelector(".age");
    if (ageEl) ageEl.textContent = fmtAge(s.lastActivity);
  }
  if (selectedId && drawerOpen) {
    const vals = drawerBody.querySelectorAll(".metric-value");
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
renderList();
updateScopePill();
connect();
