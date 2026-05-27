// ============================================================
// State
// ============================================================
const sessions = new Map();
let selectedId = null;
let searchQuery = "";
let showExited = false;
let transcriptExpanded = false;
const expandedGroups = new Set(["__needs__", "__recent__"]); // default-expanded
let structure = null; // stable cached order — only rebuilt on structural change
let renderQueued = false;

// ============================================================
// DOM
// ============================================================
const groupsEl   = document.getElementById("groups");
const emptyMain  = document.getElementById("empty-main");
const detailEl   = document.getElementById("detail");
const statusEl   = document.getElementById("status-text");
const searchEl   = document.getElementById("search");
const collapseBtn = document.getElementById("collapse-btn");
const showExitedCb = document.getElementById("show-exited");

// ============================================================
// Helpers
// ============================================================
function escapeHTML(s) {
  return (s ?? "").toString().replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[c]);
}

function fmtAgo(iso) {
  if (!iso) return "—";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 5) return "now";
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / 86400 / 7)}w`;
}

function ageSeconds(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 1000;
}

function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function truncate(s, n) {
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function rowKind(s) {
  if (!s.live) return "exited";
  return s.state || "idle";
}

function stateLabel(s) {
  if (!s.live) return "Exited";
  return {
    running_tool: "Running tool",
    thinking: "Thinking",
    waiting_user: "Waiting for input",
    idle: "Idle",
  }[s.state] || "Idle";
}

function chipClass(s) {
  if (!s.live) return "exited";
  return ({
    running_tool: "running",
    thinking: "thinking",
    waiting_user: "waiting",
    idle: "idle",
  })[s.state] || "idle";
}

function topicOf(s) {
  return s.firstUserMessage || s.lastUserMessage || "";
}

function passesSearch(s) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return (
    (s.project || "").toLowerCase().includes(q) ||
    (s.cwd || "").toLowerCase().includes(q) ||
    (s.gitBranch || "").toLowerCase().includes(q) ||
    (s.firstUserMessage || "").toLowerCase().includes(q) ||
    (s.lastUserMessage || "").toLowerCase().includes(q)
  );
}

function isNeedsYou(s) {
  return s.live && s.state === "waiting_user";
}

function isRecent(s) {
  return s.live && ageSeconds(s.lastActivity) < 24 * 3600;
}

// ============================================================
// Ripple
// ============================================================
function attachRipple(el) {
  el.classList.add("ripple-host");
  el.addEventListener("pointerdown", e => {
    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const ink = document.createElement("span");
    ink.className = "ripple-ink";
    ink.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - rect.left - size/2}px;top:${e.clientY - rect.top - size/2}px;`;
    el.appendChild(ink);
    ink.addEventListener("animationend", () => ink.remove());
  });
}

// ============================================================
// Structure: cached stable order
// ============================================================
function buildStructure() {
  const all = [...sessions.values()].filter(passesSearch);

  const needsYouIds = all.filter(isNeedsYou)
    .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity))
    .map(s => s.id);

  // Recent live sessions (last 24h), excluding ones already in needs-you
  const recentIds = all
    .filter(s => isRecent(s) && !needsYouIds.includes(s.id))
    .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity))
    .slice(0, 8)
    .map(s => s.id);

  // Everything else, grouped by project (repo)
  const dedup = new Set([...needsYouIds, ...recentIds]);
  const byRepo = new Map();
  for (const s of all) {
    if (dedup.has(s.id)) continue;
    if (!s.live && !showExited) continue;
    const key = s.project || "(no project)";
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key).push(s);
  }

  // Sort repos by total live count desc, then name
  const repoOrder = [...byRepo.entries()]
    .map(([repo, list]) => {
      list.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
      const liveCount = list.filter(s => s.live).length;
      return { repo, ids: list.map(s => s.id), liveCount, total: list.length };
    })
    .sort((a, b) => b.liveCount - a.liveCount || a.repo.localeCompare(b.repo));

  structure = { needsYouIds, recentIds, repoOrder };
}

// ============================================================
// Render
// ============================================================
function render() {
  if (!structure) buildStructure();
  const parts = [];

  if (structure.needsYouIds.length) {
    parts.push(groupHTML({
      key: "__needs__",
      label: "Needs you",
      icon: '<svg class="group-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>',
      sessionIds: structure.needsYouIds,
      crossRepo: true,
    }));
  }

  if (structure.recentIds.length) {
    parts.push(groupHTML({
      key: "__recent__",
      label: "Recent (24h)",
      icon: '<svg class="group-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
      sessionIds: structure.recentIds,
      crossRepo: true,
    }));
  }

  for (const r of structure.repoOrder) {
    parts.push(groupHTML({
      key: `repo:${r.repo}`,
      label: r.repo,
      icon: '<svg class="group-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
      sessionIds: r.ids,
      crossRepo: false,
      countLabel: `${r.liveCount}${r.total > r.liveCount ? `/${r.total}` : ""}`,
    }));
  }

  const empty = parts.length === 0;
  groupsEl.innerHTML = empty
    ? `<div style="padding:32px 16px;font-size:13px;color:var(--md-on-surface-variant);text-align:center;">No sessions to show.${searchQuery ? "" : (showExited ? "" : "<br><small>Toggle <em>Show exited</em> to see history.</small>")}</div>`
    : parts.join("");

  // Wire up interactions
  for (const head of groupsEl.querySelectorAll(".group-head")) {
    attachRipple(head);
    head.addEventListener("click", () => toggleGroup(head.dataset.group));
  }
  for (const item of groupsEl.querySelectorAll(".session-item")) {
    attachRipple(item);
    item.addEventListener("click", () => selectSession(item.dataset.id));
  }
}

function groupHTML({ key, label, icon, sessionIds, crossRepo, countLabel }) {
  const expanded = expandedGroups.has(key);
  return `
    <div class="group ${expanded ? "" : "collapsed"}">
      <div class="group-head" data-group="${escapeHTML(key)}">
        <span class="state-layer"></span>
        <svg class="group-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        ${icon}
        <span class="group-label">${escapeHTML(label)}</span>
        <span class="group-count">${escapeHTML(countLabel ?? String(sessionIds.length))}</span>
      </div>
      <div class="group-body">
        ${sessionIds.map(id => sessionItemHTML(sessions.get(id), crossRepo)).filter(Boolean).join("")}
      </div>
    </div>
  `;
}

function sessionItemHTML(s, crossRepo) {
  if (!s) return "";
  const kind = rowKind(s);
  const sel = s.id === selectedId ? "selected" : "";

  const topic = topicOf(s);
  const title = topic ? truncate(topic, 64) : "(no prompts yet)";
  const titleClass = topic ? "" : "placeholder";

  const branch = s.gitBranch && s.gitBranch !== "HEAD" ? s.gitBranch : "";
  const subParts = [];
  if (crossRepo && s.project) subParts.push(`<span>${escapeHTML(s.project)}</span>`);
  if (branch) subParts.push(`<span class="mono">${escapeHTML(truncate(branch, 32))}</span>`);
  if (!branch && !crossRepo) subParts.push(`<span class="mono">${escapeHTML(truncate(s.cwd || "", 40))}</span>`);

  const subHTML = subParts.length
    ? subParts.join('<span class="sep">·</span>')
    : `<span class="mono">${escapeHTML(s.id.slice(0, 8))}</span>`;

  return `
    <div class="session-item session-${kind} ${sel}" data-id="${escapeHTML(s.id)}" title="${escapeHTML(s.cwd || "")}">
      <span class="state-layer"></span>
      <span class="session-dot"></span>
      <span class="session-text">
        <span class="session-title ${titleClass}">${escapeHTML(title)}</span>
        <span class="session-sub">${subHTML}</span>
      </span>
      <span class="session-time">${fmtAgo(s.lastActivity)}</span>
    </div>
  `;
}

function toggleGroup(key) {
  if (expandedGroups.has(key)) expandedGroups.delete(key);
  else expandedGroups.add(key);
  saveCollapsedState();
  render();
}

function saveCollapsedState() {
  try {
    localStorage.setItem("cs:expanded", JSON.stringify([...expandedGroups]));
  } catch {}
}

function loadCollapsedState() {
  try {
    const raw = localStorage.getItem("cs:expanded");
    if (raw) {
      const arr = JSON.parse(raw);
      expandedGroups.clear();
      for (const k of arr) expandedGroups.add(k);
    }
  } catch {}
}

// ============================================================
// Detail pane
// ============================================================
function selectSession(id) {
  selectedId = id;
  transcriptExpanded = false;
  for (const el of groupsEl.querySelectorAll(".session-item")) {
    el.classList.toggle("selected", el.dataset.id === id);
  }
  renderDetail();
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

  const topic = topicOf(s);
  const branch = s.gitBranch && s.gitBranch !== "HEAD" ? s.gitBranch : "—";

  detailEl.innerHTML = `
    <div class="detail-head">
      <div class="detail-title">
        <span class="detail-project">${escapeHTML(s.project || "(no project)")}</span>
        <span class="detail-branch">${escapeHTML(branch)}</span>
        <span class="chip ${chipClass(s)}">
          <span class="chip-dot"></span>
          ${stateLabel(s)}
        </span>
      </div>
      <div class="detail-cwd">${escapeHTML(s.cwd || "")}</div>
    </div>

    <div class="card">
      <h3>Topic</h3>
      <div class="summary-topic">${escapeHTML(topic || "(no user messages yet)")}</div>
      <div class="metrics">
        <div class="metric"><span class="metric-value">${fmtAgo(s.lastActivity)}</span><span class="metric-label">Last activity</span></div>
        <div class="metric"><span class="metric-value">${fmtAgo(s.startedAt)}</span><span class="metric-label">Started</span></div>
        <div class="metric"><span class="metric-value">${s.messageCount}</span><span class="metric-label">Messages</span></div>
        <div class="metric"><span class="metric-value">${s.userMessageCount}</span><span class="metric-label">User turns</span></div>
      </div>
    </div>

    <div class="card">
      <h3>Metadata</h3>
      <dl class="kv-row"><dt>Session ID</dt><dd>${escapeHTML(s.id)}</dd></dl>
      <dl class="kv-row"><dt>Last tool</dt><dd>${escapeHTML(s.lastToolName || "—")}</dd></dl>
      <dl class="kv-row"><dt>Permission</dt><dd>${escapeHTML(s.permissionMode || "—")}</dd></dl>
      <dl class="kv-row"><dt>Version</dt><dd>${escapeHTML(s.version || "—")}</dd></dl>
      <dl class="kv-row"><dt>JSONL size</dt><dd>${fmtBytes(s.sizeBytes)}</dd></dl>
      <dl class="kv-row"><dt>Resume</dt>
        <dd class="resume-cmd">
          <code id="resume-cmd">claude --resume ${escapeHTML(s.id)}</code>
          <button class="btn-tonal" id="copy-resume"><span class="state-layer"></span>Copy</button>
        </dd>
      </dl>
    </div>

    <div class="card">
      <div class="transcript-head">
        <h3>Conversation</h3>
        <div class="segmented" role="tablist">
          <button class="${transcriptExpanded ? "" : "active"}" id="seg-recent"><span class="state-layer"></span>Last 4</button>
          <button class="${transcriptExpanded ? "active" : ""}" id="seg-all"><span class="state-layer"></span>Full</button>
        </div>
      </div>
      <div id="transcript">loading…</div>
    </div>
  `;

  const copyBtn = document.getElementById("copy-resume");
  attachRipple(copyBtn);
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(`claude --resume ${s.id}`);
    copyBtn.querySelector("span:last-child")?.remove();
    copyBtn.appendChild(document.createTextNode("Copied"));
    setTimeout(() => { copyBtn.lastChild.textContent = "Copy"; }, 1200);
  });

  const segRecent = document.getElementById("seg-recent");
  const segAll = document.getElementById("seg-all");
  attachRipple(segRecent);
  attachRipple(segAll);
  segRecent.addEventListener("click", () => { transcriptExpanded = false; renderDetail(); });
  segAll.addEventListener("click",    () => { transcriptExpanded = true;  renderDetail(); });

  loadTranscript(s.id);
}

async function loadTranscript(id) {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/transcript`);
    const turns = await r.json();
    if (id !== selectedId) return;
    const el = document.getElementById("transcript");
    if (!turns || turns.length === 0) {
      el.innerHTML = `<p style="color:var(--md-on-surface-variant);font-size:13px;">No turns yet.</p>`;
      return;
    }
    const slice = transcriptExpanded ? turns : turns.slice(-4);
    el.innerHTML = slice.map(turnHTML).join("");
  } catch {
    const el = document.getElementById("transcript");
    if (el) el.innerHTML = `<p style="color:var(--md-on-surface-variant);">Failed to load transcript.</p>`;
  }
}

function turnHTML(t) {
  return `
    <div class="turn ${t.role}">
      <div class="turn-role">
        <span>${t.role}</span>
        <span class="turn-time">${fmtAgo(t.timestamp)}</span>
      </div>
      ${t.text ? `<div class="turn-text">${escapeHTML(t.text)}</div>` : ""}
      ${t.toolName ? `<div class="turn-tool">↳ ${escapeHTML(t.toolName)}</div>` : ""}
    </div>
  `;
}

// ============================================================
// Update flow — keep DOM order stable; only restructure on
// structural changes (new id, group change, search/toggle).
// ============================================================
function scheduleRender(structural) {
  if (structural) structure = null;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!structure) buildStructure();
    render();
  });
}

function groupKey(s) {
  // What top-level bucket would this session be in?
  if (isNeedsYou(s)) return "__needs__";
  if (isRecent(s))   return "__recent__";
  if (!s.live && !showExited) return "__hidden__";
  return `repo:${s.project || "(no project)"}`;
}

function onUpsert(s) {
  const existing = sessions.get(s.id);
  const oldKey = existing ? groupKey(existing) : null;
  sessions.set(s.id, s);
  const newKey = groupKey(s);

  if (!existing || oldKey !== newKey) {
    scheduleRender(true);
  } else {
    // Same bucket — just update the row in place (no reorder)
    patchRow(s);
    if (selectedId === s.id) renderDetail();
  }
}

function patchRow(s) {
  const row = groupsEl.querySelector(`.session-item[data-id="${CSS.escape(s.id)}"]`);
  if (!row) { scheduleRender(true); return; }
  const kindClasses = ["session-running","session-thinking","session-waiting","session-idle","session-exited"];
  row.classList.remove(...kindClasses);
  row.classList.add("session-" + rowKind(s));

  const timeEl = row.querySelector(".session-time");
  if (timeEl) timeEl.textContent = fmtAgo(s.lastActivity);

  const titleEl = row.querySelector(".session-title");
  const topic = topicOf(s);
  if (titleEl) {
    if (topic) {
      titleEl.classList.remove("placeholder");
      titleEl.textContent = truncate(topic, 64);
    } else {
      titleEl.classList.add("placeholder");
      titleEl.textContent = "(no prompts yet)";
    }
  }
}

// ============================================================
// Controls
// ============================================================
searchEl.addEventListener("input", e => {
  searchQuery = e.target.value.trim();
  scheduleRender(true);
});

collapseBtn.addEventListener("click", () => {
  document.body.classList.toggle("sidebar-collapsed");
});
attachRipple(collapseBtn);

showExitedCb.addEventListener("change", e => {
  showExited = e.target.checked;
  scheduleRender(true);
});

// ============================================================
// SSE
// ============================================================
function connect() {
  const es = new EventSource("/api/events");

  es.addEventListener("upsert", e => {
    onUpsert(JSON.parse(e.data));
  });

  es.addEventListener("delete", e => {
    const { id } = JSON.parse(e.data);
    sessions.delete(id);
    if (id === selectedId) {
      selectedId = null;
      renderDetail();
    }
    scheduleRender(true);
  });

  es.addEventListener("snapshot-done", () => {
    statusEl.textContent = "live";
    statusEl.classList.add("live");
    scheduleRender(true);
  });

  es.onerror = () => {
    statusEl.textContent = "reconnecting";
    statusEl.classList.remove("live");
  };
}

// Refresh "ago" labels every 30s without reordering
setInterval(() => {
  for (const row of groupsEl.querySelectorAll(".session-item")) {
    const s = sessions.get(row.dataset.id);
    if (!s) continue;
    const timeEl = row.querySelector(".session-time");
    if (timeEl) timeEl.textContent = fmtAgo(s.lastActivity);
  }
  if (selectedId) {
    const metric = detailEl.querySelectorAll(".metric-value");
    const s = sessions.get(selectedId);
    if (s && metric.length >= 2) {
      metric[0].textContent = fmtAgo(s.lastActivity);
      metric[1].textContent = fmtAgo(s.startedAt);
    }
  }
}, 30000);

loadCollapsedState();
connect();
