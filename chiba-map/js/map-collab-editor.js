/**
 * 千葉配送地図 — 協調編集 UI（工務店追加・コース変更・コース作成）
 */
(function () {
  "use strict";

  let api = null;
  let selectedSiteIds = new Set();
  let shopSearchCatalog = [];

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
            <div class="search-box collab-site-search">
              <input id="collabMoveSiteSearch" type="search" placeholder="工務店名・コースで検索…" autocomplete="off" aria-controls="collabMoveSiteSuggestions">
              <ul id="collabMoveSiteSuggestions" class="search-suggestions" role="listbox" hidden></ul>
            </div>
          </label>
          <p id="collabMoveSitePicked" class="collab-picked" hidden></p>
          <input type="hidden" id="collabMoveSiteId" value="">
          <label>新コース<select id="collabMoveCourse"></select></label>
          <p class="collab-note">※配車依頼書のコース（マスタ）は残し、地図・検索の表示コースだけ変わります。</p>
          <button type="button" id="collabConfirmMove" class="collab-btn collab-btn--primary">決定（全員に反映）</button>
        </section>
        <section data-panel="delete" hidden>
          <label>工務店
            <div class="search-box collab-site-search">
              <input id="collabDeleteSiteSearch" type="search" placeholder="工務店名・コースで検索…" autocomplete="off" aria-controls="collabDeleteSiteSuggestions">
              <ul id="collabDeleteSiteSuggestions" class="search-suggestions" role="listbox" hidden></ul>
            </div>
          </label>
          <p id="collabDeleteSitePicked" class="collab-picked" hidden></p>
          <input type="hidden" id="collabDeleteSiteId" value="">
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

  function normSearchText(s) {
    return (s || "").normalize("NFKC").trim().replace(/\s+/g, "");
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function buildShopSearchCatalog(sites) {
    const items = [];
    const seen = new Set();
    for (const s of sites || []) {
      const names = [s.name, ...(s.search_names || [])];
      for (const name of names) {
        const key = normSearchText(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push({
          value: name,
          label: name,
          meta: api.getMapCourse(s),
          category: "工務店",
          siteId: s.id,
        });
      }
    }
    shopSearchCatalog = items;
  }

  function filterShopSuggestions(query) {
    const q = normSearchText(query);
    if (!q) return [];
    return shopSearchCatalog
      .filter((item) => {
        const blob = normSearchText(`${item.value}${item.label}${item.meta}${item.category}`);
        return blob.includes(q);
      })
      .slice(0, 18);
  }

  function hideShopSuggestions(listEl) {
    if (!listEl) return;
    listEl.hidden = true;
    listEl.innerHTML = "";
    listEl._items = [];
    listEl._activeIndex = -1;
  }

  function renderShopSuggestions(listEl, items) {
    if (!listEl) return;
    const activeIndex = listEl._activeIndex ?? -1;
    if (!items.length) {
      hideShopSuggestions(listEl);
      return;
    }
    listEl.innerHTML = items
      .map(
        (item, idx) =>
          `<li class="search-suggestions__item${idx === activeIndex ? " is-active" : ""}" role="option" data-value="${escapeHtml(item.value)}">` +
          `<span class="search-suggestions__cat">${escapeHtml(item.category)}</span>` +
          `<span class="search-suggestions__label">${escapeHtml(item.label)}</span>` +
          `<span class="search-suggestions__meta">${escapeHtml(item.meta)}</span>` +
          `</li>`
      )
      .join("");
    listEl.hidden = false;
    listEl._items = items;
  }

  function clearShopPick({ hiddenId, pickedId, searchId, suggestionsId }) {
    const hidden = document.getElementById(hiddenId);
    const picked = document.getElementById(pickedId);
    const search = document.getElementById(searchId);
    const list = document.getElementById(suggestionsId);
    if (hidden) hidden.value = "";
    if (picked) {
      picked.hidden = true;
      picked.textContent = "";
    }
    if (search) search.value = "";
    hideShopSuggestions(list);
  }

  function pickShop({ item, hiddenId, pickedId, searchId, suggestionsId }) {
    const hidden = document.getElementById(hiddenId);
    const picked = document.getElementById(pickedId);
    const search = document.getElementById(searchId);
    const list = document.getElementById(suggestionsId);
    if (!item?.siteId) return;
    if (hidden) hidden.value = item.siteId;
    if (picked) {
      picked.hidden = false;
      picked.textContent = `選択: ${item.label}（${item.meta}）`;
    }
    if (search) search.value = item.label;
    hideShopSuggestions(list);
    api.highlightSiteById(item.siteId, "#ffd54a");
    if (api.flyToSite) api.flyToSite(item.siteId);
  }

  function bindShopPicker({ searchId, suggestionsId, hiddenId, pickedId }) {
    const search = document.getElementById(searchId);
    const list = document.getElementById(suggestionsId);
    if (!search || !list) return;

    list._activeIndex = -1;

    const showSuggestions = () => {
      list._activeIndex = -1;
      renderShopSuggestions(list, filterShopSuggestions(search.value));
    };

    search.addEventListener("focus", showSuggestions);
    search.addEventListener("input", () => {
      const hidden = document.getElementById(hiddenId);
      if (hidden) hidden.value = "";
      const picked = document.getElementById(pickedId);
      if (picked) {
        picked.hidden = true;
        picked.textContent = "";
      }
      showSuggestions();
    });

    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest(".search-suggestions__item");
      if (!li) return;
      e.preventDefault();
      const item = (list._items || []).find((x) => x.value === li.dataset.value);
      pickShop({ item, hiddenId, pickedId, searchId, suggestionsId });
    });

    search.addEventListener("keydown", (e) => {
      const items = list._items || [];
      if (e.key === "ArrowDown") {
        if (list.hidden) showSuggestions();
        const visible = list._items || [];
        if (!visible.length) return;
        e.preventDefault();
        list._activeIndex = Math.min((list._activeIndex ?? -1) + 1, visible.length - 1);
        renderShopSuggestions(list, visible);
        return;
      }
      if (e.key === "ArrowUp") {
        const visible = list._items || [];
        if (!visible.length) return;
        e.preventDefault();
        list._activeIndex = Math.max((list._activeIndex ?? 0) - 1, 0);
        renderShopSuggestions(list, visible);
        return;
      }
      if (e.key === "Escape") {
        hideShopSuggestions(list);
        return;
      }
      if (e.key === "Enter") {
        if (!list.hidden && list._activeIndex >= 0 && items[list._activeIndex]) {
          e.preventDefault();
          pickShop({ item: items[list._activeIndex], hiddenId, pickedId, searchId, suggestionsId });
        }
      }
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(`#${searchId}`) && !e.target.closest(`#${suggestionsId}`)) {
        hideShopSuggestions(list);
      }
    });
  }

  function ensureCollabSearchStyles() {
    if (document.getElementById("collabSiteSearchStyles")) return;
    const style = document.createElement("style");
    style.id = "collabSiteSearchStyles";
    style.textContent =
      ".collab-editor .collab-site-search { margin-top: 4px; }" +
      ".collab-editor .search-suggestions { z-index: 1200; max-height: 220px; }" +
      ".collab-picked { margin: 4px 0 8px; font-size: 0.75rem; color: var(--text); }";
    document.head.appendChild(style);
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
    ensureCollabSearchStyles();
    buildShopSearchCatalog(api.getMapData().sites);
    bindShopPicker({
      searchId: "collabMoveSiteSearch",
      suggestionsId: "collabMoveSiteSuggestions",
      hiddenId: "collabMoveSiteId",
      pickedId: "collabMoveSitePicked",
    });
    bindShopPicker({
      searchId: "collabDeleteSiteSearch",
      suggestionsId: "collabDeleteSiteSuggestions",
      hiddenId: "collabDeleteSiteId",
      pickedId: "collabDeleteSitePicked",
    });
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
        if (tab === "move") {
          clearShopPick({
            hiddenId: "collabMoveSiteId",
            pickedId: "collabMoveSitePicked",
            searchId: "collabMoveSiteSearch",
            suggestionsId: "collabMoveSiteSuggestions",
          });
        }
        if (tab === "delete") {
          clearShopPick({
            hiddenId: "collabDeleteSiteId",
            pickedId: "collabDeleteSitePicked",
            searchId: "collabDeleteSiteSearch",
            suggestionsId: "collabDeleteSiteSuggestions",
          });
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
      const site_id = document.getElementById("collabDeleteSiteId").value;
      if (!site_id) {
        status.textContent = "候補から工務店を選んでください";
        return;
      }
      const sites = api.getMapData().sites || [];
      const site = sites.find((s) => s.id === site_id);
      const label = site?.name || site_id;
      if (!confirm(`「${label}」を地図から消去します。よろしいですか？`)) return;
      await submitActions([{ type: "delete_site", site_id }], status);
    });

    document.getElementById("collabConfirmMove").addEventListener("click", async () => {
      const site_id = document.getElementById("collabMoveSiteId").value;
      const map_course = document.getElementById("collabMoveCourse").value;
      if (!site_id || !map_course) {
        status.textContent = "候補から工務店とコースを選んでください";
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
