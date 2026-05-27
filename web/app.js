// ===== state =====
const sessions = new Map();
let selectedId = null;
let searchQuery = "";
let showExited = false;
const collapsedGroups = new Set();
let transcriptExpanded = false;

const GROUP_ORDER = ["running_tool", "thinking", "waiting_user", "idle", "exited"];
const GROUP_LABELS = {
  running_tool: "Running tool",
  thinking:     "Thinking",
  waiting_user: "Waiting for input",
  idle:         "Idle (live)",
  exited:       "Exited",
};
const GROUP_CLASS = {
  running_tool: "group-running",
  thinking:     "group-thinking",
  waiting_user: "group-waiting",
  idle:         "group-idle",
  exited:       "group-exited",
};
const STATE_CHIP = {
  running_tool: { class: "chip-running",  label: "Running tool" },
  thinking:     { class: "chip-thinking", label: "Thinking" },
  waiting_user: { class: "chip-waiting",  label: "Waiting for input" },
  idle:         { class: "chip-idle",     label: "Idle" },
};

// ===== dom =====
const groupsEl    = document.getElementById("groups");
const emptyMain   = document.getElementById("empty-main");
const detailEl    = document.getElementById("detail");
const statusEl    = document.getElementById("status-text");
const searchEl    = document.getElementById("search");
const collapseBtn = document.getElementById("collapse-btn");
const showExitedCb = document.getElementById("show-exited");

// ===== helpers =====
function escapeHTML(s) {
  return (s ?? "").toString().replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[c]);
}

function fmtAgo(iso) {
  if (!iso) return "—";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 5) return "just now";
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function truncate(s, n) {
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function groupOf(s) {
  if (!s.live) return "exited";
  return s.state || "idle";
}

function passesSearch(s) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return (
    (s.project          || "").toLowerCase().includes(q) ||
    (s.cwd              || "").toLowerCase().includes(q) ||
    (s.gitBranch        || "").toLowerCase().includes(q) ||
    (s.firstUserMessage || "").toLowerCase().includes(q) ||
    (s.lastUserMessage  || "").toLowerCase().includes(q)
  );
}

// ===== sidebar render =====
function renderSidebar() {
  const grouped = {};
  for (const key of GROUP_ORDER) grouped[key] = [];

  for (const s of sessions.values()) {
    const g = groupOf(s);
    if (g === "exited" && !showExited) continue;
    if (!passesSearch(s)) continue;
    grouped[g].push(s);
  }

  for (const key of GROUP_ORDER) {
    grouped[key].sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
  }

  const html = GROUP_ORDER
    .filter(g => grouped[g].length > 0)
    .map(g => groupHTML(g, grouped[g]))
    .join("");

  groupsEl.innerHTML = html || `<div style="padding:24px 16px;font-size:12px;color:var(--md-on-surface-mute);text-align:center;">No sessions match.</div>`;

  for (const head of groupsEl.querySelectorAll(".group-head")) {
    head.addEventListener("click", () => toggleGroup(head.dataset.group));
  }
  for (const item of groupsEl.querySelectorAll(".session-item")) {
    item.addEventListener("click", () => selectSession(item.dataset.id));
  }
}

function groupHTML(groupKey, items) {
  const collapsed = collapsedGroups.has(groupKey) ? "collapsed" : "";
  return `
    <div class="group ${GROUP_CLASS[groupKey]} ${collapsed}">
      <div class="group-head" data-group="${groupKey}">
        <svg class="group-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
        <span class="group-dot"></span>
        <span class="group-label">${GROUP_LABELS[groupKey]}</span>
        <span class="group-count">${items.length}</span>
      </div>
      <div class="group-body">
        ${items.map(s => sessionItemHTML(s, groupKey)).join("")}
      </div>
    </div>
  `;
}

function sessionItemHTML(s, groupKey) {
  const title = s.project || "(no project)";
  const sub = s.gitBranch && s.gitBranch !== "HEAD" ? s.gitBranch : (s.cwd || "");
  const pulseClass = "session-" + (groupKey === "exited" ? "exited" : (groupKey === "running_tool" ? "running" : groupKey.replace("_user", "").replace("_tool", "")));
  const sel = s.id === selectedId ? "selected" : "";
  return `
    <div class="session-item ${pulseClass} ${sel}" data-id="${s.id}" title="${escapeHTML(s.cwd)}">
      <span class="session-pulse"></span>
      <span class="session-title">${escapeHTML(title)}</span>
      <span class="session-sub">${escapeHTML(truncate(sub, 40))}</span>
    </div>
  `;
}

function toggleGroup(key) {
  if (collapsedGroups.has(key)) collapsedGroups.delete(key);
  else collapsedGroups.add(key);
  renderSidebar();
}

// ===== main pane =====
function selectSession(id) {
  selectedId = id;
  transcriptExpanded = false;
  renderSidebar();
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

  const chip = s.live ? STATE_CHIP[s.state] : { class: "chip-exited", label: "Exited" };
  const branch = s.gitBranch && s.gitBranch !== "HEAD" ? s.gitBranch : "—";
  const topic = s.firstUserMessage || "(session has no user messages yet)";

  detailEl.innerHTML = `
    <div class="detail-head">
      <div class="detail-title">
        <span class="detail-project">${escapeHTML(s.project || "(no project)")}</span>
        <span class="detail-branch">${escapeHTML(branch)}</span>
        <span class="state-chip ${chip.class}">${chip.label}</span>
      </div>
      <div class="detail-cwd">${escapeHTML(s.cwd || "")}</div>
    </div>

    <div class="card">
      <h3>Summary</h3>
      <div class="summary-topic">${escapeHTML(topic)}</div>
      <div class="metrics">
        <div class="metric">
          <span class="metric-value">${s.messageCount}</span>
          <span class="metric-label">Messages</span>
        </div>
        <div class="metric">
          <span class="metric-value">${s.userMessageCount}</span>
          <span class="metric-label">User turns</span>
        </div>
        <div class="metric">
          <span class="metric-value">${fmtAgo(s.lastActivity)}</span>
          <span class="metric-label">Last activity</span>
        </div>
        <div class="metric">
          <span class="metric-value">${fmtAgo(s.startedAt)}</span>
          <span class="metric-label">Started</span>
        </div>
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
          <button class="copy-btn" id="copy-resume">copy</button>
        </dd>
      </dl>
    </div>

    <div class="card">
      <div class="transcript-head">
        <h3>Latest exchange</h3>
        <button class="transcript-toggle" id="toggle-transcript">
          ${transcriptExpanded ? "show only last 4" : "show full transcript"}
        </button>
      </div>
      <div id="transcript">loading…</div>
    </div>
  `;

  document.getElementById("copy-resume").addEventListener("click", () => {
    navigator.clipboard.writeText(`claude --resume ${s.id}`);
    const btn = document.getElementById("copy-resume");
    btn.textContent = "copied";
    setTimeout(() => { btn.textContent = "copy"; }, 1200);
  });

  document.getElementById("toggle-transcript").addEventListener("click", () => {
    transcriptExpanded = !transcriptExpanded;
    renderDetail();
  });

  loadTranscript(s.id);
}

async function loadTranscript(id) {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/transcript`);
    const turns = await r.json();
    if (id !== selectedId) return;
    const el = document.getElementById("transcript");
    if (!turns || turns.length === 0) {
      el.innerHTML = `<p style="color:var(--md-on-surface-mute);font-size:12px;">No turns yet.</p>`;
      return;
    }
    const slice = transcriptExpanded ? turns : turns.slice(-4);
    el.innerHTML = slice.map(turnHTML).join("");
  } catch (e) {
    const el = document.getElementById("transcript");
    if (el) el.innerHTML = `<p style="color:var(--md-on-surface-mute);">Failed to load transcript.</p>`;
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

// ===== controls =====
searchEl.addEventListener("input", e => {
  searchQuery = e.target.value.trim();
  renderSidebar();
});

collapseBtn.addEventListener("click", () => {
  document.body.classList.toggle("sidebar-collapsed");
});

showExitedCb.addEventListener("change", e => {
  showExited = e.target.checked;
  renderSidebar();
});

// ===== SSE =====
function connect() {
  const es = new EventSource("/api/events");

  es.addEventListener("upsert", e => {
    const s = JSON.parse(e.data);
    sessions.set(s.id, s);
    renderSidebar();
    if (s.id === selectedId) renderDetail();
  });

  es.addEventListener("delete", e => {
    const { id } = JSON.parse(e.data);
    sessions.delete(id);
    if (id === selectedId) {
      selectedId = null;
      renderDetail();
    }
    renderSidebar();
  });

  es.addEventListener("snapshot-done", () => {
    statusEl.textContent = "live";
    statusEl.classList.add("live");
  });

  es.onerror = () => {
    statusEl.textContent = "reconnecting…";
    statusEl.classList.remove("live");
  };
}

// re-render every minute so "X ago" timestamps stay fresh
setInterval(() => {
  renderSidebar();
  if (selectedId) renderDetail();
}, 60000);

connect();
