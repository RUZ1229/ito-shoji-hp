/**
 * 千葉配送地図 — 協調編集 UI（工務店追加・コース変更・コース作成）
 */
(function () {
  "use strict";

  let api = null;
  let selectedSiteIds = new Set();

  const HUBS = [
    { id: "yachiyo_dp", label: "八千代DP" },
    { id: "esr_kazo", label: "ESR加須" },
    { id: "nbs", label: "NBS（木更津）" },
    { id: "kashiwa_dc", label: "柏DC" },
  ];

  function apiBase() {
    const meta = document.querySelector('meta[name="chiba-map-collab-api"]');
    if (meta?.content?.trim()) return meta.content.trim().replace(/\/$/, "");
    if (/localhost|127\.0\.0\.1/.test(window.location.hostname)) {
      return "http://127.0.0.1:8767";
    }
    return "";
  }

  function editKey() {
    return sessionStorage.getItem("chiba-map-edit-key") || "";
  }

  function setEditKey(k) {
    sessionStorage.setItem("chiba-map-edit-key", k);
  }

  async function postJson(path, body) {
    const base = apiBase();
    if (!base) throw new Error("編集APIに接続できません。map_collab_server.py を起動してください。");
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Map-Edit-Key": editKey() },
      body: JSON.stringify({ ...body, edit_key: editKey() }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  async function ensureEditKey() {
    if (editKey()) return true;
    const k = prompt("編集用合言葉を入力（地図と同じ合言葉）");
    if (!k) return false;
    setEditKey(k);
    return true;
  }

  async function submitActions(actions, statusEl) {
    if (!(await ensureEditKey())) return;
    statusEl.textContent = "反映中…";
    try {
      const res = await postJson("/api/map-collab", { actions, by: "地図ユーザー" });
      statusEl.textContent = res.message || "反映しました";
      api.setStatus("全員反映中…再読込します");
      setTimeout(() => window.location.reload(), 4000);
    } catch (err) {
      statusEl.textContent = err.message || String(err);
    }
  }

  function courseOptionsHtml(groups) {
    return groups
      .map(
        (g) =>
          `<optgroup label="${g.title}">${g.courses
            .map((c) => `<option value="${c}">${c}</option>`)
            .join("")}</optgroup>`
      )
      .join("");
  }

  function hubOptionsHtml() {
    return HUBS.map((h) => `<option value="${h.id}">${h.label}</option>`).join("");
  }

  function buildPanel() {
    const el = document.createElement("aside");
    el.className = "collab-editor";
    el.hidden = true;
    el.innerHTML = `
      <div class="collab-editor__head">
        <h2 class="collab-editor__title">地図編集</h2>
        <button type="button" class="collab-editor__close" aria-label="閉じる">×</button>
      </div>
      <div class="collab-editor__tabs">
        <button type="button" data-tab="add" class="is-active">工務店追加</button>
        <button type="button" data-tab="move">コース変更</button>
        <button type="button" data-tab="create">コース作成</button>
      </div>
      <div class="collab-editor__body">
        <section data-panel="add">
          <label>工務店名<input id="collabAddName" type="text" placeholder="例：（株）○○"></label>
          <label>住所<input id="collabAddAddr" type="text" placeholder="千葉県…"></label>
          <label>コース<select id="collabAddCourse"></select></label>
          <button type="button" id="collabConfirmAdd" class="collab-btn collab-btn--primary">決定（全員に反映）</button>
        </section>
        <section data-panel="move" hidden>
          <label>工務店<select id="collabMoveSite"></select></label>
          <label>新コース<select id="collabMoveCourse"></select></label>
          <p class="collab-note">※配車依頼書のコース（マスタ）は残し、地図・検索の表示コースだけ変わります。</p>
          <button type="button" id="collabConfirmMove" class="collab-btn collab-btn--primary">決定（全員に反映）</button>
        </section>
        <section data-panel="create" hidden>
          <label>新コース名<input id="collabCourseName" type="text" placeholder="例：柏3V+3X"></label>
          <label>出発倉庫<select id="collabCourseHub">${hubOptionsHtml()}</select></label>
          <p class="collab-note">地図上の丸をタップして工務店を選ぶ（複数可）</p>
          <ul id="collabSelectedList" class="collab-selected"></ul>
          <div id="collabCreateStats" class="collab-stats" hidden></div>
          <button type="button" id="collabConfirmCreate" class="collab-btn collab-btn--primary">決定（全員に反映）</button>
        </section>
      </div>
      <p id="collabStatus" class="collab-status"></p>
    `;
    document.body.appendChild(el);
    return el;
  }

  function fillCourseSelects(groups) {
    const html = courseOptionsHtml(groups);
    ["collabAddCourse", "collabMoveCourse"].forEach((id) => {
      const sel = document.getElementById(id);
      if (sel) sel.innerHTML = html;
    });
  }

  function fillSiteSelect(sites) {
    const sel = document.getElementById("collabMoveSite");
    if (!sel) return;
    const rows = (sites || [])
      .slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", "ja"));
    sel.innerHTML = rows
      .map(
        (s) =>
          `<option value="${s.id}">${s.name}（${api.getMapCourse(s)}）</option>`
      )
      .join("");
  }

  async function refreshCreateStats() {
    const box = document.getElementById("collabCreateStats");
    if (!box || selectedSiteIds.size === 0) {
      if (box) box.hidden = true;
      return;
    }
    const ids = [...selectedSiteIds];
    const sites = api.getMapData().sites || [];
    let totalKg = 0;
    let totalVis = 0;
    const rows = ids
      .map((id) => sites.find((s) => s.id === id))
      .filter(Boolean)
      .map((s) => {
        const w = Number(s.weight_kg) || 0;
        const v = Number(s.visit_count) || 0;
        totalKg += w;
        totalVis += v;
        return `<li>${s.name} … ${v}回 / ${w}kg</li>`;
      });
    box.hidden = false;
    box.innerHTML = `<strong>合計</strong> ${ids.length}店 · ${totalVis}回 · ${totalKg}kg<ul>${rows.join("")}</ul>`;
  }

  function bindPanel(panel) {
    const groups = api.allCourseGroups();
    fillCourseSelects(groups);
    fillSiteSelect(api.getMapData().sites);
    const status = document.getElementById("collabStatus");

    panel.querySelector(".collab-editor__close").addEventListener("click", () => {
      panel.hidden = true;
      api.resetMarkerStyles();
    });

    panel.querySelectorAll(".collab-editor__tabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        panel.querySelectorAll(".collab-editor__tabs button").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        const tab = btn.dataset.tab;
        panel.querySelectorAll("[data-panel]").forEach((p) => {
          p.hidden = p.dataset.panel !== tab;
        });
        if (tab === "create") {
          selectedSiteIds.clear();
          renderSelectedList();
        } else {
          api.resetMarkerStyles();
        }
      });
    });

    document.getElementById("collabConfirmAdd").addEventListener("click", async () => {
      const name = document.getElementById("collabAddName").value.trim();
      const address = document.getElementById("collabAddAddr").value.trim();
      const map_course = document.getElementById("collabAddCourse").value;
      if (!name || !address) {
        setStatus("名前と住所を入力してください");
        return;
      }
      await submitActions([{ type: "add_site", name, address, map_course }], status);
    });

    document.getElementById("collabConfirmMove").addEventListener("click", async () => {
      const site_id = document.getElementById("collabMoveSite").value;
      const map_course = document.getElementById("collabMoveCourse").value;
      if (!site_id || !map_course) {
        setStatus("工務店とコースを選んでください");
        return;
      }
      await submitActions([{ type: "move_course", site_id, map_course }], status);
    });

    document.getElementById("collabConfirmCreate").addEventListener("click", async () => {
      const course_name = document.getElementById("collabCourseName").value.trim();
      const hub = document.getElementById("collabCourseHub").value;
      if (!course_name || selectedSiteIds.size === 0) {
        setStatus("コース名と工務店（1件以上）を選んでください");
        return;
      }
      await submitActions(
        [
          {
            type: "create_course",
            course_name,
            site_ids: [...selectedSiteIds],
            hub,
          },
        ],
        status
      );
    });
  }

  function renderSelectedList() {
    const ul = document.getElementById("collabSelectedList");
    if (!ul) return;
    const sites = api.getMapData().sites || [];
    ul.innerHTML = [...selectedSiteIds]
      .map((id) => {
        const s = sites.find((x) => x.id === id);
        return `<li>${s?.name || id} <button type="button" data-rm="${id}">×</button></li>`;
      })
      .join("");
    ul.querySelectorAll("[data-rm]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedSiteIds.delete(btn.dataset.rm);
        renderSelectedList();
        refreshCreateStats();
      });
    });
    refreshCreateStats();
  }

  function setStatus(msg) {
    const st = document.getElementById("collabStatus");
    if (st) st.textContent = msg;
    if (api?.showHint) api.showHint(msg);
  }

  function bindMapClickForCreate(panel) {
    api.getShopMarkers().forEach(({ marker, site }) => {
      marker.on("click", () => {
        if (panel.hidden) return;
        const createTab = panel.querySelector('[data-panel="create"]');
        if (createTab?.hidden) return;
        if (selectedSiteIds.has(site.id)) selectedSiteIds.delete(site.id);
        else selectedSiteIds.add(site.id);
        renderSelectedList();
        api.highlightSiteById(site.id, "#e056fd");
      });
    });
  }

  function ensureEditKeyGate() {
    const fab = document.createElement("button");
    fab.type = "button";
    fab.className = "collab-fab";
    fab.textContent = "編集";
    fab.title = "工務店追加・コース変更";
    document.body.appendChild(fab);

    fab.addEventListener("click", () => {
      if (!editKey()) {
        const k = prompt("編集用合言葉を入力（地図と同じ合言葉）");
        if (!k) return;
        setEditKey(k);
      }
      const panel = document.querySelector(".collab-editor");
      if (panel) panel.hidden = !panel.hidden;
    });
  }

  window.__chibaMapCollabInit = function (mapApi) {
    api = mapApi;
    const panel = buildPanel();
    bindPanel(panel);
    bindMapClickForCreate(panel);
    ensureEditKeyGate();
  };
})();
