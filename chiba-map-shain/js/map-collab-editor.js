/**
 * 千葉配送地図 — 協調編集 UI（工務店追加・コース変更・コース作成）
 */
(function () {
  "use strict";

  let api = null;
  let selectedSiteIds = new Set();
  let allSitesForSelect = [];

  const HUBS = [
    { id: "yachiyo_dp", label: "八千代DP" },
    { id: "esr_kazo", label: "ESR加須" },
    { id: "nbs", label: "NBS（木更津）" },
    { id: "kashiwa_dc", label: "柏DC" },
  ];

  let cachedApiBase = null;

  async function resolveApiBase() {
    if (cachedApiBase !== null) return cachedApiBase;
    const meta = document.querySelector('meta[name="chiba-map-collab-api"]');
    if (meta?.content?.trim()) {
      cachedApiBase = meta.content.trim().replace(/\/$/, "");
      return cachedApiBase;
    }
    const origin = window.location.origin.replace(/\/$/, "");
    if (/^https?:/.test(window.location.protocol)) {
      try {
        const r = await fetch(`${origin}/api/map-collab/health`, { cache: "no-store" });
        if (r.ok) {
          cachedApiBase = origin;
          return cachedApiBase;
        }
      } catch (_) {
        /* fall through */
      }
    }
    if (/localhost|127\.0\.0\.1/.test(window.location.hostname)) {
      cachedApiBase = `http://${window.location.hostname}:8767`;
      return cachedApiBase;
    }
    cachedApiBase = "";
    return cachedApiBase;
  }

  function editKey() {
    return sessionStorage.getItem("chiba-map-edit-key") || "";
  }

  function setEditKey(k) {
    sessionStorage.setItem("chiba-map-edit-key", k);
  }

  async function postJson(path, body) {
    const base = await resolveApiBase();
    if (!base) {
      throw new Error(
        "編集APIに接続できません。地図を一度閉じ、デスクトップの「千葉配送地図を開く」から開き直してください。"
      );
    }
    let r;
    try {
      r = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Map-Edit-Key": editKey() },
        body: JSON.stringify({ ...body, edit_key: editKey() }),
      });
    } catch (_) {
      throw new Error(
        "編集APIに接続できません。地図を一度閉じ、デスクトップの「千葉配送地図を開く」から開き直してください。"
      );
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (data.error === "invalid_edit_key") {
        throw new Error("合言葉が違います。編集を開き直して合言葉を入れ直してください。");
      }
      throw new Error(data.error || `HTTP ${r.status}`);
    }
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
      api.setStatus("反映しました。再読込します…");
      setTimeout(() => window.location.reload(), 1200);
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
        <button type="button" data-tab="delete">工務店消去</button>
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
          <label>工務店
            <input id="collabMoveSiteSearch" type="search" placeholder="名前・コースで検索…" autocomplete="off">
            <select id="collabMoveSite"></select>
          </label>
          <label>新コース<select id="collabMoveCourse"></select></label>
          <p class="collab-note">※配車依頼書のコース（マスタ）は残し、地図・検索の表示コースだけ変わります。</p>
          <button type="button" id="collabConfirmMove" class="collab-btn collab-btn--primary">決定（全員に反映）</button>
        </section>
        <section data-panel="delete" hidden>
          <label>工務店
            <input id="collabDeleteSiteSearch" type="search" placeholder="名前・コースで検索…" autocomplete="off">
            <select id="collabDeleteSite"></select>
          </label>
          <p class="collab-note">※地図から消えます。配車依頼書のマスタは残ります（協調追加分は完全削除）。</p>
          <button type="button" id="collabConfirmDelete" class="collab-btn collab-btn--primary">消去（全員に反映）</button>
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

  function siteRowLabel(site) {
    return `${site.name}（${api.getMapCourse(site)}）`;
  }

  function siteSearchHaystack(site) {
    const aliases = Array.isArray(site.search_names) ? site.search_names.join(" ") : "";
    return `${site.name || ""} ${api.getMapCourse(site) || ""} ${site.address || ""} ${aliases}`.toLowerCase();
  }

  function siteMatchesQuery(site, query) {
    const q = (query || "").trim().toLowerCase();
    if (!q) return true;
    return siteSearchHaystack(site).includes(q);
  }

  function fillSiteSelect(selectId, query, selectedId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const filtered = allSitesForSelect.filter((s) => siteMatchesQuery(s, query));
    if (!filtered.length) {
      sel.innerHTML = '<option value="">該当なし</option>';
      sel.value = "";
      return;
    }
    sel.innerHTML = filtered
      .map((s) => `<option value="${s.id}">${siteRowLabel(s)}</option>`)
      .join("");
    const keep = selectedId || sel.value;
    if (keep && filtered.some((s) => s.id === keep)) {
      sel.value = keep;
    } else if (filtered.length === 1) {
      sel.value = filtered[0].id;
    }
  }

  function fillSiteSelects(sites) {
    allSitesForSelect = (sites || [])
      .slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", "ja"));
    const moveQ = document.getElementById("collabMoveSiteSearch")?.value || "";
    const deleteQ = document.getElementById("collabDeleteSiteSearch")?.value || "";
    fillSiteSelect("collabMoveSite", moveQ, document.getElementById("collabMoveSite")?.value);
    fillSiteSelect("collabDeleteSite", deleteQ, document.getElementById("collabDeleteSite")?.value);
  }

  function bindSiteSearch(searchId, selectId) {
    const search = document.getElementById(searchId);
    const sel = document.getElementById(selectId);
    if (!search || !sel) return;
    search.addEventListener("input", () => {
      fillSiteSelect(selectId, search.value, sel.value);
    });
    sel.addEventListener("change", () => {
      const site = allSitesForSelect.find((s) => s.id === sel.value);
      if (site) search.value = site.name || "";
    });
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
    fillSiteSelects(api.getMapData().sites);
    bindSiteSearch("collabMoveSiteSearch", "collabMoveSite");
    bindSiteSearch("collabDeleteSiteSearch", "collabDeleteSite");
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
        status.textContent = "名前と住所を入力してください";
        return;
      }
      await submitActions([{ type: "add_site", name, address, map_course }], status);
    });

    document.getElementById("collabConfirmDelete").addEventListener("click", async () => {
      const site_id = document.getElementById("collabDeleteSite").value;
      if (!site_id) {
        status.textContent = "消去する工務店を選んでください";
        return;
      }
      const sites = api.getMapData().sites || [];
      const site = sites.find((s) => s.id === site_id);
      const label = site?.name || site_id;
      if (!confirm(`「${label}」を地図から消去します。よろしいですか？`)) return;
      await submitActions([{ type: "delete_site", site_id }], status);
    });

    document.getElementById("collabConfirmMove").addEventListener("click", async () => {
      const site_id = document.getElementById("collabMoveSite").value;
      const map_course = document.getElementById("collabMoveCourse").value;
      if (!site_id || !map_course) {
        status.textContent = "工務店とコースを選んでください";
        return;
      }
      await submitActions([{ type: "move_course", site_id, map_course }], status);
    });

    document.getElementById("collabConfirmCreate").addEventListener("click", async () => {
      const course_name = document.getElementById("collabCourseName").value.trim();
      const hub = document.getElementById("collabCourseHub").value;
      if (!course_name || selectedSiteIds.size === 0) {
        status.textContent = "コース名と工務店（1件以上）を選んでください";
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
