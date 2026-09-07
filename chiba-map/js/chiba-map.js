/**
 * 伊藤商事 千葉配送地図
 * 現場マスタ + 倉庫 + コースルート検索
 */
(function () {
  "use strict";

  const DATA_URL = "data/map_data.json";
  const GEOJSON_URL = "data/chiba_cities.geojson";
  const IS_WEB_HOST = /github\.io$/i.test(window.location.hostname);

  let map;
  let mapData;
  let shopMarkers = [];
  let warehouseMarkers = {};
  let routeLayers = [];
  let cityLayer;
  let searchCatalog = [];
  let highlightColors = {};
  let suggestionActiveIndex = -1;
  /** @type {Array<{key:string,type:string,label:string,siteId?:string,siteIds?:string[],course?:string,zoneKey?:string,yokomochiId?:string,warehouseId?:string}>} */
  let activeSelections = [];

  const DEFAULT_SHOP_COLOR = "#3b9eff";
  /** 通常青と被らないハイライト専用（青系・シアン系は使わない） */
  const HIGHLIGHT_PALETTE = [
    "#ffd54a", "#ff8c42", "#ff6348", "#e056fd", "#2ed573",
    "#a55eea", "#ffb142", "#ff6b81", "#ffa502", "#f368e0",
    "#5f27cd", "#ff9ff3", "#ee5253", "#e17055", "#fdcb6e",
    "#e84393", "#6c5ce7", "#fab1a0", "#f39c12", "#8e44ad",
    "#27ae60", "#c0392b", "#f1c40f", "#9b59b6", "#e67e22",
    "#e74c3c", "#d35400", "#cd6136", "#ff7675", "#b33939",
  ];
  const YOKOMOCHI_COLOR = "#ff8c42";

  const $ = (sel) => document.querySelector(sel);

  function norm(s) {
    return (s || "").normalize("NFKC").trim().replace(/\s+/g, "");
  }

  function stripCorp(s) {
    return norm(s).replace(/^(株式会社|有限会社|\(株\)|（株）|\(有\)|（有）)/, "");
  }

  function setMarkerVisible(marker, visible) {
    if (!map || !marker) return;
    if (visible) {
      if (!map.hasLayer(marker)) marker.addTo(map);
    } else if (map.hasLayer(marker)) {
      map.removeLayer(marker);
    }
  }

  function showAllShopMarkers() {
    shopMarkers.forEach(({ marker, site }) => {
      marker.setIcon(createShopIcon(site));
      setMarkerVisible(marker, true);
    });
  }

  function getMapCourse(site) {
    return site.map_course || site.course;
  }

  function resolveMapCourse(course) {
    if (!course || !mapData) return course;
    const merges = mapData.course_merges || {};
    for (const [target, cfg] of Object.entries(merges)) {
      if (course === target) return target;
      if ((cfg.source_courses || []).includes(course)) return target;
    }
    return course;
  }

  function mergedSourceCourses() {
    const src = new Set();
    for (const cfg of Object.values(mapData?.course_merges || {})) {
      for (const c of cfg.source_courses || []) src.add(c);
    }
    return src;
  }

  function enrichSearchAliases() {
    mapData.course_aliases = mapData.course_aliases || {};
    Object.assign(mapData.course_aliases, {
      "1H": "柏1H",
      "1I": "柏1I.5P",
      "2S": "柏2S",
      "2T": "柏2T.5O",
      "3V": "柏3V",
      "3X": "柏3X",
      "5O": "柏2T.5O",
      "5P": "柏1I.5P",
      "3V立": "柏3V車立て",
      "3V車": "柏3V車立て",
      "車立": "柏3V車立て",
    });
  }

  function courseSearchMeta(name) {
    const merges = mapData.course_merges || {};
    for (const [target, cfg] of Object.entries(merges)) {
      if (name === target) return cfg.label || "統合コース";
    }
    if (name === "柏3V車立て") return "ヨドハン千葉";
    return "コース";
  }

  function allCourseGroups() {
    const skip = mergedSourceCourses();
    const pick = (list) => list.filter((c) => !skip.has(c));
    return [
      {
        title: "千葉A（柏）",
        courses: pick([
          "柏1H", "柏1I.5P", "柏2S", "柏2T.5O",
          "柏3V", "柏3V車立て", "柏3X",
        ]),
      },
      {
        title: "千葉B",
        courses: [
          "千Aア", "千Aイ", "千Bカ", "千Bキ", "千Cエ", "千Cオ",
          "千Dタ", "千Dチ", "千E1", "千F2", "千G3", "千H4", "千J6",
        ],
      },
      {
        title: "房",
        courses: ["房館1", "房勝2", "房君3", "房木4", "房木5"],
      },
    ];
  }

  function resolveCourse(query) {
    const q = norm(query);
    if (!q || !mapData) return null;

    const aliases = mapData.course_aliases || {};
    if (aliases[q]) return resolveMapCourse(aliases[q]);

    for (const c of mapData.display_courses || []) {
      if (norm(c) === q) return resolveMapCourse(c);
    }

    for (const c of mapData.display_courses || []) {
      const cn = norm(c);
      if (cn.includes(q) || q.includes(cn)) return resolveMapCourse(c);
    }

    if (mapData.course_merges) {
      for (const name of Object.keys(mapData.course_merges)) {
        if (norm(name) === q || norm(name).includes(q)) return name;
      }
    }
    if (mapData.new_courses) {
      for (const name of Object.keys(mapData.new_courses)) {
        if (norm(name) === q || norm(name).includes(q)) return name;
      }
    }
    if (/^2[tT]$/.test(q) || q === "柏2T") return "柏2T.5O";
    if (/^5[oO]$/.test(q) || q === "柏5O") return "柏2T.5O";
    if (/^1[iI]$/.test(q) || q === "柏1I") return "柏1I.5P";
    if (/^5[pP]$/.test(q) || q === "柏5P") return "柏1I.5P";
    if (/^2[sSｓＳ]$/.test(q) || q === "柏2S" || q === "柏２S") return "柏2S";
    if (/^2[tT]\.?5[oO]?$/.test(q) || q.includes("2T5O") || q.includes("2T.5O")) return "柏2T.5O";
    if (/^1[iI]\.?5[pP]?$/.test(q) || q.includes("1I5P") || q.includes("1I.5P")) return "柏1I.5P";
    if (q.includes("車立") || q.includes("ヨドハン")) return "柏3V車立て";
    if (/^[0-9]+[A-Za-z\u3040-\u9fff]$/.test(q)) {
      const guess = "柏" + q.replace(/[ｓS]/, "S");
      if ((mapData.display_courses || []).includes(guess)) return resolveMapCourse(guess);
    }
    if (/^千[A-Za-z\u3040-\u9fff0-9]+$/.test(q) && (mapData.display_courses || []).includes(q)) {
      return q;
    }
    return null;
  }


  function buildHighlightColors() {
    highlightColors = {};
    const courses = mapData.display_courses || Object.keys(mapData.course_colors || {});
    courses.forEach((course, i) => {
      highlightColors[course] = HIGHLIGHT_PALETTE[i % HIGHLIGHT_PALETTE.length];
    });
  }

  function getCourseHighlightColor(course) {
    return highlightColors[course] || HIGHLIGHT_PALETTE[0];
  }

  function getHighlightColor(site, extraClass) {
    if (!extraClass) return null;
    if (extraClass.includes("is-zone-highlight")) return "#ffd54a";
    if (extraClass.includes("is-course-highlight")) {
      return getCourseHighlightColor(getMapCourse(site));
    }
    return null;
  }

  function createShopIcon(site, extraClass) {
    const color = getHighlightColor(site, extraClass) || DEFAULT_SHOP_COLOR;
    const shape = site.marker_shape || "circle";
    const cls = ["marker-shop", extraClass].filter(Boolean).join(" ");
    const shapeCls = `shape-${shape}`;
    const html = `
      <div class="${cls}" data-id="${site.id}">
        <div class="marker-dot ${shapeCls}" style="--mc:${color}"></div>
        <div class="marker-label">${escapeHtml(site.name)}</div>
      </div>`;
    return L.divIcon({
      html,
      className: "marker-wrap",
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
  }

  function createWarehouseIcon(wh) {
    const html = `
      <div class="marker-warehouse" data-id="${wh.id}">
        <div class="marker-dot"></div>
        <div class="marker-label">${escapeHtml(wh.name)}</div>
      </div>`;
    return L.divIcon({
      html,
      className: "marker-wrap",
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatJpDate(iso) {
    if (!iso) return "—";
    const parts = String(iso).split("-");
    if (parts.length < 3) return iso;
    return `${Number(parts[1])}月${Number(parts[2])}日`;
  }

  function formatGenerated(iso) {
    if (!iso) return "—";
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return iso;
    return `${Number(m[2])}/${Number(m[3])}`;
  }

  function formatVisitPeriodLabel() {
    const start = mapData?.visit_period_start;
    const end = mapData?.visit_period_end;
    if (!start && !end) return "";
    return `配送回数集計 ${formatJpDate(start)}〜${formatJpDate(end)}`;
  }

  function refreshVisitPeriodLabel() {
    const el = $("#visitPeriodText");
    if (!el) return;
    const label = formatVisitPeriodLabel();
    el.textContent = label;
    el.hidden = !label;
  }

  function defaultStatusText() {
    return `現場 ${mapData.site_count}件 / 更新 ${formatGenerated(mapData.generated)}`;
  }

  function formatVisitLine(site) {
    if (site.visit_count == null) return "運送回数: —";
    const n = Number(site.visit_count) || 0;
    if (n === 0) return "運送回数: 0回";
    const start = site.first_visit;
    const end = site.last_visit;
    if (start && end) {
      return `運送回数: ${n}回（${formatJpDate(start)}〜${formatJpDate(end)}）`;
    }
    if (end) return `運送回数: ${n}回（最終: ${formatJpDate(end)}）`;
    return `運送回数: ${n}回`;
  }

  function formatSitePopup(site) {
    const mc = getMapCourse(site);
    let html = `<b>${escapeHtml(site.name)}</b><br>`;
    html += `地図コース: ${escapeHtml(mc)}`;
    if (site.master_course && site.master_course !== mc) {
      html += `<br>マスタ: ${escapeHtml(site.master_course)}`;
    }
    html += `<br>${escapeHtml(site.address)}`;
    html += `<br>${escapeHtml(formatVisitLine(site))}`;
    return html;
  }

  function clearRoutes() {
    routeLayers.forEach((l) => map.removeLayer(l));
    routeLayers = [];
  }

  function resetHighlight() {
    activeSelections = [];
    showAllShopMarkers();
    clearRoutes();
    hideHint();
    renderSearchTags();
  }

  function selectionKey(sel) {
    if (sel.type === "shop") return `shop:${sel.siteId}`;
    if (sel.type === "shops") return `shops:${sel.siteIds.slice().sort().join(",")}`;
    if (sel.type === "course") return `course:${sel.course}`;
    if (sel.type === "zone") return `zone:${sel.zoneKey}`;
    if (sel.type === "yokomochi") return `yokomochi:${sel.yokomochiId}`;
    if (sel.type === "warehouse") return `warehouse:${sel.warehouseId}`;
    return `raw:${sel.label}`;
  }

  function addSelection(sel) {
    const key = selectionKey(sel);
    if (activeSelections.some((s) => s.key === key)) {
      showHint(`「${sel.label}」は既に表示中です`);
      return false;
    }
    activeSelections.push({ ...sel, key });
    applyAllSelections();
    return true;
  }

  function removeSelection(key) {
    activeSelections = activeSelections.filter((s) => s.key !== key);
    applyAllSelections();
  }

  function renderSearchTags() {
    const el = $("#searchTags");
    if (!el) return;
    if (!activeSelections.length) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = activeSelections
      .map(
        (sel) =>
          `<span class="search-tag">` +
          `<span>${escapeHtml(sel.label)}</span>` +
          `<button type="button" class="search-tag__remove" data-key="${escapeHtml(sel.key)}" aria-label="削除">×</button>` +
          `</span>`
      )
      .join("");
    el.querySelectorAll(".search-tag__remove").forEach((btn) => {
      btn.addEventListener("click", () => removeSelection(btn.dataset.key));
    });
  }

  function applyAllSelections() {
    clearRoutes();
    renderSearchTags();

    if (!activeSelections.length) {
      showAllShopMarkers();
      hideHint();
      $("#statusText").textContent = defaultStatusText();
      return;
    }

    const visibleIds = new Set();
    const highlightMode = new Map();

    activeSelections.forEach((sel) => {
      if (sel.type === "shop") {
        visibleIds.add(sel.siteId);
        highlightMode.set(sel.siteId, "shop");
      } else if (sel.type === "shops") {
        sel.siteIds.forEach((id) => {
          visibleIds.add(id);
          highlightMode.set(id, "shop");
        });
      } else if (sel.type === "course") {
        shopMarkers.forEach(({ site }) => {
          if (getMapCourse(site) === sel.course) {
            visibleIds.add(site.id);
            highlightMode.set(site.id, "course");
          }
        });
      } else if (sel.type === "zone") {
        shopMarkers.forEach(({ site }) => {
          if (site.zone === sel.zoneKey) {
            visibleIds.add(site.id);
            highlightMode.set(site.id, "zone");
          }
        });
      }
    });

    shopMarkers.forEach(({ marker, site }) => {
      if (visibleIds.has(site.id)) {
        const mode = highlightMode.get(site.id);
        const extra =
          mode === "course" ? "is-course-highlight" : "is-zone-highlight";
        marker.setIcon(createShopIcon(site, extra));
        setMarkerVisible(marker, true);
      } else {
        setMarkerVisible(marker, false);
      }
    });

    activeSelections.forEach((sel) => {
      if (sel.type === "course") {
        const matched = shopMarkers
          .map(({ site }) => site)
          .filter((s) => getMapCourse(s) === sel.course && visibleIds.has(s.id));
        const color = getCourseHighlightColor(sel.course);
        const hubId =
          mapData.course_merges?.[sel.course]?.hub ||
          mapData.new_courses?.[sel.course]?.hub ||
          matched[0]?.hub ||
          (sel.course.startsWith("柏") || sel.course.includes("千葉A")
            ? "yachiyo_dp"
            : "esr_kazo");
        drawHubToSites(hubId, matched, color);
      } else if (sel.type === "shop") {
        const site = mapData.sites.find((s) => s.id === sel.siteId);
        if (site) {
          const hubId = site.hub || "yachiyo_dp";
          drawRoute(
            getWarehouse(hubId),
            site,
            getCourseHighlightColor(getMapCourse(site)),
            { weight: 3 }
          );
        }
      } else if (sel.type === "yokomochi") {
        const y = (mapData.yokomochi || []).find((x) => x.id === sel.yokomochiId);
        if (y) {
          const from = getWarehouse(y.from);
          const to = getWarehouse(y.to);
          drawRoute(from, to, YOKOMOCHI_COLOR, { weight: 5 });
        }
      } else if (sel.type === "warehouse") {
        const wh = getWarehouse(sel.warehouseId);
        if (wh) {
          map.setView([wh.lat, wh.lng], 10);
          const wm = warehouseMarkers[sel.warehouseId];
          if (wm) wm.openPopup();
        }
      }
    });

    const visibleSites = shopMarkers
      .map(({ site }) => site)
      .filter((s) => visibleIds.has(s.id));

    if (visibleSites.length) {
      map.fitBounds(
        L.latLngBounds(visibleSites.map((s) => [s.lat, s.lng])),
        { padding: [60, 60], maxZoom: visibleSites.length === 1 ? 14 : 12 }
      );
    } else {
      activeSelections.forEach((sel) => {
        if (sel.type !== "yokomochi") return;
        const y = (mapData.yokomochi || []).find((x) => x.id === sel.yokomochiId);
        if (!y) return;
        const from = getWarehouse(y.from);
        const to = getWarehouse(y.to);
        if (from && to) {
          map.fitBounds(L.latLngBounds([[from.lat, from.lng], [to.lat, to.lng]]), {
            padding: [80, 80],
          });
        }
      });
    }

    const labels = activeSelections.map((s) => s.label).join("、");
    showHint(`${visibleSites.length}件表示中 … ${labels}`);
    $("#statusText").textContent = `表示 ${visibleSites.length}件 / 検索 ${activeSelections.length}件`;
  }

  function findShops(query) {
    const q = norm(query);
    const qCorp = stripCorp(query);
    if (!q) return [];
    const results = [];
    for (const s of mapData.sites) {
      const names = [s.name, ...(s.search_names || []), ...(s.aliases || [])];
      let best = 0;
      for (const name of names) {
        const n = norm(name);
        const nc = stripCorp(name);
        if (n === q || nc === qCorp) best = Math.max(best, 100);
        else if (n.startsWith(q) || nc.startsWith(qCorp)) best = Math.max(best, 80);
        else if (n.includes(q) || nc.includes(qCorp)) best = Math.max(best, 50);
        else if (q.length >= 2 && (q.includes(nc) || nc.includes(qCorp))) {
          best = Math.max(best, 40);
        }
      }
      const addr = norm(s.address || "");
      if (best < 50 && q.length >= 2 && addr.includes(q)) best = 30;
      if (best > 0) results.push({ site: s, score: best });
    }
    results.sort((a, b) => b.score - a.score || a.site.name.localeCompare(b.site.name, "ja"));
    return results;
  }

  function resolveSearchToSelection(raw) {
    const q = norm(raw);
    if (!q) return null;

    const shopHits = findShops(raw);
    const top = shopHits[0];
    if (top && top.score >= 100) {
      return { type: "shop", siteId: top.site.id, label: top.site.name };
    }
    if (top && top.score >= 80 && shopHits.length === 1) {
      return { type: "shop", siteId: top.site.id, label: top.site.name };
    }

    if (q === "千葉A" || q === "千葉ａ" || q.toUpperCase() === "CHIBAA") {
      return { type: "zone", zoneKey: "chiba_a", label: "千葉A" };
    }
    if (q === "千葉B" || q.toUpperCase() === "CHIBAB") {
      return { type: "zone", zoneKey: "chiba_b", label: "千葉B" };
    }
    if (q.includes("横持") || q.includes("ヨコモチ")) {
      const id =
        q.includes("木更津") || q.includes("NBS")
          ? "yokomochi_kisarazu"
          : "yokomochi_yachiyo";
      const y = (mapData.yokomochi || []).find((x) => x.id === id);
      return { type: "yokomochi", yokomochiId: id, label: y?.name || "横持ち" };
    }
    if (q === "房" || /^房[館勝君木]/.test(q)) {
      return { type: "zone", zoneKey: "funa", label: "房" };
    }
    if (q.includes("八千代") && q.includes("DP")) {
      return { type: "yokomochi", yokomochiId: "yokomochi_yachiyo", label: "八千代DP横持ち" };
    }
    if (q.includes("ESR") || q === "加須") {
      return { type: "warehouse", warehouseId: "esr_kazo", label: "ESR加須" };
    }
    if (q === "NBS" || q.includes("木更津DP")) {
      return { type: "yokomochi", yokomochiId: "yokomochi_kisarazu", label: "木更津横持ち" };
    }

    const course = resolveCourse(q);
    if (course) {
      return { type: "course", course, label: course };
    }

    if (top && top.score >= 50) {
      if (shopHits.length === 1) {
        return { type: "shop", siteId: top.site.id, label: top.site.name };
      }
      const strong = shopHits.filter((h) => h.score >= 50);
      if (strong.length > 1 && strong.length <= 12) {
        return {
          type: "shops",
          siteIds: strong.map((h) => h.site.id),
          label: `「${raw}」${strong.length}件`,
        };
      }
      if (strong.length === 1) {
        return { type: "shop", siteId: strong[0].site.id, label: strong[0].site.name };
      }
    }

    return null;
  }

  function addSelectionFromQuery(raw) {
    const q = norm(raw);
    if (!q) return;
    const sel = resolveSearchToSelection(raw);
    if (!sel) {
      showHint(`「${raw}」に一致なし。候補から選ぶか: 千葉A / 2S / 工務店名`);
      return;
    }
    if (addSelection(sel)) {
      $("#searchInput").value = "";
      hideSuggestions();
    }
  }

  function handleSearch(raw) {
    addSelectionFromQuery(raw);
  }

  function highlightZone(zoneKey, label) {
    addSelection({ type: "zone", zoneKey, label });
  }

  function highlightCourse(course) {
    addSelection({ type: "course", course, label: course });
  }

  function highlightSingleShop(site) {
    addSelection({ type: "shop", siteId: site.id, label: site.name });
    shopMarkers.forEach(({ marker, site: s }) => {
      if (s.id === site.id) marker.openPopup();
    });
  }

  function showYokomochi(type) {
    const y = (mapData.yokomochi || []).find((x) => x.id === type);
    if (!y) return;
    addSelection({ type: "yokomochi", yokomochiId: type, label: y.name });
  }

  function showWarehouse(wid) {
    if (wid === "yachiyo_dp") {
      showYokomochi("yokomochi_yachiyo");
      return;
    }
    if (wid === "nbs") {
      showYokomochi("yokomochi_kisarazu");
      return;
    }
    const wh = getWarehouse(wid);
    if (!wh) return;
    map.setView([wh.lat, wh.lng], 10);
    showHint(`${wh.name}（倉庫・赤）`);
    $("#statusText").textContent = wh.name;
  }

  function showHint(text) {
    const el = $("#searchHint");
    el.textContent = text;
    el.classList.add("is-visible");
  }

  function hideHint() {
    const el = $("#searchHint");
    el.classList.remove("is-visible");
  }

  function getWarehouse(id) {
    return (mapData.warehouses || []).find((w) => w.id === id);
  }

  function drawRoute(from, to, color, opts = {}) {
    if (!from || !to) return;
    const latlngs = [
      [from.lat, from.lng],
      [to.lat, to.lng],
    ];
    const line = L.polyline(latlngs, {
      color,
      weight: opts.weight || 3,
      opacity: 0.35,
      dashArray: "6 8",
    }).addTo(map);

    const ant = L.polyline.antPath(latlngs, {
      delay: 280,
      dashArray: [12, 18],
      weight: opts.weight || 4,
      color,
      pulseColor: "#ffffff",
      opacity: 0.9,
    }).addTo(map);

    routeLayers.push(line, ant);
  }

  function drawHubToSites(hubId, sites, color) {
    const hub = getWarehouse(hubId);
    if (!hub) return;
    sites.forEach((site) => {
      drawRoute(hub, site, color, { weight: 2.5 });
    });
  }

  function buildSearchCatalog() {
    const items = [
      { value: "千葉A", label: "千葉A", meta: "柏1H〜5P・八千代DP", category: "エリア", priority: 1 },
      { value: "千葉B", label: "千葉B", meta: "千Aア〜千J6・ESR加須", category: "エリア", priority: 1 },
      { value: "房", label: "房", meta: "房館1〜房木5・NBS方面", category: "エリア", priority: 1 },
      { value: "八千代DP", label: "八千代DP", meta: "倉庫（赤）", category: "倉庫", priority: 1 },
      { value: "ESR加須", label: "ESR加須", meta: "倉庫（赤）", category: "倉庫", priority: 1 },
      { value: "NBS", label: "NBS", meta: "木更津DP・倉庫（赤）", category: "倉庫", priority: 1 },
      { value: "横持ち", label: "横持ち", meta: "八千代DP → ESR加須", category: "横持ち", priority: 1 },
      { value: "木更津横持", label: "木更津横持", meta: "ESR加須 → 木更津", category: "横持ち", priority: 1 },
    ];
    const seen = new Set(items.map((i) => norm(i.value)));

    for (const group of allCourseGroups()) {
      for (const c of group.courses) {
        const key = norm(c);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          value: c,
          label: c,
          meta: courseSearchMeta(c),
          category: "コース",
          priority: 2,
          group: group.title,
        });
      }
    }

    for (const s of mapData.sites || []) {
      const names = [s.name, ...(s.search_names || [])];
      for (const name of names) {
        const key = norm(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push({
          value: name,
          label: name,
          meta: getMapCourse(s),
          category: "工務店",
          priority: 3,
          siteId: s.id,
        });
      }
    }

    searchCatalog = items;
  }

  function filterSuggestions(query) {
    const q = norm(query);
    let pool = searchCatalog;
    if (!q) {
      return pool.filter((i) => i.priority < 3);
    }
    return pool
      .filter((i) => {
        const blob = norm(`${i.value}${i.label}${i.meta}${i.category}${i.group || ""}`);
        return blob.includes(q);
      })
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 18);
  }

  function hideSuggestions() {
    const el = $("#searchSuggestions");
    el.hidden = true;
    el.innerHTML = "";
    suggestionActiveIndex = -1;
  }

  function renderSuggestions(items) {
    const el = $("#searchSuggestions");
    if (!items.length) {
      hideSuggestions();
      return;
    }
    el.innerHTML = items
      .map(
        (item, idx) =>
          `<li class="search-suggestions__item${idx === suggestionActiveIndex ? " is-active" : ""}" role="option" data-idx="${idx}" data-value="${escapeHtml(item.value)}">` +
          `<span class="search-suggestions__cat">${escapeHtml(item.category)}</span>` +
          `<span class="search-suggestions__label">${escapeHtml(item.label)}</span>` +
          `<span class="search-suggestions__meta">${escapeHtml(item.meta)}</span>` +
          `</li>`
      )
      .join("");
    el.hidden = false;
    el._items = items;
  }

  function showSuggestionsForInput() {
    const input = $("#searchInput");
    renderSuggestions(filterSuggestions(input.value));
  }

  function pickSuggestion(value) {
    const input = $("#searchInput");
    const list = $("#searchSuggestions");
    const item = (list._items || []).find((i) => i.value === value);
    input.value = "";
    hideSuggestions();
    if (item?.siteId) {
      addSelection({ type: "shop", siteId: item.siteId, label: item.label });
      return;
    }
    addSelectionFromQuery(value);
  }

  function bindSearchSuggestions() {
    const input = $("#searchInput");
    const list = $("#searchSuggestions");

    input.addEventListener("focus", () => showSuggestionsForInput());
    input.addEventListener("input", () => {
      suggestionActiveIndex = -1;
      showSuggestionsForInput();
    });

    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest(".search-suggestions__item");
      if (!li) return;
      e.preventDefault();
      pickSuggestion(li.dataset.value);
    });

    input.addEventListener("keydown", (e) => {
      const items = list._items || [];
      if (e.key === "ArrowDown") {
        if (list.hidden && items.length === 0) showSuggestionsForInput();
        const visible = list._items || [];
        if (!visible.length) return;
        e.preventDefault();
        suggestionActiveIndex = Math.min(suggestionActiveIndex + 1, visible.length - 1);
        renderSuggestions(visible);
        return;
      }
      if (e.key === "ArrowUp") {
        const visible = list._items || [];
        if (!visible.length) return;
        e.preventDefault();
        suggestionActiveIndex = Math.max(suggestionActiveIndex - 1, 0);
        renderSuggestions(visible);
        return;
      }
      if (e.key === "Escape") {
        hideSuggestions();
        return;
      }
      if (e.key === "Enter") {
        if (!list.hidden && suggestionActiveIndex >= 0 && items[suggestionActiveIndex]) {
          e.preventDefault();
          pickSuggestion(items[suggestionActiveIndex].value);
          return;
        }
        hideSuggestions();
        handleSearch(input.value);
      }
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-box")) hideSuggestions();
    });
  }

  function buildLegend() {
    const el = $("#legend");
    const zones = mapData.zones || {};
    const ml = mapData.marker_legend || {};
    let html = "<h3>区分・形状</h3>";
    html += `<div class="legend-row"><span class="legend-swatch legend-swatch--circle"></span>${ml.circle || "通常（丸）"}</div>`;
    html += `<div class="legend-row"><span class="legend-swatch legend-swatch--triangle"></span>${ml.triangle || "2t（三角）"}</div>`;
    html += `<div class="legend-row"><span class="legend-swatch legend-swatch--square"></span>${ml.square || "4t（四角）"}</div>`;
    html += `<div class="legend-row"><span class="legend-swatch" style="background:#ff4757"></span>倉庫（赤）</div>`;
    html += "<h3 style='margin-top:10px'>コース一覧</h3>";
    for (const group of allCourseGroups()) {
      html += `<div class="legend-group">${escapeHtml(group.title)}</div>`;
      for (const c of group.courses) {
        html += `<div class="legend-row legend-row--course"><button type="button" class="legend-course-btn" data-course="${escapeHtml(c)}">${escapeHtml(c)}</button></div>`;
      }
    }
    html += "<h3 style='margin-top:10px'>エリア</h3>";
    for (const [, z] of Object.entries(zones)) {
      html += `<div class="legend-row"><span>${z.label}</span></div>`;
    }
    el.innerHTML = html;
    el.querySelectorAll(".legend-course-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const course = btn.dataset.course;
        $("#searchInput").value = "";
        hideSuggestions();
        addSelection({ type: "course", course, label: course });
      });
    });
  }

  function initMap() {
    map = L.map("map", {
      zoomControl: true,
      minZoom: 8,
      maxZoom: 16,
    }).setView([35.45, 140.25], 9);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap",
      maxZoom: 18,
    }).addTo(map);

    // 千葉県市町村界
    fetch(GEOJSON_URL)
      .then((r) => r.json())
      .then((geo) => {
        cityLayer = L.geoJSON(geo, {
          style: {
            className: "chiba-city",
            fillColor: "#e8f0f8",
            fillOpacity: 0.65,
            color: "#8aa4bc",
            weight: 1,
          },
          onEachFeature(f, layer) {
            const name = f.properties?.N03_004 || f.properties?.name || "";
            if (name) layer.bindTooltip(name, { sticky: true, opacity: 0.85 });
          },
        }).addTo(map);

        const bounds = cityLayer.getBounds();
        if (bounds.isValid()) {
          map.fitBounds(bounds.pad(0.05));
        }
      })
      .catch(() => {
        map.setView([35.45, 140.25], 9);
      });

    // 倉庫（常時表示・赤）
    (mapData.warehouses || []).forEach((wh) => {
      const marker = L.marker([wh.lat, wh.lng], {
        icon: createWarehouseIcon(wh),
        zIndexOffset: 1000,
      })
        .bindPopup(`<b>${escapeHtml(wh.name)}</b><br>${escapeHtml(wh.address)}`)
        .addTo(map);
      warehouseMarkers[wh.id] = marker;
    });

    // 工務店（常時表示・青。調べる／クリックでハイライト色）
    (mapData.sites || []).forEach((site) => {
      const marker = L.marker([site.lat, site.lng], {
        icon: createShopIcon(site),
        zIndexOffset: 100,
      })
        .bindPopup(formatSitePopup(site))
        .addTo(map);
      marker.on("click", () => highlightSingleShop(site));
      shopMarkers.push({ marker, site });
    });

    // ESR加須は千葉外 →  bounds に含める
    const allPts = [
      ...(mapData.sites || []).map((s) => [s.lat, s.lng]),
      ...(mapData.warehouses || []).map((w) => [w.lat, w.lng]),
    ];
    if (allPts.length) {
      map.fitBounds(L.latLngBounds(allPts), { padding: [40, 40], maxZoom: 10 });
    }

    $("#statusText").textContent = defaultStatusText();
    refreshVisitPeriodLabel();
    scheduleMapInvalidate();
  }

  function scheduleMapInvalidate() {
    if (!map) return;
    const run = () => {
      map.invalidateSize(true);
    };
    run();
    requestAnimationFrame(run);
    setTimeout(run, 50);
    setTimeout(run, 250);
    setTimeout(run, 800);
  }

  function bindEvents() {
    $("#searchBtn").addEventListener("click", () => {
      hideSuggestions();
      handleSearch($("#searchInput").value);
    });
    $("#resetBtn").addEventListener("click", () => {
      $("#searchInput").value = "";
      hideSuggestions();
      resetHighlight();
      $("#statusText").textContent = defaultStatusText();
    });
    bindSearchSuggestions();
  }

  function setStatus(text) {
    const el = $("#statusText");
    if (el) el.textContent = text;
  }

  function liveVersionUrl() {
    const meta = document.querySelector('meta[name="chiba-map-live-base"]');
    if (meta?.content?.trim()) {
      return meta.content.trim().replace(/\/?$/, "/") + ".version.json";
    }
    if (IS_WEB_HOST) {
      return new URL(".version.json", window.location.href).toString();
    }
    return ".version.json";
  }

  function pageBuildStamp() {
    return document.querySelector('meta[name="chiba-map-build"]')?.content?.trim() || "";
  }

  async function fetchLiveVersionMeta() {
    try {
      const r = await fetch(`${liveVersionUrl()}?v=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch (_) {
      return null;
    }
  }

  async function maybeReloadForLatestBuild() {
    if (!IS_WEB_HOST && !document.querySelector('meta[name="chiba-map-live-base"]')) {
      return;
    }
    const ver = await fetchLiveVersionMeta();
    if (!ver?.built) return;

    const pageBuild = pageBuildStamp();
    const staleHtml = pageBuild && ver.built > pageBuild;
    const reloadKey = "chiba-map-reloaded-for";
    if (staleHtml && sessionStorage.getItem(reloadKey) !== ver.built) {
      sessionStorage.setItem(reloadKey, ver.built);
      const url = new URL(window.location.href);
      url.searchParams.set("_", String(Date.now()));
      window.location.replace(url.toString());
      await new Promise(() => {});
    }
  }

  async function loadMapDataOnce() {
    if (typeof L === "undefined") {
      throw new Error("地図ライブラリ（Leaflet）が読み込めません。ネット接続を確認して再読込してください。");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    try {
      const r = await fetch(`${DATA_URL}?v=${Date.now()}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timer);
      if (!r.ok) {
        throw new Error(
          IS_WEB_HOST
            ? "map_data.json を読めません。ページを再読込（Ctrl+F5）するか、しばらく待ってから再度開いてください。"
            : "map_data.json を読めません。ターミナルで cd AI化/千葉配送地図 && python3 -m http.server 8765 を実行してください。"
        );
      }
      const data = await r.json();
      const ver = await fetchLiveVersionMeta();
      if (ver?.map_generated && data.generated && ver.map_generated > data.generated) {
        const reloadKey = "chiba-map-data-reloaded-for";
        if (sessionStorage.getItem(reloadKey) !== ver.map_generated) {
          sessionStorage.setItem(reloadKey, ver.map_generated);
          const url = new URL(window.location.href);
          url.searchParams.set("_", String(Date.now()));
          window.location.replace(url.toString());
          await new Promise(() => {});
        }
      }
      return data;
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        throw new Error(
          IS_WEB_HOST
            ? "地図データの読込がタイムアウトしました。回線を確認して再読込してください。"
            : "地図データの読込がタイムアウトしました。サーバーを再起動してページを再読込してください。"
        );
      }
      if (err instanceof TypeError) {
        throw new Error(
          IS_WEB_HOST
            ? "地図データに接続できません。URLを確認するか、しばらく待ってから再読込してください。"
            : "地図サーバーに接続できません。python3 -m http.server 8765 が起動しているか確認してください。"
        );
      }
      throw err;
    }
  }

  async function loadMapDataWithRetry(maxAttempts = 4) {
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await loadMapDataOnce();
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  }

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function isLiveAccessRequired() {
    return !!(
      document.querySelector('meta[name="chiba-map-access-hash"]') ||
      document.querySelector('meta[name="chiba-map-access-key"]') ||
      (IS_WEB_HOST && document.querySelector('meta[name="chiba-map-live-base"]'))
    );
  }

  function accessStorageKey() {
    const hashMeta = document.querySelector('meta[name="chiba-map-access-hash"]');
    if (hashMeta?.content?.trim()) {
      return `chiba-map-ok-${hashMeta.content.trim().slice(0, 16)}`;
    }
    const keyMeta = document.querySelector('meta[name="chiba-map-access-key"]');
    if (keyMeta?.content?.trim()) {
      return `chiba-map-ok-legacy-${keyMeta.content.trim().slice(0, 8)}`;
    }
    return null;
  }

  async function verifyAccessKey(key) {
    const trimmed = (key || "").trim();
    if (!trimmed) return false;
    const hashMeta = document.querySelector('meta[name="chiba-map-access-hash"]');
    if (hashMeta?.content?.trim()) {
      return (await sha256Hex(trimmed)) === hashMeta.content.trim();
    }
    const keyMeta = document.querySelector('meta[name="chiba-map-access-key"]');
    if (keyMeta?.content?.trim()) {
      return trimmed === keyMeta.content.trim();
    }
    return true;
  }

  function showAccessGate() {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "access-gate";
      overlay.innerHTML = `
        <div class="access-gate__panel">
          <div class="access-gate__icon" aria-hidden="true">🔒</div>
          <h2 class="access-gate__title">千葉配送地図</h2>
          <p class="access-gate__lead">共有された合言葉を入力してください</p>
          <label class="access-gate__label" for="accessKeyInput">合言葉</label>
          <input id="accessKeyInput" class="access-gate__input" type="password" placeholder="合言葉を入力" autocomplete="off">
          <button id="accessKeyBtn" type="button" class="access-gate__btn">地図を開く</button>
          <p id="accessKeyErr" class="access-gate__err" hidden></p>
        </div>
      `;
      document.body.appendChild(overlay);
      document.body.classList.add("access-gate-open");

      const input = overlay.querySelector("#accessKeyInput");
      const btn = overlay.querySelector("#accessKeyBtn");
      const err = overlay.querySelector("#accessKeyErr");

      async function tryKey() {
        if (!(await verifyAccessKey(input.value))) {
          err.textContent =
            "合言葉が違います。社長から受け取ったリンク・合言葉をご確認ください。";
          err.hidden = false;
          input.focus();
          input.select();
          return;
        }
        const sk = accessStorageKey();
        if (sk) sessionStorage.setItem(sk, "1");
        overlay.remove();
        document.body.classList.remove("access-gate-open");
        resolve();
      }

      btn.addEventListener("click", tryKey);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") tryKey();
      });
      input.focus();
    });
  }

  async function ensureLiveAccess() {
    if (!isLiveAccessRequired()) return;
    const sk = accessStorageKey();
    if (sk && sessionStorage.getItem(sk) === "1") return;

    const urlKey = new URLSearchParams(window.location.search).get("k") || "";
    if (urlKey && (await verifyAccessKey(urlKey)) {
      if (sk) sessionStorage.setItem(sk, "1");
      return;
    }

    await showAccessGate();
  }

  function startLiveVersionWatch(initialBuilt) {
    if (!IS_WEB_HOST && !document.querySelector('meta[name="chiba-map-live-base"]')) {
      return;
    }
    let current = initialBuilt || pageBuildStamp() || "";
    async function poll() {
      const v = await fetchLiveVersionMeta();
      if (!v?.built) return;
      if (current && v.built > current) {
        showHint("新しい版があります。再読込します…");
        setTimeout(() => {
          const url = new URL(window.location.href);
          url.searchParams.set("_", String(Date.now()));
          window.location.replace(url.toString());
        }, 400);
      }
    }
    poll();
    setInterval(poll, 20000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") poll();
    });
    window.addEventListener("pageshow", (ev) => {
      if (ev.persisted) {
        scheduleMapInvalidate();
        poll();
      }
    });
  }

  async function bootstrap() {
    try {
      await ensureLiveAccess();
      await maybeReloadForLatestBuild();
      const data = await loadMapDataWithRetry();
      mapData = data;
      const hasVisit = (data.sites || []).some((s) => "visit_count" in s);
      if ((data.sites || []).length && !hasVisit) {
        throw new Error(
          "地図データが古いです。Cmd+Shift+R で再読込するか、python3 build_chiba_map_data.py を実行してください。"
        );
      }
      enrichSearchAliases();
      buildHighlightColors();
      buildSearchCatalog();
      buildLegend();
      initMap();
      bindEvents();
      window.addEventListener("load", scheduleMapInvalidate);
      window.addEventListener("resize", scheduleMapInvalidate);
      const ver = await fetchLiveVersionMeta();
      startLiveVersionWatch(ver?.built || data.generated);
    } catch (err) {
      setStatus(err.message);
      showHint(err.message);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
