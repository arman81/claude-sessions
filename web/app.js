const sessions = new Map();
let currentFilter = "all";
let searchQuery = "";

const grid = document.getElementById("grid");
const empty = document.getElementById("empty");
const statusEl = document.getElementById("status");
const searchEl = document.getElementById("search");
const detail = document.getElementById("detail");
const detailTitle = document.getElementById("detail-title");
const detailBody = document.getElementById("detail-body");

function fmtAgo(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function stateLabel(s) {
  return { waiting_user: "waiting", running_tool: "running", thinking: "thinking", idle: "idle" }[s] || s;
}

function passesFilter(s) {
  if (currentFilter !== "all" && s.state !== currentFilter) return false;
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return (
    (s.project || "").toLowerCase().includes(q) ||
    (s.cwd || "").toLowerCase().includes(q) ||
    (s.gitBranch || "").toLowerCase().includes(q) ||
    (s.lastUserMessage || "").toLowerCase().includes(q) ||
    (s.firstUserMessage || "").toLowerCase().includes(q)
  );
}

function render() {
  const arr = Array.from(sessions.values()).sort(
    (a, b) => new Date(b.lastActivity) - new Date(a.lastActivity)
  );

  const counts = { all: arr.length, waiting_user: 0, running_tool: 0, thinking: 0, idle: 0 };
  for (const s of arr) counts[s.state] = (counts[s.state] || 0) + 1;
  for (const k of Object.keys(counts)) {
    const el = document.getElementById(`count-${k}`);
    if (el) el.textContent = counts[k];
  }

  const filtered = arr.filter(passesFilter);
  empty.classList.toggle("hidden", filtered.length > 0);
  grid.innerHTML = filtered.map(cardHTML).join("");

  for (const card of grid.querySelectorAll(".card")) {
    card.addEventListener("click", () => openDetail(card.dataset.id));
  }
}

function escape(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

function cardHTML(s) {
  const prompt = s.lastUserMessage || s.firstUserMessage || "";
  return `
    <div class="card" data-id="${s.id}">
      <div class="card-head">
        <span class="state-pill state-${s.state}">${stateLabel(s.state)}</span>
        <span class="project" title="${escape(s.project)}">${escape(s.project || "—")}</span>
        ${s.gitBranch ? `<span class="branch" title="${escape(s.gitBranch)}">${escape(s.gitBranch)}</span>` : ""}
      </div>
      <div class="cwd" title="${escape(s.cwd)}">${escape(s.cwd || "")}</div>
      <div class="prompt ${prompt ? "" : "empty"}">${prompt ? escape(prompt) : "no prompts yet"}</div>
      <div class="meta">
        <div class="left">
          <span>${s.messageCount} msgs</span>
          ${s.lastToolName ? `<span>· ${escape(s.lastToolName)}</span>` : ""}
        </div>
        <div class="right">
          <span title="${escape(s.lastActivity)}">${fmtAgo(s.lastActivity)}</span>
        </div>
      </div>
    </div>
  `;
}

function openDetail(id) {
  const s = sessions.get(id);
  if (!s) return;
  detail.classList.remove("hidden");
  detailTitle.textContent = `${s.project} · ${s.gitBranch || ""}`;
  detailBody.innerHTML = `
    <dl class="kv">
      <dt>session id</dt><dd>${escape(s.id)}</dd>
      <dt>cwd</dt><dd>${escape(s.cwd)}</dd>
      <dt>branch</dt><dd>${escape(s.gitBranch || "—")}</dd>
      <dt>state</dt><dd>${stateLabel(s.state)}</dd>
      <dt>messages</dt><dd>${s.messageCount} (${s.userMessageCount} user)</dd>
      <dt>started</dt><dd>${escape(s.startedAt || "—")}</dd>
      <dt>last activity</dt><dd>${escape(s.lastActivity)} (${fmtAgo(s.lastActivity)})</dd>
      <dt>claude version</dt><dd>${escape(s.version || "—")}</dd>
      <dt>permission mode</dt><dd>${escape(s.permissionMode || "—")}</dd>
      <dt>size</dt><dd>${fmtBytes(s.sizeBytes)}</dd>
      <dt>resume</dt><dd>claude --resume ${escape(s.id)}</dd>
    </dl>
    <div id="transcript">loading transcript…</div>
  `;

  fetch(`/api/sessions/${encodeURIComponent(id)}/transcript`)
    .then(r => r.json())
    .then(turns => {
      const tEl = document.getElementById("transcript");
      if (!turns || turns.length === 0) {
        tEl.innerHTML = `<p class="muted">No turns to show.</p>`;
        return;
      }
      tEl.innerHTML = turns.map(t => `
        <div class="turn turn-${t.role}">
          <div class="turn-role">${t.role} · ${fmtAgo(t.timestamp)}</div>
          ${t.text ? `<div class="turn-text">${escape(t.text)}</div>` : ""}
          ${t.toolName ? `<div class="turn-tool">↳ ${escape(t.toolName)}</div>` : ""}
        </div>
      `).join("");
    })
    .catch(() => {
      document.getElementById("transcript").innerHTML = `<p class="muted">Failed to load transcript.</p>`;
    });
}

document.getElementById("detail-close").addEventListener("click", () => {
  detail.classList.add("hidden");
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") detail.classList.add("hidden");
});

for (const btn of document.querySelectorAll(".filters button")) {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filters button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.state;
    render();
  });
}

searchEl.addEventListener("input", e => {
  searchQuery = e.target.value.trim();
  render();
});

function connect() {
  const es = new EventSource("/api/events");

  es.addEventListener("upsert", e => {
    const s = JSON.parse(e.data);
    sessions.set(s.id, s);
    render();
  });
  es.addEventListener("delete", e => {
    const { id } = JSON.parse(e.data);
    sessions.delete(id);
    render();
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
setInterval(render, 60000);

connect();
