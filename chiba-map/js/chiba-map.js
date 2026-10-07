/**
 * 伊藤商事 千葉配送地図
 * 現場マスタ + 倉庫 + コースルート検索
 */
(function () {
  "use strict";

  const DATA_URL = "data/map_data.json";
  const SITE_CARDS_URL = "data/site_cards.json";
  /** 事例119 … 配送回数・重量の表示終端（build_chiba_map_data.MAP_PERIOD_FLOOR と揃える） */
  const MAP_VISIT_PERIOD_FLOOR = "2026-10-06";
  const GEOJSON_URL = "data/chiba_cities.geojson";
  const IS_WEB_HOST = /github\.io$/i.test(window.location.hostname);

  let map;
  let mapData;
  /** @type {Record<string, object>} */
  let siteCardsById = {};
  const SITE_MEDIA_DB_NAME = "ito_chiba_map_site_media";
  const SITE_MEDIA_DB_VER = 1;
  const SITE_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
  const SITE_MEDIA_MANIFEST_URL = "data/site_media/manifest.json";
  /** Pages CDN 遅延時も共有写真を出す（事例10・116） */
  const SITE_MEDIA_RAW_BASE =
    "https://raw.githubusercontent.com/RUZ1229/ito-shoji-hp/main/chiba-map/";
  const PDFJS_ASSET_V = "20261006T142200";
  /** @type {string[]} */
  let siteCardPanelObjectUrls = [];
  /** @type {Map<string, string>} */
  const siteMediaPdfDataUrlCache = new Map();
  /** @type {Map<string, string>} */
  const siteMediaPdfThumbCache = new Map();
  /** @type {Promise<unknown>|null} */
  let pdfJsLoadPromise = null;
  /** @type {string|null} */
  let photoViewerPrintObjectUrl = null;
  let shopMarkers = [];
  let warehouseMarkers = {};
  let routeLayers = [];
  let cityLayer;
  let searchCatalog = [];
  let highlightColors = {};
  let suggestionActiveIndex = -1;
  /** @type {Array<{key:string,type:string,label:string,siteId?:string,siteIds?:string[],course?:string,zoneKey?:string,yokomochiId?:string,warehouseId?:string}>} */
  let activeSelections = [];

  const DEFAULT_SHOP_COLOR = "#2488d4";
  const WAREHOUSE_COLOR = "#ff4757";
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
      applyShopMarkerStyle(marker, site, "");
      setMarkerVisible(marker, true);
    });
  }

  function isCollabCustomCourse(name) {
    const nc = mapData?.new_courses?.[name];
    return Array.isArray(nc?.site_ids);
  }

  function isActiveCollabCustomCourse(name) {
    if (!isCollabCustomCourse(name)) return true;
    const active = mapData.collab_custom_courses;
    if (active && typeof active === "object" && Object.prototype.hasOwnProperty.call(active, name)) {
      return true;
    }
    if (active != null) {
      // フィールドあり（空{}含む）で名前が無い → 削除済み
      return false;
    }
    // 旧 map_data（フィールド未同梱）のみ new_courses を正とする
    return Boolean(mapData.new_courses?.[name]);
  }

  function isKnownCourse(course) {
    if (!course || !mapData) return false;
    if (mapData.course_merges?.[course]) return true;
    if (mapData.new_courses?.[course]) return isActiveCollabCustomCourse(course);
    if ((mapData.display_courses || []).includes(course)) return isActiveCollabCustomCourse(course);
    return false;
  }

  function getMapCourse(site) {
    const master = site.master_course || site.course || "";
    const mc = site.map_course || master;
    if (mc === master) return mc;
    if (!isKnownCourse(mc)) return master;
    const memberIds = mapData.new_courses?.[mc]?.site_ids;
    if (Array.isArray(memberIds) && memberIds.length && site.id && !memberIds.includes(site.id)) {
      return master;
    }
    return mc;
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
      "4V": "柏４V",
      "柏4V": "柏４V",
      "5O": "柏2T.5O",
      "5P": "柏1I.5P",
      "3V立": "柏3V車立て",
      "3V車": "柏3V車立て",
      "車立": "柏3V車立て",
    });
    for (const cname of Object.keys(mapData.collab_custom_courses || {})) {
      const n = norm(cname);
      if (n && !mapData.course_aliases[n]) {
        mapData.course_aliases[n] = cname;
      }
    }
  }

  function courseSearchMeta(name) {
    const merges = mapData.course_merges || {};
    for (const [target, cfg] of Object.entries(merges)) {
      if (name === target) return cfg.label || "統合コース";
    }
    if (name === "柏3V車立て") return "ヨドハン千葉";
    return "コース";
  }

  function zoneToLegendGroupTitle(zone) {
    if (zone === "chiba_a") return "千葉A（柏）";
    if (zone === "funa") return "房";
    return "千葉B";
  }

  /** コース作成時の倉庫（hub）→ 左パネル区分（八千代DP=千葉A / ESR加須=千葉B / NBS=房） */
  function hubToLegendGroupTitle(cfg) {
    const hub = (cfg && cfg.hub) || "";
    if (hub === "yachiyo_dp") return "千葉A（柏）";
    if (hub === "esr_kazo") return "千葉B";
    if (hub === "nbs") return "房";
    return zoneToLegendGroupTitle((cfg && cfg.zone) || "chiba_b");
  }

  /** 協調 create_course を区分のコース一覧へ。delete 済みは collab_custom で除外 */
  function appendCollabCoursesToLegendGroups(groups) {
    const byTitle = new Map(groups.map((g) => [g.title, g]));
    const listed = new Set();
    for (const g of groups) {
      for (const c of g.courses) listed.add(norm(c));
    }
    const tryAdd = (courseName, cfg) => {
      if (!courseName || !isActiveCollabCustomCourse(courseName)) return;
      const key = norm(courseName);
      if (listed.has(key)) return;
      const title = hubToLegendGroupTitle(cfg);
      const group = byTitle.get(title);
      if (!group) return;
      group.courses.push(courseName);
      listed.add(key);
    };
    for (const [cname, cfg] of Object.entries(mapData?.collab_custom_courses || {})) {
      tryAdd(cname, cfg);
    }
    for (const [cname, cfg] of Object.entries(mapData?.new_courses || {})) {
      if (mapData?.collab_custom_courses && cname in mapData.collab_custom_courses) continue;
      tryAdd(cname, cfg);
    }
  }

  function allCourseGroups() {
    const skip = mergedSourceCourses();
    const pick = (list) =>
      list.filter((c) => !skip.has(c) && (!isCollabCustomCourse(c) || isActiveCollabCustomCourse(c)));
    const groups = [
      {
        title: "千葉A（柏）",
        courses: pick([
          "柏1H", "柏1I.5P", "柏2S", "柏2T.5O",
          "柏3V", "柏3V車立て", "柏3X",
        ]),
      },
      {
        title: "千葉B",
        courses: pick([
          "千Aア", "千Aイ", "千Bカ", "千Bキ", "千Cエ", "千Cオ",
          "千Dタ", "千Dチ", "千E1", "千F2", "千G3", "千H4", "千J6",
        ]),
      },
      {
        title: "房",
        courses: pick(["房館1", "房勝2", "房君3", "房木4", "房木5"]),
      },
    ];
    appendCollabCoursesToLegendGroups(groups);
    return groups;
  }

  function resolveCourse(query) {
    const q = norm(query);
    if (!q || !mapData) return null;

    const aliases = mapData.course_aliases || {};
    if (aliases[q]) return resolveMapCourse(aliases[q]);

    for (const c of mapData.display_courses || []) {
      if (!isActiveCollabCustomCourse(c)) continue;
      if (norm(c) === q) return resolveMapCourse(c);
    }

    for (const c of mapData.display_courses || []) {
      if (!isActiveCollabCustomCourse(c)) continue;
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
        if (!isActiveCollabCustomCourse(name)) continue;
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
    if (extraClass.includes("is-shop-highlight")) return "#ffd54a";
    if (extraClass.includes("is-zone-highlight")) return "#ffd54a";
    if (extraClass.includes("is-course-highlight")) {
      return getCourseHighlightColor(getMapCourse(site));
    }
    return null;
  }

  const SHOP_DOT_RADIUS = { circle: 7, square: 6.5, triangle: 7 };
  const WH_DOT_RADIUS = 10;
  const WAREHOUSE_PANE = "chibaWarehousePane";

  function getShopDotStyle(site, extraClass) {
    const color = getHighlightColor(site, extraClass) || DEFAULT_SHOP_COLOR;
    const shape = site.marker_shape || "circle";
    const radius = SHOP_DOT_RADIUS[shape] || SHOP_DOT_RADIUS.circle;
    const cls = ["chiba-shop-dot", `shape-${shape}`, extraClass].filter(Boolean).join(" ");
    return {
      radius,
      fillColor: color,
      fillOpacity: 1,
      color,
      weight: shape === "circle" ? 3 : 2.5,
      opacity: 1,
      className: cls,
    };
  }

  function applyShopMarkerStyle(marker, site, extraClass) {
    if (!marker) return;
    marker.setStyle(getShopDotStyle(site, extraClass || ""));
  }

  function getWarehouseDotStyle() {
    return {
      radius: WH_DOT_RADIUS,
      fillColor: WAREHOUSE_COLOR,
      fillOpacity: 1,
      color: WAREHOUSE_COLOR,
      weight: 4,
      opacity: 1,
      className: "chiba-wh-dot",
      pane: WAREHOUSE_PANE,
      zIndexOffset: 2000,
    };
  }

  function reinforceWarehouseMarker(marker) {
    if (!marker) return;
    marker.setStyle(getWarehouseDotStyle());
    const el = marker.getElement?.();
    if (el) {
      el.setAttribute("fill", WAREHOUSE_COLOR);
      el.setAttribute("stroke", WAREHOUSE_COLOR);
      el.setAttribute("fill-opacity", "1");
      el.setAttribute("stroke-opacity", "1");
      el.setAttribute("stroke-width", "4");
    }
  }

  function raiseWarehouseMarkers() {
    Object.values(warehouseMarkers).forEach((marker) => {
      if (!marker || !map?.hasLayer(marker)) return;
      reinforceWarehouseMarker(marker);
      marker.bringToFront();
    });
  }

  const MAP_UI_PAD = {
    topLeft: [260, 128],
    bottomRight: [460, 80],
  };

  function getMapUiPad() {
    const topLeft = [260, 128];
    let bottomRight = [72, 80];
    const panel = document.getElementById("siteCardPanel");
    if (
      document.body.classList.contains("site-card-panel-open") &&
      panel &&
      !panel.hidden
    ) {
      bottomRight[0] = Math.round(panel.getBoundingClientRect().width + 28);
    }
    if (map) {
      const w = map.getSize().x;
      topLeft[0] = Math.min(topLeft[0], Math.round(w * 0.38));
      bottomRight[0] = Math.min(bottomRight[0], Math.round(w * 0.58));
    }
    return { topLeft, bottomRight };
  }

  function focusMapOnLatLng(latlng, zoom) {
    if (!map) return;
    map.setView(latlng, zoom, { animate: false });
    const pad = getMapUiPad();
    const dx = Math.round((pad.bottomRight[0] - pad.topLeft[0]) / 2);
    const dy = Math.round((pad.topLeft[1] - pad.bottomRight[1]) / 2);
    if (dx || dy) map.panBy([dx, dy], { animate: false });
  }

  function fitMapToSites(sites) {
    if (!map || !sites.length) return;
    if (sites.length === 1) {
      focusMapOnLatLng([sites[0].lat, sites[0].lng], 14);
      return;
    }
    const pad = getMapUiPad();
    map.fitBounds(
      L.latLngBounds(sites.map((s) => [s.lat, s.lng])),
      {
        paddingTopLeft: L.point(pad.topLeft[0], pad.topLeft[1]),
        paddingBottomRight: L.point(pad.bottomRight[0], pad.bottomRight[1]),
        maxZoom: 12,
        animate: false,
      }
    );
  }

  function attachTooltipTap(marker, onTap) {
    const bind = () => {
      const el = marker.getTooltip()?.getElement?.();
      if (!el) return;
      if (el.dataset.tapBound === "1") return;
      el.dataset.tapBound = "1";
      el.classList.add("is-map-tappable");
      el.addEventListener("click", (ev) => {
        L.DomEvent.stop(ev);
        onTap();
      });
    };
    marker.on("add", bind);
    marker.on("tooltipopen", bind);
    bind();
  }

  function bindShopLabel(marker, name, onTap) {
    marker.unbindTooltip();
    marker.bindTooltip(name, {
      permanent: true,
      direction: "bottom",
      offset: L.point(0, 5),
      className: "chiba-shop-tooltip",
      opacity: 1,
      interactive: true,
    });
    if (onTap) attachTooltipTap(marker, onTap);
  }

  function bindWarehouseLabel(marker, name, onTap) {
    marker.unbindTooltip();
    marker.bindTooltip(name, {
      permanent: true,
      direction: "bottom",
      offset: L.point(0, 6),
      className: "chiba-wh-tooltip",
      opacity: 1,
      interactive: true,
    });
    if (onTap) attachTooltipTap(marker, onTap);
  }

  function wireShopMarker(marker, site) {
    const open = () => highlightSingleShop(site);
    marker.off("click");
    marker.on("click", open);
    bindShopLabel(marker, site.name, open);
  }

  let printMapLayoutRestore = null;

  function beginPrintMapLayout() {
    const mapEl = document.getElementById("map");
    if (!mapEl) return;
    printMapLayoutRestore = {
      height: mapEl.style.height,
      width: mapEl.style.width,
      position: mapEl.style.position,
      margin: mapEl.style.margin,
      left: mapEl.style.left,
      top: mapEl.style.top,
    };
    mapEl.style.width = "100%";
    mapEl.style.height = "175mm";
    mapEl.style.position = "relative";
    mapEl.style.margin = "0";
    mapEl.style.left = "0";
    mapEl.style.top = "0";
  }

  function endPrintMapLayout() {
    const mapEl = document.getElementById("map");
    if (!mapEl || !printMapLayoutRestore) return;
    mapEl.style.height = printMapLayoutRestore.height;
    mapEl.style.width = printMapLayoutRestore.width;
    mapEl.style.position = printMapLayoutRestore.position;
    mapEl.style.margin = printMapLayoutRestore.margin;
    mapEl.style.left = printMapLayoutRestore.left;
    mapEl.style.top = printMapLayoutRestore.top;
    printMapLayoutRestore = null;
  }

  function syncMapAfterLayout(bounds, maxZoom, done) {
    if (!map) {
      done();
      return;
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      map.invalidateSize({ animate: false });
      setTimeout(done, 120);
    };
    map.invalidateSize({ animate: false });
    if (bounds && bounds.isValid()) {
      map.once("moveend", finish);
      map.fitBounds(bounds, { padding: [36, 36], maxZoom, animate: false });
      setTimeout(finish, 900);
      return;
    }
    finish();
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

  function atLeastMapPeriodFloor(iso) {
    if (!iso) return iso;
    const s = String(iso).trim();
    if (!s) return iso;
    return s < MAP_VISIT_PERIOD_FLOOR ? MAP_VISIT_PERIOD_FLOOR : s;
  }

  /** 配送カード等の記載用（事例117）。月次は map_data の start/end をそのまま（始端は月初）。 */
  function clampWeightMonthPeriodForDisplay(start, end, monthKey) {
    if (!end) return { start, end };
    return { start, end };
  }

  function applyMapPeriodFloor(data) {
    if (!data) return;
    const f = MAP_VISIT_PERIOD_FLOOR;
    const ve = String(data.visit_period_end || "").trim();
    if (ve && ve < f) data.visit_period_end = f;
    const we = String(data.weight_period_end || "").trim();
    if (we && we < f) data.weight_period_end = f;
  }

  function formatVisitPeriodLabel() {
    const start = mapData?.visit_period_start;
    let end = mapData?.visit_period_end;
    if (end && String(end) < MAP_VISIT_PERIOD_FLOOR) {
      end = MAP_VISIT_PERIOD_FLOOR;
    }
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
    let end = atLeastMapPeriodFloor(site.last_visit);
    if (start && end) {
      return `運送回数: ${n}回（${formatJpDate(start)}〜${formatJpDate(end)}）`;
    }
    if (end) return `運送回数: ${n}回（最終: ${formatJpDate(end)}）`;
    return `運送回数: ${n}回`;
  }

  /** 月別重量（新しい月が上）。weight_months 無しは従来の合算1行。 */
  function formatWeightMonthLines(site) {
    const months = site?.weight_months;
    if (Array.isArray(months) && months.length) {
      return months.map((m) => {
        const kg = Number(m.kg) || 0;
        const { start, end } = clampWeightMonthPeriodForDisplay(
          m.start,
          m.end,
          m.month || (m.start ? String(m.start).slice(0, 7) : "")
        );
        if (start && end) {
          return `${kg.toLocaleString()} kg（${formatJpDate(start)}〜${formatJpDate(end)}）`;
        }
        return `${kg.toLocaleString()} kg`;
      });
    }
    if (site.weight_kg == null) return [];
    const n = Number(site.weight_kg) || 0;
    if (n === 0) return ["0 kg"];
    const floorMonth = MAP_VISIT_PERIOD_FLOOR.slice(0, 7);
    const { start, end } = clampWeightMonthPeriodForDisplay(
      mapData?.weight_period_start,
      mapData?.weight_period_end,
      floorMonth
    );
    if (start && end) {
      return [`${n.toLocaleString()} kg（${formatJpDate(start)}〜${formatJpDate(end)}）`];
    }
    return [`${n.toLocaleString()} kg`];
  }

  function formatWeightLine(site) {
    const lines = formatWeightMonthLines(site);
    if (!lines.length) return "配送重量: —";
    return `配送重量: ${lines.join("\n")}`;
  }

  function formatWeightCell(site) {
    const lines = formatWeightMonthLines(site);
    return lines.length ? lines.join("\n") : "—";
  }

  function getSiteCard(siteId) {
    return siteCardsById[siteId] || null;
  }

  function siteHasDetailCard(card) {
    if (!card) return false;
    if (card.card_html) return true;
    if (card.fields?.length) return true;
    if (card.photos?.some((p) => p.src)) return true;
    return false;
  }

  function zoneLabel(site) {
    if (!site?.zone) return "";
    if (site.zone === "chiba_a") return "千葉A";
    if (site.zone === "chiba_b") return "千葉B";
    if (site.zone === "funa") return "房";
    return site.zone;
  }

  function courseSpecNote(course, site) {
    const m = mapData?.course_merges?.[course];
    const n = mapData?.new_courses?.[course];
    if (m?.label && m.label !== course) return m.label;
    if (m?.truck_t === 2) return "2t専用";
    if (m?.truck_t === 4) return "4t専用";
    const shape = m?.marker_shape || n?.marker_shape || site?.marker_shape;
    if (shape === "triangle") return "2t（三角）";
    if (shape === "square") return "4t（四角）";
    return "";
  }

  function formatMapCourseValue(site) {
    const mc = getMapCourse(site);
    const spec = courseSpecNote(mc, site);
    return spec ? `${mc}（${spec}）` : mc;
  }

  function injectDeliveryCodeField(site, fields) {
    const out = (fields || []).map((f) => ({ ...f }));
    const dc = String(site?.delivery_code || "").trim();
    const legacyIdx = out.findIndex((f) => (f.label || "") === "配送先コード");
    const codeIdx = out.findIndex((f) => (f.label || "") === "配送コード");
    if (!dc) {
      if (codeIdx >= 0) out.splice(codeIdx, 1);
      return out;
    }
    const row = { label: "配送コード", value: dc };
    if (codeIdx >= 0) {
      out[codeIdx] = row;
      if (legacyIdx >= 0 && legacyIdx !== codeIdx) out.splice(legacyIdx, 1);
      return out;
    }
    if (legacyIdx >= 0) {
      out[legacyIdx] = row;
      return out;
    }
    const nameIdx = out.findIndex((f) => /配送先名|正式名称/.test(f.label || ""));
    const courseIdx = out.findIndex((f) => /地図コース|コース/.test(f.label || ""));
    const insertAt =
      nameIdx >= 0 ? nameIdx + 1 : courseIdx >= 0 ? courseIdx : out.length;
    out.splice(insertAt, 0, row);
    return out;
  }

  function patchSiteCardFields(site, fields) {
    const mc = getMapCourse(site);
    const master = site.master_course || site.course || "";
    let out = injectDeliveryCodeField(site, fields);
    const mapVal = formatMapCourseValue(site);
    let mapIdx = out.findIndex((f) => /地図コース/.test(f.label || ""));
    if (mapIdx >= 0) {
      out[mapIdx] = { label: "地図コース", value: mapVal };
    } else {
      const nameIdx = out.findIndex((f) => /配送先名|正式名称/.test(f.label || ""));
      out.splice(nameIdx >= 0 ? nameIdx + 1 : 0, 0, { label: "地図コース", value: mapVal });
    }
    const masterIdx = out.findIndex((f) => /マスタコース/.test(f.label || ""));
    if (master && master !== mc) {
      const mv = { label: "マスタコース（配車依頼書）", value: master };
      if (masterIdx >= 0) out[masterIdx] = mv;
      else {
        const idx = out.findIndex((f) => f.label === "地図コース");
        out.splice(idx >= 0 ? idx + 1 : 1, 0, mv);
      }
    } else if (masterIdx >= 0) {
      out.splice(masterIdx, 1);
    }
    const collabExtra = site?.collab_card_fields;
    if (collabExtra && typeof collabExtra === "object") {
      for (const [label, value] of Object.entries(collabExtra)) {
        const v = String(value || "").trim();
        if (!v) continue;
        const idx = out.findIndex((f) => (f.label || "") === label);
        if (idx >= 0) out[idx] = { label, value: v };
        else out.push({ label, value: v });
      }
    }
    return out;
  }

  function buildDefaultSiteFields(site) {
    const mc = getMapCourse(site);
    const fields = [{ label: "配送先名", value: site.name }];
    const dc = String(site?.delivery_code || "").trim();
    if (dc) fields.push({ label: "配送コード", value: dc });
    fields.push({ label: "地図コース", value: formatMapCourseValue(site) });
    if (site.master_course && site.master_course !== mc) {
      fields.push({ label: "マスタコース（配車依頼書）", value: site.master_course });
    }
    const zl = zoneLabel(site);
    if (zl) fields.push({ label: "区域", value: zl });
    fields.push({ label: "住所", value: site.address || "—" });
    fields.push({
      label: "運送",
      value: formatVisitLine(site).replace(/^運送回数:\s*/, ""),
    });
    fields.push({
      label: "重量",
      value: formatWeightCell(site),
    });
    fields.push({
      label: "配送カード",
      value: "順次追加予定（現時点は基本情報のみ）",
    });
    return fields;
  }

  function ensurePhotoViewer() {
    let root = document.getElementById("photoViewer");
    if (root) {
      upgradePhotoViewerDom(root);
      return root;
    }
    root = document.createElement("div");
    root.id = "photoViewer";
    root.className = "photo-viewer";
    root.hidden = true;
    root.innerHTML = `
      <div class="photo-viewer__backdrop" data-close-photo-viewer></div>
      <div class="photo-viewer__panel" role="dialog" aria-modal="true">
        <div class="photo-viewer__toolbar">
          <button type="button" class="photo-viewer__nav" data-photo-prev aria-label="前の写真">◀</button>
          <p id="photoViewerCaption" class="photo-viewer__caption"></p>
          <button type="button" class="photo-viewer__print" data-photo-print>🖨 印刷</button>
          <button type="button" class="photo-viewer__nav" data-photo-next aria-label="次の写真">▶</button>
          <button type="button" class="photo-viewer__close" data-close-photo-viewer aria-label="閉じる">×</button>
        </div>
        <div class="photo-viewer__stage">
          <p class="photo-viewer__print-title"></p>
          <img id="photoViewerImg" alt="">
          <iframe id="photoViewerPdf" class="photo-viewer__pdf" title="PDF" hidden></iframe>
        </div>
        <p id="photoViewerCounter" class="photo-viewer__counter"></p>
      </div>`;
    document.body.appendChild(root);
    upgradePhotoViewerDom(root);
    root.querySelectorAll("[data-close-photo-viewer]").forEach((el) => {
      el.addEventListener("click", closePhotoViewer);
    });
    root.querySelector("[data-photo-prev]").addEventListener("click", () => stepPhotoViewer(-1));
    root.querySelector("[data-photo-next]").addEventListener("click", () => stepPhotoViewer(1));
    root.querySelector("[data-photo-print]").addEventListener("click", printPhotoViewerImage);
    if (!window.__photoViewerKeyBound) {
      window.__photoViewerKeyBound = true;
      document.addEventListener("keydown", (ev) => {
        const viewer = document.getElementById("photoViewer");
        if (!viewer || viewer.hidden) return;
        if (ev.key === "Escape") {
          closePhotoViewer();
        } else if (ev.key === "ArrowLeft") {
          stepPhotoViewer(-1);
        } else if (ev.key === "ArrowRight") {
          stepPhotoViewer(1);
        }
      });
    }
    return root;
  }

  function upgradePhotoViewerDom(root) {
    const stage = root?.querySelector(".photo-viewer__stage");
    if (!stage || stage.querySelector("#photoViewerPdf")) return;
    const iframe = document.createElement("iframe");
    iframe.id = "photoViewerPdf";
    iframe.className = "photo-viewer__pdf";
    iframe.hidden = true;
    iframe.title = "PDF";
    stage.appendChild(iframe);
  }

  /** @type {{type?:string,src:string,label:string,displaySrc?:string,pdfEmbedUrl?:string,userMediaId?:string}[]} */
  let photoViewerItems = [];
  let photoViewerIndex = 0;
  /** @type {Map<string, object>} */
  let photoViewerUserMediaById = new Map();
  /** @type {string[]} */
  let photoViewerPinnedUrls = [];

  function pinPhotoViewerObjectUrl(url) {
    photoViewerPinnedUrls.push(url);
    return url;
  }

  function revokePhotoViewerPinnedUrls() {
    photoViewerPinnedUrls.forEach((u) => {
      try {
        URL.revokeObjectURL(u);
      } catch {
        /* ignore */
      }
    });
    photoViewerPinnedUrls = [];
  }

  async function siteMediaRowToDataUrl(row) {
    if (!row) return "";
    const norm = row.mime === "image/jpeg" ? row : await ensureSiteMediaJpeg({ ...row });
    if (norm?.mime !== "image/jpeg") return "";
    const bin = normalizeIdbBinary(norm);
    let blob = null;
    if (bin instanceof ArrayBuffer) blob = new Blob([bin], { type: "image/jpeg" });
    else if (bin instanceof Blob) {
      blob = bin.type ? bin : new Blob([bin], { type: "image/jpeg" });
    }
    if (!blob) {
      const buf = siteMediaJpegArrayBuffer(norm);
      if (buf) blob = new Blob([buf], { type: "image/jpeg" });
    }
    if (!blob) return "";
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  function siteMediaPdfEmbedUrl(row) {
    const blob = siteMediaRowBlob(row);
    if (!blob) return "";
    return registerSiteCardObjectUrl(URL.createObjectURL(blob));
  }

  async function siteMediaPdfDataUrl(row) {
    if (!row?.id) return "";
    const hit = siteMediaPdfDataUrlCache.get(row.id);
    if (hit) return hit;
    if (row.shared && row.remoteUrl) {
      siteMediaPdfDataUrlCache.set(row.id, row.remoteUrl);
      return row.remoteUrl;
    }
    const blob = siteMediaRowBlob(row);
    if (!blob) return "";
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const url = String(fr.result || "");
        if (url.startsWith("data:application/pdf")) {
          siteMediaPdfDataUrlCache.set(row.id, url);
          resolve(url);
        } else resolve("");
      };
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  function ensurePdfJs() {
    const lib = window["pdfjsLib"];
    if (lib?.getDocument) {
      lib.GlobalWorkerOptions.workerSrc = `vendor/pdf.worker.min.js?v=${PDFJS_ASSET_V}`;
      return Promise.resolve(lib);
    }
    if (!pdfJsLoadPromise) {
      pdfJsLoadPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = `vendor/pdf.min.js?v=${PDFJS_ASSET_V}`;
        s.async = true;
        s.onload = () => {
          const loaded = window["pdfjsLib"];
          if (!loaded?.getDocument) {
            reject(new Error("pdfjs_load_failed"));
            return;
          }
          loaded.GlobalWorkerOptions.workerSrc = `vendor/pdf.worker.min.js?v=${PDFJS_ASSET_V}`;
          resolve(loaded);
        };
        s.onerror = () => reject(new Error("pdfjs_script_failed"));
        document.head.appendChild(s);
      });
    }
    return pdfJsLoadPromise;
  }

  async function renderPdfFirstPageImageDataUrl(pdfDataUrl, maxDim = 720) {
    if (!pdfDataUrl) return "";
    const pdfjs = await ensurePdfJs();
    const task = pdfjs.getDocument({ url: pdfDataUrl, disableFontFace: true });
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const baseVp = page.getViewport({ scale: 1 });
    const scale = Math.min(
      maxDim / Math.max(baseVp.width, 1),
      maxDim / Math.max(baseVp.height, 1),
      2.5
    );
    const viewport = page.getViewport({ scale: Math.max(scale, 0.25) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/jpeg", 0.9);
  }

  async function siteMediaPdfThumbDataUrl(row, maxDim = 220) {
    if (!row?.id) return "";
    const cached = siteMediaPdfThumbCache.get(`${row.id}:${maxDim}`);
    if (cached) return cached;
    try {
      const pdfDataUrl = await siteMediaPdfDataUrl(row);
      if (!pdfDataUrl) return "";
      const imgUrl = await renderPdfFirstPageImageDataUrl(pdfDataUrl, maxDim);
      if (imgUrl) siteMediaPdfThumbCache.set(`${row.id}:${maxDim}`, imgUrl);
      return imgUrl;
    } catch {
      return "";
    }
  }

  async function hydrateSiteCardPdfThumbs(body, userMedia) {
    if (!body) return;
    const byId = new Map((userMedia || []).map((r) => [r.id, r]));
    const hosts = [...body.querySelectorAll("[data-pdf-thumb-host]")];
    await Promise.all(
      hosts.map(async (host) => {
        const fig = host.closest(".site-card-panel__photo");
        const id = fig?.dataset?.userMediaId || "";
        const row = byId.get(id);
        if (!row) {
          host.innerHTML = `<div class="site-card-panel__photo-placeholder">読込失敗</div>`;
          return;
        }
        const thumb = await siteMediaPdfThumbDataUrl(row, 280);
        if (!thumb) {
          host.innerHTML = `<div class="site-card-panel__photo-placeholder">PDFプレビュー不可</div>`;
          return;
        }
        host.innerHTML = `<img src="${thumb}" alt="${escapeHtml(row.label || row.name || "PDF")}" loading="lazy">`;
      })
    );
  }

  async function ensurePhotoViewerItemDisplaySrc(item) {
    if (!item) return "";
    if (item.type === "pdf") {
      if (item.displaySrc?.startsWith("data:image/")) return item.displaySrc;
      const row = photoViewerUserMediaById.get(item.userMediaId || "");
      try {
        const pdfDataUrl = await siteMediaPdfDataUrl(row);
        item.pdfDataUrl = pdfDataUrl || item.pdfDataUrl || "";
        const imgUrl = await renderPdfFirstPageImageDataUrl(pdfDataUrl, 1400);
        item.displaySrc = imgUrl || "";
        item.pdfEmbedUrl = "";
      } catch {
        item.displaySrc = "";
      }
      return item.displaySrc;
    }
    if (item.displaySrc) return item.displaySrc;
    let displaySrc = "";
    if (item.src) {
      try {
        displaySrc = await resolvePhotoPrintSrc(item.src);
      } catch {
        displaySrc = "";
      }
    }
    if ((!displaySrc || String(displaySrc).startsWith("blob:")) && item.userMediaId) {
      const row = photoViewerUserMediaById.get(item.userMediaId);
      if (row) {
        try {
          displaySrc = await siteMediaRowToDataUrl(row);
        } catch {
          displaySrc = "";
        }
      }
    }
    item.displaySrc = displaySrc || item.src || "";
    return item.displaySrc;
  }

  function renderPhotoViewerFrame() {
    const root = document.getElementById("photoViewer");
    if (!root || root.hidden || !photoViewerItems.length) return;
    const item = photoViewerItems[photoViewerIndex];
    const img = root.querySelector("#photoViewerImg");
    const pdfFrame = root.querySelector("#photoViewerPdf");
    const caption = root.querySelector("#photoViewerCaption");
    const counter = root.querySelector("#photoViewerCounter");
    const isPdf = item.type === "pdf";
    const pdfAsImage = isPdf && String(item.displaySrc || "").startsWith("data:image/");
    if (img) {
      img.hidden = isPdf && !pdfAsImage;
      if (!isPdf || pdfAsImage) {
        img.alt = item.label || (isPdf ? "PDF" : "現場写真");
        const nextSrc = item.displaySrc || item.src || "";
        if (img.src !== nextSrc) {
          img.src = nextSrc;
        } else if (nextSrc) {
          img.removeAttribute("src");
          img.src = nextSrc;
        }
      } else {
        img.removeAttribute("src");
      }
    }
    if (pdfFrame) {
      pdfFrame.hidden = true;
      pdfFrame.removeAttribute("src");
    }
    if (caption) caption.textContent = item.label;
    const printTitle = root.querySelector(".photo-viewer__print-title");
    if (printTitle) printTitle.textContent = item.label;
    if (counter) {
      counter.textContent = `${photoViewerIndex + 1} / ${photoViewerItems.length}`;
    }
    const prevBtn = root.querySelector("[data-photo-prev]");
    const nextBtn = root.querySelector("[data-photo-next]");
    if (prevBtn) prevBtn.disabled = photoViewerIndex <= 0;
    if (nextBtn) nextBtn.disabled = photoViewerIndex >= photoViewerItems.length - 1;
  }

  async function openPhotoViewer(items, startIndex = 0, userMediaById = null) {
    if (!items?.length) return;
    photoViewerItems = items.map((it) => ({ ...it, displaySrc: "" }));
    photoViewerUserMediaById = userMediaById || new Map();
    photoViewerIndex = Math.max(0, Math.min(startIndex, items.length - 1));
    const root = ensurePhotoViewer();
    root.hidden = false;
    document.body.classList.add("photo-viewer-open");
    const caption = root.querySelector("#photoViewerCaption");
    if (caption) caption.textContent = "読込中…";
    try {
      await ensurePhotoViewerItemDisplaySrc(photoViewerItems[photoViewerIndex]);
    } catch {
      /* renderPhotoViewerFrame で空表示 */
    }
    renderPhotoViewerFrame();
  }

  function closePhotoViewer() {
    const root = document.getElementById("photoViewer");
    if (!root) return;
    root.hidden = true;
    document.body.classList.remove("photo-viewer-open");
    photoViewerItems = [];
    photoViewerUserMediaById = new Map();
    revokePhotoViewerPinnedUrls();
  }

  async function stepPhotoViewer(delta) {
    if (!photoViewerItems.length) return;
    const next = photoViewerIndex + delta;
    if (next < 0 || next >= photoViewerItems.length) return;
    photoViewerIndex = next;
    const root = document.getElementById("photoViewer");
    const caption = root?.querySelector("#photoViewerCaption");
    if (caption) caption.textContent = "読込中…";
    try {
      await ensurePhotoViewerItemDisplaySrc(photoViewerItems[photoViewerIndex]);
    } catch {
      /* 続行 */
    }
    renderPhotoViewerFrame();
  }

  function revokePhotoViewerPrintObjectUrl() {
    if (!photoViewerPrintObjectUrl) return;
    try {
      URL.revokeObjectURL(photoViewerPrintObjectUrl);
    } catch (_) {
      /* ignore */
    }
    photoViewerPrintObjectUrl = null;
  }

  /** 印刷 iframe 用 … data URL を blob URL に（0px iframe・巨大 src 文字列対策・事例124） */
  async function preparePrintImageBlobUrl(src) {
    if (!src) return "";
    revokePhotoViewerPrintObjectUrl();
    let blob = null;
    const s = String(src);
    if (s.startsWith("data:")) {
      blob = await fetch(s).then((r) => r.blob());
    } else if (s.startsWith("blob:")) {
      try {
        blob = await fetch(s).then((r) => r.blob());
      } catch {
        blob = null;
      }
    } else {
      try {
        const res = await fetch(s);
        blob = await res.blob();
      } catch {
        const fallback = await resolvePhotoPrintSrc(src);
        if (fallback && String(fallback).startsWith("data:")) {
          blob = await fetch(fallback).then((r) => r.blob());
        } else {
          return fallback || "";
        }
      }
    }
    if (!blob) return "";
    photoViewerPrintObjectUrl = URL.createObjectURL(blob);
    return photoViewerPrintObjectUrl;
  }

  async function resolvePhotoPrintSrc(src) {
    if (!src) return src;
    if (String(src).startsWith("data:")) return src;
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || src));
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      });
    } catch {
      try {
        return new URL(src, window.location.href).href;
      } catch {
        return src;
      }
    }
  }

  async function printPhotoViewerImage() {
    const item = photoViewerItems[photoViewerIndex];
    if (!item) return;
    const isPdf = item.type === "pdf";
    if (!isPdf && !item.src && !item.displaySrc) return;

    let printSrc = item.displaySrc || "";
    if (!printSrc || String(printSrc).startsWith("blob:")) {
      printSrc = await ensurePhotoViewerItemDisplaySrc(item);
    }
    if (!isPdf && (!printSrc || String(printSrc).startsWith("blob:"))) {
      printSrc = await resolvePhotoPrintSrc(item.src);
    }
    /* 追加PDF … 印刷は pdf.js JPEG のみ（embed PDF は Safari 空白・事例124） */
    if (isPdf) {
      if (!String(printSrc).startsWith("data:image/")) {
        item.displaySrc = "";
        printSrc = (await ensurePhotoViewerItemDisplaySrc(item)) || "";
      }
      if (!String(printSrc).startsWith("data:image/")) {
        try {
          const row = photoViewerUserMediaById.get(item.userMediaId || "");
          const pdfDataUrl = row ? await siteMediaPdfDataUrl(row) : "";
          if (pdfDataUrl) {
            printSrc = await renderPdfFirstPageImageDataUrl(pdfDataUrl, 1400);
            if (printSrc) item.displaySrc = printSrc;
          }
        } catch {
          printSrc = "";
        }
      }
      if (!String(printSrc).startsWith("data:image/")) {
        alert(
          "PDFを印刷用に変換できませんでした。拡大表示を確認してから、もう一度🖨を押してください。"
        );
        return;
      }
    }
    if (!printSrc) {
      alert("印刷用の画像を読み込めませんでした。");
      return;
    }
    const title = escapeHtml(item.label || (isPdf ? "PDF" : "現場写真"));
    const imgBlobUrl = await preparePrintImageBlobUrl(printSrc);
    if (!imgBlobUrl) {
      alert("印刷用の画像を読み込めませんでした。");
      return;
    }

    let frame = document.getElementById("photoViewerPrintFrame");
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = "photoViewerPrintFrame";
      frame.setAttribute("title", "印刷プレビュー");
      document.body.appendChild(frame);
    }
    frame.style.cssText =
      "position:fixed;left:0;top:0;width:794px;height:1123px;border:0;opacity:0;pointer-events:none;z-index:-1;";

    const win = frame.contentWindow;
    const doc = win.document;
    doc.open();
    doc.write(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
@page { size: A4 portrait; margin: 8mm; }
html, body {
  margin: 0;
  padding: 0;
  background: #fff;
  color: #000;
  font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
}
.print-page {
  width: 100%;
  max-width: 190mm;
  margin: 0 auto;
  page-break-after: avoid;
  page-break-inside: avoid;
}
.print-title {
  margin: 0 0 6mm;
  font-size: 13pt;
  font-weight: 700;
  text-align: center;
  line-height: 1.35;
}
.print-photo {
  display: block;
  width: 100%;
  height: auto;
  max-height: 268mm;
  object-fit: contain;
  page-break-inside: avoid;
}
</style>
</head>
<body>
<div class="print-page">
  <h1 class="print-title">${title}</h1>
  <img class="print-photo" alt="${title}">
</div>
</body>
</html>`);
    doc.close();

    const runPrint = () => {
      try {
        win.focus();
        win.print();
      } catch (_) {
        alert("印刷できませんでした。もう一度お試しください。");
      }
    };

    const img = doc.querySelector(".print-photo");
    if (!img) {
      runPrint();
      return;
    }
    const onPrinted = () => revokePhotoViewerPrintObjectUrl();
    win.addEventListener("afterprint", onPrinted, { once: true });
    const startPrint = () => setTimeout(runPrint, 120);
    img.onload = () => startPrint();
    img.onerror = () => {
      revokePhotoViewerPrintObjectUrl();
      alert("写真を読み込めませんでした。");
    };
    img.src = imgBlobUrl;
    if (img.complete) startPrint();
  }

  function formatPrintDate() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}/${m}/${day}`;
  }

  function buildMapPrintTitle() {
    if (!activeSelections.length) return "伊藤商事 千葉配送地図（全体表示）";
    const labels = activeSelections.map((sel) => sel.label).filter(Boolean);
    if (labels.length === 1) return `伊藤商事 千葉配送地図 — ${labels[0]}`;
    return `伊藤商事 千葉配送地図 — ${labels.join("・")}`;
  }

  function buildMapPrintSubtitle() {
    const visibleCount = shopMarkers.filter(({ marker }) => map && map.hasLayer(marker)).length;
    const parts = [`表示 ${visibleCount} 箇所`, formatPrintDate(), "© OpenStreetMap"];
    const periodEl = $("#visitPeriodText");
    if (periodEl && periodEl.textContent.trim()) {
      parts.unshift(periodEl.textContent.trim());
    }
    return parts.join(" ／ ");
  }

  function buildCoursePrintSubtitle(course) {
    const count = shopMarkers.filter(({ site }) => getMapCourse(site) === course).length;
    const meta = courseSearchMeta(course);
    return `${meta} ／ ${count} 箇所 ／ ${formatPrintDate()} ／ © OpenStreetMap`;
  }

  function setMapPrintBanner(title, subtitle) {
    const banner = $("#mapPrintBanner");
    const titleEl = $("#mapPrintTitle");
    const subEl = $("#mapPrintSubtitle");
    if (!banner || !titleEl || !subEl) return;
    titleEl.textContent = title || "伊藤商事 千葉配送地図";
    subEl.textContent = subtitle || buildMapPrintSubtitle();
    banner.hidden = false;
  }

  function clearMapPrintBanner() {
    const banner = $("#mapPrintBanner");
    if (banner) banner.hidden = true;
  }

  function waitForMapSettled(callback) {
    if (!map) {
      callback();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setTimeout(callback, 280);
    };
    map.once("moveend", finish);
    map.once("zoomend", finish);
    setTimeout(finish, 1200);
  }

  function printFocusBounds() {
    const pts = [];
    activeSelections.forEach((sel) => {
      if (sel.type === "shop") {
        const site = mapData.sites.find((s) => s.id === sel.siteId);
        if (site) pts.push([site.lat, site.lng]);
      } else if (sel.type === "shops") {
        sel.siteIds.forEach((id) => {
          const site = mapData.sites.find((s) => s.id === id);
          if (site) pts.push([site.lat, site.lng]);
        });
      } else if (sel.type === "course") {
        shopMarkers.forEach(({ site }) => {
          if (getMapCourse(site) === sel.course) pts.push([site.lat, site.lng]);
        });
      } else if (sel.type === "zone") {
        shopMarkers.forEach(({ site }) => {
          if (site.zone === sel.zoneKey) pts.push([site.lat, site.lng]);
        });
      }
    });
    if (!pts.length) return null;
    return L.latLngBounds(pts);
  }

  function refitMapForPrint(done) {
    const bounds = printFocusBounds();
    const maxZoom =
      bounds && bounds.isValid() && bounds.getNorth() === bounds.getSouth() ? 14 : 12;
    syncMapAfterLayout(bounds, maxZoom, done);
  }

  function getPrintVisibleBounds() {
    if (!map) return null;
    const size = map.getSize();
    if (!size.x || !size.y) return null;
    const pad = getMapUiPad();
    const x1 = Math.max(0, pad.topLeft[0]);
    const y1 = Math.max(0, pad.topLeft[1]);
    const x2 = Math.min(size.x, size.x - pad.bottomRight[0]);
    const y2 = Math.min(size.y, size.y - pad.bottomRight[1]);
    if (x2 - x1 < 40 || y2 - y1 < 40) return map.getBounds();
    const nw = map.containerPointToLatLng([x1, y1]);
    const se = map.containerPointToLatLng([x2, y2]);
    return L.latLngBounds(nw, se);
  }

  function lockMapPrintView(bounds) {
    if (!map || !bounds || !bounds.isValid()) return;
    const maxZoom = map.getZoom();
    map.invalidateSize({ animate: false });
    map.fitBounds(bounds, { padding: [0, 0], animate: false, maxZoom });
    const nw = bounds.getNorthWest();
    const pt = map.latLngToContainerPoint(nw);
    const dx = Math.round(pt.x);
    const dy = Math.round(pt.y);
    if (dx || dy) map.panBy([dx, dy], { animate: false });
  }

  function runMapPrintDialog(title, subtitle) {
    if (!map) return;
    closePhotoViewer();
    // 工務店単体選択の印刷: コース絞り込みはしない。今の地図に出ている範囲のまま全ピン表示
    if (selectionIsShopOnly()) {
      shopMarkers.forEach(({ marker, site }) => {
        const isSelected = activeSelections.some(
          (s) => s.type === "shop" && s.siteId === site.id
        );
        applyShopMarkerStyle(marker, site, isSelected ? "is-shop-highlight" : "");
        setMarkerVisible(marker, true);
      });
    }
    const printBounds = getPrintVisibleBounds();
    setMapPrintBanner(title, subtitle);

    const cleanup = () => {
      clearMapPrintBanner();
      applyAllSelections();
      map.invalidateSize({ animate: false });
      window.removeEventListener("afterprint", cleanup);
      window.removeEventListener("beforeprint", onBeforePrint);
    };
    const onBeforePrint = () => {
      lockMapPrintView(printBounds);
    };
    window.addEventListener("beforeprint", onBeforePrint);
    window.addEventListener("afterprint", cleanup);

    let printed = false;
    const launchPrint = () => {
      if (printed) return;
      printed = true;
      lockMapPrintView(printBounds);
      setTimeout(() => {
        try {
          window.print();
        } catch (_) {
          cleanup();
          alert("印刷できませんでした。もう一度お試しください。");
        }
      }, 180);
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(launchPrint);
    });
  }

  function printCurrentMapView() {
    runMapPrintDialog(buildMapPrintTitle(), buildMapPrintSubtitle());
  }

  function printCourseMap(course) {
    if (!course || !map) return;
    activeSelections = [];
    renderSearchTags();
    $("#searchInput").value = "";
    hideSuggestions();
    addSelection({ type: "course", course, label: course });
    waitForMapSettled(() => {
      runMapPrintDialog(
        `伊藤商事 千葉配送地図 — ${course}`,
        buildCoursePrintSubtitle(course)
      );
    });
  }

  function collectSiteCardPhotoViewerItems(body) {
    const items = [];
    body.querySelectorAll(".site-card-panel__photo").forEach((fig) => {
      if (fig.dataset.mediaKind === "pdf") {
        if (!fig.dataset.userMediaId) return;
        const pdfImg = fig.querySelector("[data-pdf-thumb-host] img, .site-card-panel__photo-pdf-wrap img");
        const label =
          fig.querySelector("figcaption")?.textContent?.trim() ||
          fig.querySelector(".site-card-panel__photo-memo")?.textContent?.trim() ||
          "PDF";
        items.push({
          type: "pdf",
          src: pdfImg?.currentSrc || pdfImg?.src || "",
          label,
          userMediaId: fig.dataset.userMediaId || "",
        });
        return;
      }
      const img = fig.querySelector("img");
      if (!img) return;
      const label =
        fig.querySelector("figcaption")?.textContent?.trim() || img.alt || "現場写真";
      items.push({
        type: "image",
        src: img.currentSrc || img.src,
        label,
        userMediaId: fig.dataset.userMediaId || "",
      });
    });
    return items;
  }

  function siteCardPhotoViewerFigures(body) {
    return [...body.querySelectorAll(".site-card-panel__photo")].filter((fig) => {
      if (fig.dataset.mediaKind === "pdf") {
        return Boolean(fig.dataset.userMediaId && fig.querySelector("[data-pdf-thumb-host] img, .site-card-panel__photo-pdf-wrap img"));
      }
      return Boolean(fig.querySelector("img"));
    });
  }

  function bindSiteCardPhotoClicks(body, userMedia) {
    const byId = new Map((userMedia || []).map((r) => [r.id, r]));
    body.querySelectorAll(".site-card-panel__photo").forEach((fig) => {
      const isPdf = fig.dataset.mediaKind === "pdf";
      const img = fig.querySelector("img");
      if (!isPdf && !img) return;
      if (isPdf && !byId.get(fig.dataset.userMediaId || "")) return;
      fig.classList.add("is-clickable");
      fig.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-delete-user-media]")) return;
        ev.preventDefault();
        ev.stopPropagation();
        const items = collectSiteCardPhotoViewerItems(body);
        const photoFigs = siteCardPhotoViewerFigures(body);
        let start = photoFigs.indexOf(fig);
        if (start < 0) start = 0;
        void openPhotoViewer(items, start, byId);
      });
    });
  }

  function bindSiteCardMediaDelete(body, siteId) {
    body.querySelectorAll("[data-delete-user-media]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const id = btn.getAttribute("data-delete-user-media");
        if (!id) return;
        const shared = btn.getAttribute("data-delete-shared") === "1";
        const msg = shared
          ? "この追加ファイルを全員から削除しますか？"
          : "この追加ファイルを削除しますか？";
        if (!window.confirm(msg)) return;
        try {
          const result = await deleteSiteMedia(id, siteId);
          await showSiteCardPanel(siteId);
          $("#statusText").textContent = result.sharedRemoved
            ? "追加ファイルを全員から削除しました"
            : "追加ファイルを削除しました";
        } catch {
          $("#statusText").textContent = "削除できませんでした";
        }
      });
    });
  }

  async function readPickedFilesFromInput(input) {
    for (const delayMs of [0, 50, 200]) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const files = Array.from(input.files || []);
      if (files.length) return files;
    }
    return [];
  }

  async function onSiteMediaFilesPicked(input, siteId) {
    if (input.__siteMediaPickBusy) return;
    const sid = String(siteId || "");
    if (!sid) {
      $("#statusText").textContent = "配送カードを開き直してから＋を押してください";
      return;
    }
    input.__siteMediaPickBusy = true;
    $("#statusText").textContent = "ファイルを読込中…";
    try {
      const fileArr = await readPickedFilesFromInput(input);
      if (!fileArr.length) {
        $("#statusText").textContent =
          "ファイルを取得できませんでした。もう一度＋から選んでください";
        return;
      }
      const added = await addSiteMediaFiles(sid, fileArr);
      let sharedOk = 0;
      for (const row of added) {
        const up = await uploadSharedSiteMedia(row);
        if (up.ok) sharedOk += 1;
      }
      await showSiteCardPanel(sid, { justAdded: added });
      if (sharedOk === added.length) {
        $("#statusText").textContent = "現場写真を追加しました（全員に共有）";
      } else if (sharedOk > 0) {
        $("#statusText").textContent = `現場写真を追加（共有 ${sharedOk}/${added.length} 件）`;
      } else {
        $("#statusText").textContent =
          "現場写真を追加（この端末のみ）。合言葉で地図を開き直してから＋を押すと共有されます";
      }
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.startsWith("file_too_large:")) {
        $("#statusText").textContent = "20MB以下のファイルを選んでください";
      } else if (
        msg.startsWith("heic_convert_failed:") ||
        msg.includes("convert_failed") ||
        msg.includes("decode_failed") ||
        msg.includes("jpeg_blob_failed")
      ) {
        $("#statusText").textContent =
          "この写真形式は変換できませんでした。JPEG/PNGで保存し直して追加してください";
      } else if (msg.includes("indexedDB_unavailable") || msg.includes("idb_")) {
        $("#statusText").textContent =
          "このブラウザでは端末保存が使えません。別ブラウザで開いてください";
      } else if (msg.includes("QuotaExceeded") || msg.includes("quota")) {
        $("#statusText").textContent =
          "端末の保存容量が足りません。古い追加写真を × で削除してから再度お試しください";
      } else if (msg.includes("no_supported_files")) {
        $("#statusText").textContent = "画像またはPDFを選んでください";
      } else if (msg.includes("idb_verify_failed")) {
        $("#statusText").textContent =
          "端末への保存に失敗しました。プライベート閲覧をオフにして再試行してください";
      } else {
        $("#statusText").textContent = "ファイルを追加できませんでした";
      }
    } finally {
      try {
        input.value = "";
      } catch {
        /* ignore */
      }
      input.__siteMediaPickBusy = false;
    }
  }

  function ensureSiteCardMediaFileInput(root) {
    let input = document.getElementById("siteCardMediaFileInput");
    if (!input) {
      input = document.createElement("input");
      input.type = "file";
      input.id = "siteCardMediaFileInput";
      input.multiple = true;
      input.accept =
        "image/jpeg,image/png,image/heic,image/heif,image/webp,image/*,application/pdf,.pdf";
      input.className = "site-card-panel__photo-file-input";
      root.appendChild(input);
    }
    return input;
  }

  function bindSiteCardMediaPick(root, siteId) {
    const input = ensureSiteCardMediaFileInput(root);
    const sid = String(siteId || "");
    input.onchange = () => {
      void onSiteMediaFilesPicked(input, sid);
    };
  }

  function ensureSiteCardPanel() {
    let root = document.getElementById("siteCardPanel");
    if (!root) {
      root = document.createElement("aside");
      root.id = "siteCardPanel";
      root.className = "site-card-panel";
      root.hidden = true;
      root.innerHTML = `
      <div class="site-card-panel__head">
        <h2 id="siteCardPanelTitle" class="site-card-panel__title"></h2>
        <button type="button" class="site-card-panel__close" data-close-site-card aria-label="閉じる">×</button>
      </div>
      <div id="siteCardPanelBody" class="site-card-panel__body"></div>`;
      document.body.appendChild(root);
      root.querySelector("[data-close-site-card]").addEventListener("click", closeSiteCardPanelAndResetShopTap);
      if (!window.__siteCardPanelKeyBound) {
        window.__siteCardPanelKeyBound = true;
        document.addEventListener("keydown", (ev) => {
          if (ev.key !== "Escape") return;
          const viewer = document.getElementById("photoViewer");
          if (viewer && !viewer.hidden) return;
          const panel = document.getElementById("siteCardPanel");
          if (panel && !panel.hidden) closeSiteCardPanelAndResetShopTap();
        });
      }
    }
    ensureSiteCardMediaFileInput(root);
    return root;
  }

  function revokeSiteCardPanelObjectUrls() {
    if (document.body.classList.contains("photo-viewer-open")) return;
    siteCardPanelObjectUrls.forEach((u) => {
      try {
        URL.revokeObjectURL(u);
      } catch (_) {
        /* ignore */
      }
    });
    siteCardPanelObjectUrls = [];
  }

  function closeSiteCardPanel() {
    const root = document.getElementById("siteCardPanel");
    if (!root) return;
    const viewer = document.getElementById("photoViewer");
    if (!viewer || viewer.hidden) {
      revokeSiteCardPanelObjectUrls();
    }
    root.hidden = true;
    document.body.classList.remove("site-card-panel-open");
  }

  function openSiteMediaDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("indexedDB_unavailable"));
        return;
      }
      const req = indexedDB.open(SITE_MEDIA_DB_NAME, SITE_MEDIA_DB_VER);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains("media")) {
          const store = db.createObjectStore("media", { keyPath: "id" });
          store.createIndex("siteId", "siteId", { unique: false });
        }
      };
    });
  }

  function isHeicLike(file) {
    const n = (file?.name || "").toLowerCase();
    const t = (file?.type || "").toLowerCase();
    return /\.(heic|heif)$/i.test(n) || t.includes("heic") || t.includes("heif");
  }

  function canvasToJpegBlob(canvas, quality = 0.88) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob && blob.size > 0) resolve(blob);
          else reject(new Error("jpeg_blob_failed"));
        },
        "image/jpeg",
        quality
      );
    });
  }

  function jpegDataUrlToArrayBuffer(dataUrl) {
    const m = /^data:image\/jpeg;base64,(.+)$/i.exec(String(dataUrl || ""));
    if (!m) throw new Error("bad_jpeg_data_url");
    const bin = atob(m[1]);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }

  /** IndexedDB 復元値（ArrayBuffer / TypedArray / 旧 Blob）を ArrayBuffer に統一 */
  function normalizeIdbBinary(row) {
    if (!row) return null;
    const d = row.data;
    if (d instanceof ArrayBuffer && d.byteLength > 0) return d;
    if (ArrayBuffer.isView(d) && d.byteLength > 0) {
      return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
    }
    const b = row.blob;
    if (b instanceof Blob && b.size > 0) return b;
    return null;
  }

  async function asyncNormalizeIdbBinary(row) {
    const n = normalizeIdbBinary(row);
    if (n instanceof ArrayBuffer) return n;
    if (n instanceof Blob) return n.arrayBuffer();
    return null;
  }

  function drawToJpegDataUrl(source, sw, sh, fileName) {
    const maxDim = 2048;
    let w = sw;
    let h = sh;
    if (!w || !h) throw new Error("no_dimensions");
    if (w > maxDim || h > maxDim) {
      const scale = maxDim / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no_canvas");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    const base = (fileName || "photo").replace(/\.[^.]+$/i, "");
    return { canvas, name: `${base}.jpg` };
  }

  /** iPhone HEIC 等 → JPEG バイト（IndexedDB は ArrayBuffer。表示は data URL / blob URL） */
  async function canvasToJpegArrayBuffer(canvas) {
    try {
      const blob = await canvasToJpegBlob(canvas);
      return await blob.arrayBuffer();
    } catch {
      const url = canvas.toDataURL("image/jpeg", 0.88);
      return jpegDataUrlToArrayBuffer(url);
    }
  }

  async function prepareImageFileForStorage(file) {
    const mime = file.type || "application/octet-stream";
    const name = file.name || "photo.jpg";
    if (/^image\/jpe?g$/i.test(mime) || /\.jpe?g$/i.test(name)) {
      return {
        data: await file.arrayBuffer(),
        name: name.replace(/\.[^.]+$/i, "") + ".jpg",
      };
    }
    if (/^image\/png$/i.test(mime) || /\.png$/i.test(name)) {
      const { data, name: outName } = await rasterizeImageFileToJpegBytes(file);
      return { data, name: outName };
    }
    return rasterizeImageFileToJpegBytes(file);
  }

  async function rasterizeImageFileToJpegBytes(file) {
    let lastErr = null;
    if (typeof createImageBitmap === "function") {
      try {
        const bmp = await createImageBitmap(file);
        try {
          const drawn = drawToJpegDataUrl(bmp, bmp.width, bmp.height, file.name);
          return { data: await canvasToJpegArrayBuffer(drawn.canvas), name: drawn.name };
        } finally {
          if (typeof bmp.close === "function") bmp.close();
        }
      } catch (err) {
        lastErr = err;
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("decode_failed"));
        el.src = url;
      });
      const drawn = drawToJpegDataUrl(
        img,
        img.naturalWidth || img.width,
        img.naturalHeight || img.height,
        file.name
      );
      return { data: await canvasToJpegArrayBuffer(drawn.canvas), name: drawn.name };
    } catch (err) {
      lastErr = err;
      throw lastErr || new Error("convert_failed");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function siteMediaJpegArrayBuffer(row) {
    if (!row || row.mime !== "image/jpeg") return null;
    const bin = normalizeIdbBinary(row);
    if (bin instanceof ArrayBuffer) return bin;
    const url = row?.jpegDataUrl;
    if (typeof url === "string" && url.startsWith("data:image/jpeg")) {
      try {
        return jpegDataUrlToArrayBuffer(url);
      } catch {
        return null;
      }
    }
    return null;
  }

  function siteMediaImageSrc(row) {
    if (!row || row.mime !== "image/jpeg") return "";
    if (row.shared && row.remoteUrl) return row.remoteUrl;
    let blob = null;
    const bin = normalizeIdbBinary(row);
    if (bin instanceof ArrayBuffer) blob = new Blob([bin], { type: "image/jpeg" });
    else if (bin instanceof Blob) {
      blob = bin.type ? bin : new Blob([bin], { type: "image/jpeg" });
    } else if (row.blob instanceof Blob && row.blob.size > 0) {
      blob = row.blob.type ? row.blob : new Blob([row.blob], { type: "image/jpeg" });
    }
    if (!blob) {
      const buf = siteMediaJpegArrayBuffer(row);
      if (buf) blob = new Blob([buf], { type: "image/jpeg" });
    }
    if (!blob) return "";
    return registerSiteCardObjectUrl(URL.createObjectURL(blob));
  }

  function siteMediaRowBlob(row) {
    if (!row || row.mime === "image/jpeg") return null;
    const bin = normalizeIdbBinary(row);
    if (bin instanceof ArrayBuffer) {
      return new Blob([bin], { type: row.mime || "application/pdf" });
    }
    if (bin instanceof Blob) return bin;
    const b = row.blob;
    if (b instanceof Blob && b.size > 0) {
      return b.type ? b : new Blob([b], { type: row.mime || "application/octet-stream" });
    }
    return null;
  }

  async function putSiteMediaRow(row) {
    const db = await openSiteMediaDb();
    const stored = { ...row };
    delete stored.jpegDataUrl;
    if (stored.mime === "image/jpeg") {
      const buf = await asyncNormalizeIdbBinary(stored);
      if (!buf || !buf.byteLength) throw new Error("idb_no_image_data");
      stored.data = buf.slice(0);
      delete stored.blob;
    } else if (stored.mime === "application/pdf") {
      const buf = await asyncNormalizeIdbBinary(stored);
      if (buf && buf.byteLength) stored.data = buf.slice(0);
      delete stored.blob;
    } else if (stored.data instanceof ArrayBuffer) {
      stored.data = stored.data.slice(0);
      delete stored.blob;
    } else {
      delete stored.blob;
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction("media", "readwrite");
      const req = tx.objectStore("media").put(stored);
      req.onerror = () => reject(req.error || new Error("idb_put_failed"));
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error || new Error("idb_tx_failed"));
    });
  }

  async function ensureSiteMediaJpeg(row) {
    if (!row || row.mime === "application/pdf") return row;
    if (row.mime !== "image/jpeg") {
      /* 一覧表示では重い再変換しない（×で削除して取り直し） */
      return row;
    }
    let bytes = null;
    const bin = normalizeIdbBinary(row);
    if (bin instanceof ArrayBuffer) bytes = bin;
    else if (bin instanceof Blob) {
      try {
        bytes = await bin.arrayBuffer();
      } catch {
        bytes = null;
      }
    }
    if (!bytes && typeof row.jpegDataUrl === "string" && row.jpegDataUrl.startsWith("data:image/jpeg")) {
      try {
        bytes = jpegDataUrlToArrayBuffer(row.jpegDataUrl);
      } catch {
        bytes = null;
      }
    }
    if (bytes?.byteLength) {
      row.data = bytes;
      delete row.jpegDataUrl;
      delete row.blob;
    }
    return row;
  }

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function collabApiBaseQuick() {
    const meta = document.querySelector('meta[name="chiba-map-collab-api"]');
    return meta?.content?.trim().replace(/\/$/, "") || "";
  }

  function mapEditKeyForUpload() {
    const fromInput = normalizeAccessKey(sessionStorage.getItem("chiba-map-edit-key") || "");
    if (fromInput) return fromInput;
    const sk = accessStorageKey();
    if (sk && sessionStorage.getItem(sk) === "1") {
      const aliases = accessKeyAliases();
      if (aliases.length) return aliases[0];
    }
    return "";
  }

  /** @type {{ items: object[], at: number } | null} */
  let siteMediaManifestCache = null;

  async function fetchSiteMediaManifestItems(forceRefresh = false) {
    if (
      !forceRefresh &&
      siteMediaManifestCache &&
      Date.now() - siteMediaManifestCache.at < 45000
    ) {
      return siteMediaManifestCache.items;
    }
    try {
      const r = await fetch(`${SITE_MEDIA_RAW_BASE}data/site_media/manifest.json?v=${Date.now()}`, {
        cache: "no-store",
      });
      if (r.ok) {
        const manifest = await r.json();
        const items = manifest.items || [];
        siteMediaManifestCache = { items, at: Date.now() };
        return items;
      }
    } catch {
      /* fall through */
    }
    try {
      const base = collabApiBaseQuick();
      if (base) {
        const r = await fetch(`${base}/api/site-media/manifest?v=${Date.now()}`, {
          cache: "no-store",
        });
        if (r.ok) {
          const data = await r.json();
          const items = data.items || [];
          siteMediaManifestCache = { items, at: Date.now() };
          return items;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const r = await fetch(`${SITE_MEDIA_MANIFEST_URL}?v=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return siteMediaManifestCache?.items || [];
      const manifest = await r.json();
      const items = manifest.items || [];
      siteMediaManifestCache = { items, at: Date.now() };
      return items;
    } catch {
      return siteMediaManifestCache?.items || [];
    }
  }

  async function markSiteMediaSharedUploaded(id) {
    if (!id) return;
    try {
      const row = await getSiteMediaRowById(id);
      if (!row) return;
      row.sharedUploaded = true;
      await putSiteMediaRow(row);
    } catch {
      /* ignore */
    }
  }

  async function listLocalSiteMediaForSite(siteId) {
    const sid = String(siteId || "");
    if (!sid) return [];
    const db = await openSiteMediaDb();
    const allRows = await new Promise((resolve, reject) => {
      const tx = db.transaction("media", "readonly");
      const req = tx.objectStore("media").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    let rows = allRows.filter((r) => String(r?.siteId ?? "") === sid);
    if (!rows.length) {
      rows = await new Promise((resolve, reject) => {
        const tx = db.transaction("media", "readonly");
        const req = tx.objectStore("media").index("siteId").getAll(sid);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      rows = (rows || []).filter((r) => String(r?.siteId ?? "") === sid);
    }
    rows.sort((a, b) => String(a.addedAt || "").localeCompare(String(b.addedAt || "")));
    const out = [];
    for (const row of rows) {
      out.push(await ensureSiteMediaJpeg(row));
    }
    return out;
  }

  async function listAllLocalSiteMediaRows() {
    try {
      const db = await openSiteMediaDb();
      const allRows = await new Promise((resolve, reject) => {
        const tx = db.transaction("media", "readonly");
        const req = tx.objectStore("media").getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      const out = [];
      for (const row of allRows || []) {
        out.push(await ensureSiteMediaJpeg(row));
      }
      return out;
    } catch {
      return [];
    }
  }

  /** 端末ローカルで未共有の＋写真を Worker へ（siteId 空＝全現場） */
  async function syncLocalSiteMediaToShared(siteId = "") {
    if (!mapEditKeyForUpload()) return 0;
    const manifestItems = await fetchSiteMediaManifestItems();
    const sharedIds = new Set(manifestItems.map((i) => i.id));
    const sid = String(siteId || "");
    const manifestIdsForSite = new Set(
      manifestItems.filter((i) => String(i.siteId) === sid).map((i) => i.id)
    );
    const locals = sid ? await listLocalSiteMediaForSite(sid) : await listAllLocalSiteMediaRows();
    let uploaded = 0;
    let lastFail = "";
    for (const row of locals) {
      if (sid && siteMediaLocalRowIsOrphan(row, manifestIdsForSite)) {
        await deleteSiteMediaLocalOnly(row.id);
        continue;
      }
      if (row.sharedUploaded || sharedIds.has(row.id)) {
        if (sharedIds.has(row.id) && !row.sharedUploaded) {
          await markSiteMediaSharedUploaded(row.id);
        }
        continue;
      }
      const up = await uploadSharedSiteMedia(row);
      if (up.ok) {
        uploaded += 1;
        sharedIds.add(row.id);
        await markSiteMediaSharedUploaded(row.id);
        ensureSiteMediaPendingIds().delete(row.id);
        siteMediaManifestCache = null;
      } else {
        lastFail = up.reason || "upload_failed";
      }
    }
    if (!uploaded && locals.length && lastFail) {
      window.__siteMediaSyncLastError = lastFail;
    }
    return uploaded;
  }

  function sharedSiteMediaPublicUrl(item) {
    const rel = String(item?.path || "").replace(/^\//, "");
    if (!rel) return "";
    const v = encodeURIComponent(item.addedAt || item.id || "");
    const base = collabApiBaseQuick();
    if (base) {
      return `${base}/api/site-media/file?path=${encodeURIComponent(rel)}&v=${v}`;
    }
    return `${SITE_MEDIA_RAW_BASE}${rel}?v=${v}`;
  }

  function sharedSiteMediaItemToRow(item) {
    return {
      id: item.id,
      siteId: item.siteId,
      mime: item.mime,
      label: item.label,
      name: item.name,
      addedAt: item.addedAt,
      shared: true,
      remoteUrl: sharedSiteMediaPublicUrl(item),
    };
  }

  async function fetchSharedSiteMediaForSite(siteId) {
    const sid = String(siteId || "");
    if (!sid) return [];
    const base = collabApiBaseQuick();
    try {
      if (base) {
        const r = await fetch(
          `${base}/api/site-media/list?site_id=${encodeURIComponent(sid)}`,
          { cache: "no-store" }
        );
        if (r.ok) {
          const data = await r.json();
          return (data.items || []).map(sharedSiteMediaItemToRow);
        }
      }
      const items = await fetchSiteMediaManifestItems(true);
      return items.filter((x) => String(x.siteId) === sid).map(sharedSiteMediaItemToRow);
    } catch {
      return [];
    }
  }

  async function uploadSharedSiteMedia(row) {
    const base = collabApiBaseQuick();
    const key = mapEditKeyForUpload();
    if (!base || !key) return { ok: false, reason: "no_key" };
    let dataB64 = "";
    if (row.mime === "image/jpeg") {
      const buf = siteMediaJpegArrayBuffer(row);
      if (!buf?.byteLength) return { ok: false, reason: "no_data" };
      dataB64 = arrayBufferToBase64(buf);
    } else if (row.mime === "application/pdf") {
      const bin = normalizeIdbBinary(row);
      if (!(bin instanceof ArrayBuffer) || !bin.byteLength) return { ok: false, reason: "no_data" };
      dataB64 = arrayBufferToBase64(bin);
    } else {
      return { ok: false, reason: "unsupported" };
    }
    try {
      const r = await fetch(`${base}/api/site-media`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Map-Edit-Key": key },
        body: JSON.stringify({
          site_id: row.siteId,
          media_id: row.id,
          mime: row.mime,
          label: row.label,
          name: row.name,
          data_b64: dataB64,
          added_at: row.addedAt,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) siteMediaManifestCache = null;
      return { ok: r.ok, data, reason: data.error };
    } catch {
      return { ok: false, reason: "network" };
    }
  }

  async function deleteSiteMediaLocalOnly(id) {
    const mid = String(id || "");
    if (!mid) return;
    const db = await openSiteMediaDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("media", "readwrite");
      tx.objectStore("media").delete(mid);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  }

  function ensureSiteMediaPendingIds() {
    if (!window.__siteMediaPendingIds) window.__siteMediaPendingIds = new Set();
    return window.__siteMediaPendingIds;
  }

  /** サーバ manifest に無い古いローカル行（sharedUploaded 無しも含む・池部 Windows 等） */
  function isPendingLocalSiteMediaRow(row, manifestIdsForSite) {
    if (!row?.id) return false;
    if (!manifestIdsForSite?.size) return true;
    if (manifestIdsForSite.has(row.id)) return false;
    if (ensureSiteMediaPendingIds().has(row.id)) return true;
    const t = Date.parse(String(row.addedAt || ""));
    if (!Number.isFinite(t)) return false;
    return Date.now() - t < 20 * 60 * 1000;
  }

  function siteMediaLocalRowIsOrphan(row, manifestIdsForSite) {
    if (!manifestIdsForSite?.size) return false;
    if (manifestIdsForSite.has(row.id)) return false;
    return !isPendingLocalSiteMediaRow(row, manifestIdsForSite);
  }

  async function purgeOrphanLocalSiteMedia(siteId, manifestIdsForSite) {
    const sid = String(siteId || "");
    if (!sid || !manifestIdsForSite?.size) return;
    try {
      const locals = await listLocalSiteMediaForSite(sid);
      for (const row of locals) {
        if (siteMediaLocalRowIsOrphan(row, manifestIdsForSite)) {
          await deleteSiteMediaLocalOnly(row.id);
          ensureSiteMediaPendingIds().delete(row.id);
        }
      }
    } catch {
      /* ignore */
    }
  }

  async function listSiteMediaForSite(siteId) {
    const sid = String(siteId || "");
    if (!sid) return [];
    try {
      const manifestItems = await fetchSiteMediaManifestItems();
      const manifestIdsForSite = new Set(
        manifestItems.filter((i) => String(i.siteId) === sid).map((i) => i.id)
      );
      await purgeOrphanLocalSiteMedia(sid, manifestIdsForSite);
      await syncLocalSiteMediaToShared(sid);
      await purgeOrphanLocalSiteMedia(sid, manifestIdsForSite);
      const shared = await fetchSharedSiteMediaForSite(sid);
      const locals = await listLocalSiteMediaForSite(sid);
      const localsById = new Map(locals.map((r) => [r.id, r]));
      let out = [];
      if (manifestIdsForSite.size > 0) {
        for (const row of shared) {
          const local = localsById.get(row.id);
          out.push(local ? { ...local, shared: true, remoteUrl: row.remoteUrl } : row);
        }
        for (const row of locals) {
          if (manifestIdsForSite.has(row.id)) continue;
          if (isPendingLocalSiteMediaRow(row, manifestIdsForSite)) out.push(row);
        }
      } else {
        out = [...locals];
        const seen = new Set(out.map((r) => r.id));
        for (const row of shared) {
          if (!seen.has(row.id)) out.push(row);
        }
      }
      out.sort((a, b) => String(a.addedAt || "").localeCompare(String(b.addedAt || "")));
      return out;
    } catch {
      window.__siteMediaListFailed = true;
      return [];
    }
  }

  async function deleteSharedSiteMediaFromServer(siteId, mediaId) {
    const base = collabApiBaseQuick();
    const key = mapEditKeyForUpload();
    if (!base || !key) throw new Error("no_key");
    const r = await fetch(
      `${base}/api/site-media?site_id=${encodeURIComponent(siteId)}&media_id=${encodeURIComponent(mediaId)}`,
      { method: "DELETE", headers: { "X-Map-Edit-Key": key } }
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "delete_failed");
    siteMediaManifestCache = null;
    siteMediaPdfDataUrlCache.delete(mediaId);
    siteMediaPdfThumbCache.forEach((_v, k) => {
      if (String(k).startsWith(`${mediaId}:`)) siteMediaPdfThumbCache.delete(k);
    });
    return true;
  }

  async function deleteSiteMedia(id, siteIdHint = "") {
    const mid = String(id || "");
    if (!mid) throw new Error("no_id");
    let sharedRemoved = false;
    const manifestItems = await fetchSiteMediaManifestItems(true);
    const manifestHit = manifestItems.find((x) => x.id === mid);
    if (manifestHit) {
      await deleteSharedSiteMediaFromServer(
        String(manifestHit.siteId || siteIdHint || ""),
        mid
      );
      sharedRemoved = true;
    }
    try {
      await deleteSiteMediaLocalOnly(mid);
    } catch {
      if (!sharedRemoved) throw new Error("local_delete_failed");
    }
    return { sharedRemoved };
  }

  async function addSiteMediaFiles(siteId, fileList) {
    const sid = String(siteId || "");
    if (!sid) throw new Error("idb_no_site");
    const added = [];
    for (const file of fileList) {
      if (!file || !file.size) continue;
      if (file.size > SITE_MEDIA_MAX_BYTES) {
        throw new Error(`file_too_large:${file.name}`);
      }
      const mime = file.type || "application/octet-stream";
      const isPdf = mime === "application/pdf" || /\.pdf$/i.test(file.name || "");
      const isImage =
        !isPdf &&
        (/^image\//i.test(mime) ||
          /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(file.name || "") ||
          isHeicLike(file) ||
          (!mime && file.size > 0));
      if (!isImage && !isPdf) continue;
      const id = `${sid}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      let row;
      if (isPdf) {
        row = {
          id,
          siteId: sid,
          name: file.name || "file.pdf",
          mime: "application/pdf",
          data: await file.arrayBuffer(),
          addedAt: new Date().toISOString(),
          label: (file.name || "ファイル").replace(/\.[^.]+$/, ""),
        };
      } else {
        const { data, name } = await prepareImageFileForStorage(file);
        row = {
          id,
          siteId: sid,
          name,
          mime: "image/jpeg",
          data,
          addedAt: new Date().toISOString(),
          label: (file.name || "ファイル").replace(/\.[^.]+$/, ""),
        };
      }
      await putSiteMediaRow(row);
      ensureSiteMediaPendingIds().add(row.id);
      const verified = await getSiteMediaRowById(row.id);
      added.push(await ensureSiteMediaJpeg(verified ? { ...row, ...verified } : { ...row }));
    }
    if (!added.length) {
      throw new Error("no_supported_files");
    }
    return added;
  }

  async function getSiteMediaRowById(id) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt) await new Promise((r) => setTimeout(r, 50));
      const db = await openSiteMediaDb();
      const row = await new Promise((resolve, reject) => {
        const tx = db.transaction("media", "readonly");
        const req = tx.objectStore("media").get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      if (row) return row;
    }
    return null;
  }

  function registerSiteCardObjectUrl(url) {
    siteCardPanelObjectUrls.push(url);
    return url;
  }

  function closeSiteCardPanelAndResetShopTap() {
    closeSiteCardPanel();
    if (
      activeSelections.length &&
      activeSelections.every((s) => s.type === "shop")
    ) {
      activeSelections = [];
      clearRoutes();
      hideHint();
      renderSearchTags();
      showAllShopMarkers();
      $("#statusText").textContent = defaultStatusText();
    }
  }

  function renderSiteCardFields(fields) {
    if (!fields?.length) return "";
    const rows = fields
      .map((f) => {
        const tdClass = f.label === "重量" ? ' class="site-card-panel__weight-cell"' : "";
        return `<tr><th>${escapeHtml(f.label)}</th><td${tdClass}>${escapeHtml(f.value || "—")}</td></tr>`;
      })
      .join("");
    return `<table class="site-card-panel__table"><tbody>${rows}</tbody></table>`;
  }

  function renderBuiltinSiteCardPhoto(p) {
    const hasSrc = Boolean(p.src);
    const img = hasSrc
      ? `<img src="${escapeHtml(p.src)}" alt="${escapeHtml(p.label || "")}" loading="lazy">`
      : `<div class="site-card-panel__photo-placeholder">写真準備中</div>`;
    const memo = p.memo ? `<p class="site-card-panel__photo-memo">${escapeHtml(p.memo)}</p>` : "";
    return `<figure class="site-card-panel__photo">${img}<figcaption>${escapeHtml(p.label || "")}</figcaption>${memo}</figure>`;
  }

  function renderUserSiteCardPhoto(row) {
    const label = row.label || row.name || "追加ファイル";
    const isPdf =
      row.mime === "application/pdf" || /\.pdf$/i.test(row.name || "");
    const sharedAttr = row.shared ? ' data-delete-shared="1"' : "";
    const delBtn = `<button type="button" class="site-card-panel__photo-delete" data-delete-user-media="${escapeHtml(row.id)}"${sharedAttr} aria-label="削除">×</button>`;
    if (isPdf) {
      if (!row.shared && !siteMediaRowBlob(row)) {
        return `<figure class="site-card-panel__photo site-card-panel__photo--user"><div class="site-card-panel__photo-placeholder">読込失敗</div></figure>`;
      }
      return `<figure class="site-card-panel__photo site-card-panel__photo--user site-card-panel__photo--pdf" data-media-kind="pdf" data-user-media-id="${escapeHtml(row.id)}">
        ${delBtn}
        <div class="site-card-panel__photo-pdf-wrap" data-pdf-thumb-host>
          <div class="site-card-panel__photo-placeholder">PDF読込中…</div>
        </div>
        <figcaption>${escapeHtml(label)}</figcaption>
      </figure>`;
    }
    const imgSrc = siteMediaImageSrc(row);
    if (!imgSrc) {
      return `<figure class="site-card-panel__photo site-card-panel__photo--user" data-media-kind="image" data-user-media-id="${escapeHtml(row.id)}">
        ${delBtn}
        <div class="site-card-panel__photo-placeholder">読込失敗（×で削除して取り直し）</div>
        <figcaption>${escapeHtml(label)}</figcaption>
      </figure>`;
    }
    return `<figure class="site-card-panel__photo site-card-panel__photo--user" data-media-kind="image" data-user-media-id="${escapeHtml(row.id)}">
      ${delBtn}
      <img src="${imgSrc}" alt="${escapeHtml(label)}" loading="lazy">
      <figcaption>${escapeHtml(label)}</figcaption>
    </figure>`;
  }

  function renderSiteCardPhotos(photos, userMedia) {
    const builtin = (photos || []).map(renderBuiltinSiteCardPhoto).join("");
    const extra = (userMedia || []).map(renderUserSiteCardPhoto).join("");
    const addBtn = `<label class="site-card-panel__photo-add" for="siteCardMediaFileInput" data-site-media-add aria-label="ファイルを追加">
      <span class="site-card-panel__photo-add-mark" aria-hidden="true">＋</span>
    </label>`;
    const hasAny = Boolean((photos || []).length || (userMedia || []).length);
    const emptyHint = hasAny
      ? ""
      : `<p class="site-card-panel__empty">登録済み写真はありません。＋から画像・PDFを追加できます。</p>`;
    return `${emptyHint}<div class="site-card-panel__photos">${builtin}${extra}${addBtn}</div>`;
  }

  async function showSiteCardPanel(siteId, opts = {}) {
    const sid = String(siteId || "");
    const site = (mapData.sites || []).find((s) => String(s.id) === sid);
    if (!site) return;

    const card = getSiteCard(sid);
    const hasDetail = siteHasDetailCard(card);
    const root = ensureSiteCardPanel();
    root.dataset.activeSiteId = sid;
    bindSiteCardMediaPick(root, sid);
    const titleEl = root.querySelector("#siteCardPanelTitle");
    const body = root.querySelector("#siteCardPanelBody");
    const title = card?.title || site.name || "配送先";
    const subtitle = card?.subtitle || "";
    const course = formatMapCourseValue(site);
    const address = card?.address || site.address || "";
    const visitLine = formatVisitLine(site);
    const weightLine = formatWeightLine(site);
    const baseFields =
      hasDetail && card?.fields?.length ? card.fields : buildDefaultSiteFields(site);
    const fields = patchSiteCardFields(site, baseFields);
    revokeSiteCardPanelObjectUrls();
    window.__siteMediaListFailed = false;
    let userMedia = await listSiteMediaForSite(sid);
    const justAdded = Array.isArray(opts.justAdded) ? opts.justAdded : [];
    for (const row of justAdded) {
      const norm = await ensureSiteMediaJpeg({ ...row });
      if (norm?.id && !userMedia.some((r) => r.id === norm.id)) userMedia.push(norm);
    }
    userMedia.sort((a, b) => String(a.addedAt || "").localeCompare(String(b.addedAt || "")));
    if (window.__siteMediaListFailed) {
      $("#statusText").textContent =
        "端末保存の読込に失敗しました。プライベート閲覧をオフにして再試行してください";
      window.__siteMediaListFailed = false;
    }
    const cardLink = card?.card_html
      ? `<p class="site-card-panel__links"><a href="${escapeHtml(card.card_html)}" target="_blank" rel="noopener">印刷用カードを別タブで開く</a></p>`
      : "";
    const statusBadge = hasDetail
      ? `<span class="site-card-panel__badge site-card-panel__badge--ready">詳細カードあり</span>`
      : `<span class="site-card-panel__badge">基本情報（カード追加予定）</span>`;

    titleEl.textContent = title;
    body.innerHTML = `
      ${statusBadge}
      ${subtitle ? `<p class="site-card-panel__subtitle">${escapeHtml(subtitle)}</p>` : ""}
      <p class="site-card-panel__meta">${escapeHtml(course)}　${escapeHtml(address)}</p>
      <p class="site-card-panel__meta">${escapeHtml(visitLine)}</p>
      <p class="site-card-panel__meta site-card-panel__meta--pre">${escapeHtml(weightLine)}</p>
      ${renderSiteCardFields(fields)}
      ${card?.aliases_note ? `<p class="site-card-panel__aliases"><span>PDF別名:</span> ${escapeHtml(card.aliases_note)}</p>` : ""}
      <h3 class="site-card-panel__sec">現場写真</h3>
      ${renderSiteCardPhotos(hasDetail ? card?.photos : [], userMedia)}
      ${cardLink}`;

    bindSiteCardMediaDelete(body, sid);
    await hydrateSiteCardPdfThumbs(body, userMedia);
    bindSiteCardPhotoClicks(body, userMedia);

    root.hidden = false;
    document.body.classList.add("site-card-panel-open");
  }

  function maybeShowSiteCardForSelections() {
    const shopSels = activeSelections.filter((s) => s.type === "shop");
    if (shopSels.length === 1) {
      showSiteCardPanel(shopSels[0].siteId);
      return;
    }
    if (shopSels.length !== 1) closeSiteCardPanel();
  }

  async function loadSiteCards() {
    siteCardsById = { ...(mapData?.site_cards || {}) };
    try {
      const r = await fetch(`${SITE_CARDS_URL}?v=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return;
      const data = await r.json();
      siteCardsById = { ...siteCardsById, ...(data.sites || {}) };
    } catch {
      /* map_data.site_cards が正本フォールバック */
    }
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

  function selectionFiltersShopMarkers() {
    return activeSelections.some(
      (sel) =>
        sel.type === "course" ||
        sel.type === "zone" ||
        sel.type === "shops" ||
        sel.type === "yokomochi" ||
        sel.type === "warehouse"
    );
  }

  function selectionIsShopOnly() {
    return (
      activeSelections.length > 0 &&
      activeSelections.every((sel) => sel.type === "shop")
    );
  }

  function applyAllSelections() {
    clearRoutes();
    renderSearchTags();

    if (!activeSelections.length) {
      showAllShopMarkers();
      hideHint();
      closeSiteCardPanel();
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

    const filterMarkers = selectionFiltersShopMarkers();

    shopMarkers.forEach(({ marker, site }) => {
      if (filterMarkers) {
        if (visibleIds.has(site.id)) {
          const mode = highlightMode.get(site.id);
          const extra =
            mode === "course" ? "is-course-highlight" : "is-zone-highlight";
          applyShopMarkerStyle(marker, site, extra);
          setMarkerVisible(marker, true);
        } else {
          setMarkerVisible(marker, false);
        }
        return;
      }

      const isSelected = visibleIds.has(site.id);
      applyShopMarkerStyle(marker, site, isSelected ? "is-shop-highlight" : "");
      setMarkerVisible(marker, true);
    });

    activeSelections.forEach((sel) => {
      if (sel.type === "course") {
        const matched = shopMarkers
          .map(({ site }) => site)
          .filter((s) => getMapCourse(s) === sel.course && visibleIds.has(s.id));
        const color = getCourseHighlightColor(sel.course);
        const hubId =
          mapData.course_merges?.[sel.course]?.hub ||
          mapData.collab_custom_courses?.[sel.course]?.hub ||
          mapData.new_courses?.[sel.course]?.hub ||
          matched[0]?.hub ||
          (sel.course.startsWith("柏") || sel.course.includes("千葉A")
            ? "yachiyo_dp"
            : "esr_kazo");
        drawHubToSites(hubId, matched, color);
      } else if (sel.type === "shop") {
        const site = mapData.sites.find((s) => s.id === sel.siteId);
        if (site) {
          const hubId = resolveSiteHubId(site);
          const color = getCourseHighlightColor(getMapCourse(site));
          drawHubToSites(hubId, [site], color);
        }
      } else if (sel.type === "shops") {
        const sites = sel.siteIds
          .map((id) => mapData.sites.find((s) => s.id === id))
          .filter(Boolean);
        sites.forEach((site) => {
          const hubId = resolveSiteHubId(site);
          const color = getCourseHighlightColor(getMapCourse(site));
          drawHubToSites(hubId, [site], color);
        });
      } else if (sel.type === "yokomochi") {
        const y = (mapData.yokomochi || []).find((x) => x.id === sel.yokomochiId);
        if (y) {
          const from = warehouseMarkers[y.from] || getWarehouse(y.from);
          const to = warehouseMarkers[y.to] || getWarehouse(y.to);
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

    if (!visibleSites.length) {
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
    const totalShops = shopMarkers.length;
    /* チップ（searchTags）と同内容のヒントバーは出さない（二重表示防止） */
    hideHint();
    if (!filterMarkers && visibleSites.length) {
      $("#statusText").textContent = `${totalShops}件表示中（${visibleSites.length}件選択）… ${labels}`;
    } else {
      $("#statusText").textContent = labels
        ? `${visibleSites.length}件表示中 … ${labels}`
        : `表示 ${visibleSites.length}件 / 検索 ${activeSelections.length}件`;
    }
    maybeShowSiteCardForSelections();
    raiseWarehouseMarkers();
    // 工務店単体選択時は地図の表示範囲を変えない（周辺の別コース工務店もそのまま）
    if (visibleSites.length && !selectionIsShopOnly()) {
      fitMapToSites(visibleSites);
    }
  }

  function findShops(query) {
    const q = norm(query);
    const qCorp = stripCorp(query);
    if (!q) return [];
    if (q === "NBS" || q === "ESR加須" || q === "加須" || q === "八千代DP") {
      return [];
    }
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

  function resolveWarehouseSearch(q) {
    if (q === "NBS") {
      return { type: "warehouse", warehouseId: "nbs", label: "NBS" };
    }
    if (q.includes("ESR") || q === "加須") {
      return { type: "warehouse", warehouseId: "esr_kazo", label: "ESR加須" };
    }
    if (q === "八千代DP" || (q.includes("八千代") && q.includes("DP"))) {
      return { type: "warehouse", warehouseId: "yachiyo_dp", label: "八千代DP" };
    }
    return null;
  }

  function resolveSearchToSelection(raw) {
    const q = norm(raw);
    if (!q) return null;

    const whSel = resolveWarehouseSearch(q);
    if (whSel) return whSel;

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
    if (q.includes("木更津DP") && q !== "NBS") {
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
    const key = selectionKey({ type: "shop", siteId: site.id });
    if (!activeSelections.some((s) => s.key === key)) {
      addSelection({ type: "shop", siteId: site.id, label: site.name });
    }
    if (map) map.closePopup();
    showSiteCardPanel(site.id);
  }

  function showYokomochi(type) {
    const y = (mapData.yokomochi || []).find((x) => x.id === type);
    if (!y) return;
    addSelection({ type: "yokomochi", yokomochiId: type, label: y.name });
  }

  function showWarehouse(wid) {
    const wh = getWarehouse(wid);
    if (!wh) return;
    addSelection({ type: "warehouse", warehouseId: wid, label: wh.name });
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

  function getShopMarker(siteId) {
    return shopMarkers.find(({ site }) => site.id === siteId)?.marker || null;
  }

  function resolveRouteLatLng(ref) {
    if (!ref) return null;
    if (ref.lat != null && ref.lng != null && typeof ref.getLatLng !== "function") {
      return L.latLng(ref.lat, ref.lng);
    }
    if (ref.getLatLng) return ref.getLatLng();
    if (ref.lat != null && ref.lng != null) return L.latLng(ref.lat, ref.lng);
    return null;
  }

  function drawRoute(from, to, color, opts = {}) {
    const fromLl = resolveRouteLatLng(from);
    const toLl = resolveRouteLatLng(to);
    if (!fromLl || !toLl) return;
    const line = L.polyline([fromLl, toLl], {
      color,
      weight: opts.weight || 4,
      opacity: 0.85,
      className: "chiba-route-line",
    }).addTo(map);

    routeLayers.push(line);
  }

  function resolveSiteHubId(site) {
    if (!site) return null;
    if (site.hub) return site.hub;
    const zoneHub = mapData.zones?.[site.zone]?.hub;
    if (zoneHub) return zoneHub;
    const course = getMapCourse(site);
    return (
      mapData.course_merges?.[course]?.hub ||
      mapData.new_courses?.[course]?.hub ||
      (course && (course.startsWith("柏") || course.includes("千葉A"))
        ? "yachiyo_dp"
        : "esr_kazo")
    );
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
          course: c,
        });
      }
    }

    for (const [c, cfg] of Object.entries(mapData.new_courses || {})) {
      if (!isActiveCollabCustomCourse(c)) continue;
      const key = norm(c);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        value: c,
        label: cfg?.label || c,
        meta: courseSearchMeta(c),
        category: "コース",
        priority: 2,
        group: "協調作成",
        course: c,
      });
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
      .sort((a, b) => {
        const aExact = norm(a.value) === q || norm(a.label) === q ? 0 : 1;
        const bExact = norm(b.value) === q || norm(b.label) === q ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        const aPre = norm(a.value).startsWith(q) ? 0 : 1;
        const bPre = norm(b.value).startsWith(q) ? 0 : 1;
        if (aPre !== bPre) return aPre - bPre;
        return a.priority - b.priority;
      })
      .slice(0, 24);
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
    if (item?.course) {
      addSelection({ type: "course", course: item.course, label: item.label });
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
    if (ml.square) {
      html += `<div class="legend-row"><span class="legend-swatch legend-swatch--square"></span>${ml.square}</div>`;
    }
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

    map.createPane(WAREHOUSE_PANE);
    const whPane = map.getPane(WAREHOUSE_PANE);
    whPane.style.zIndex = "620";
    whPane.style.pointerEvents = "auto";

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

    // 工務店（常時表示・青。調べる／クリックでハイライト色）
    (mapData.sites || []).forEach((site) => {
      const marker = L.circleMarker([site.lat, site.lng], getShopDotStyle(site)).addTo(map);
      wireShopMarker(marker, site);
      shopMarkers.push({ marker, site });
    });

    // 倉庫（常時表示・赤。専用 pane で工務店より前面・加須と同色濃度）
    (mapData.warehouses || []).forEach((wh) => {
      const marker = L.circleMarker([wh.lat, wh.lng], getWarehouseDotStyle())
        .bindPopup(`<b>${escapeHtml(wh.name)}</b><br>${escapeHtml(wh.address)}`)
        .addTo(map);
      marker.on("add", () => reinforceWarehouseMarker(marker));
      bindWarehouseLabel(marker, wh.name);
      warehouseMarkers[wh.id] = marker;
      reinforceWarehouseMarker(marker);
    });
    raiseWarehouseMarkers();

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
    const printBtn = $("#printBtn");
    if (printBtn) {
      printBtn.addEventListener("click", () => printCurrentMapView());
    }
    bindSearchSuggestions();
  }

  function setStatus(text) {
    const el = $("#statusText");
    if (el) el.textContent = text;
  }

  function safeSessionGet(key) {
    try {
      return sessionStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function safeSessionSet(key, value) {
    try {
      sessionStorage.setItem(key, value);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** GitHub Pages は .version.json を 404 にするため version.json を正とする */
  function liveVersionCandidates() {
    const candidates = [];
    if (IS_WEB_HOST) {
      const here = new URL("./", window.location.href).toString().replace(/\/?$/, "/");
      candidates.push(`${here}version.json`, `${here}.version.json`);
    }
    const meta = document.querySelector('meta[name="chiba-map-live-base"]');
    if (meta?.content?.trim()) {
      const base = meta.content.trim().replace(/\/?$/, "/");
      candidates.push(`${base}version.json`, `${base}.version.json`);
    }
    if (!IS_WEB_HOST) {
      candidates.push("./version.json", "./.version.json");
    }
    return [...new Set(candidates)];
  }

  function reloadOnce(reloadKey, marker) {
    if (safeSessionGet(reloadKey) === marker) return false;
    const url = new URL(window.location.href);
    if (url.searchParams.get(reloadKey) === marker) return false;
    if (!safeSessionSet(reloadKey, marker)) {
      url.searchParams.set(reloadKey, marker);
    } else {
      url.searchParams.set("_", String(Date.now()));
    }
    window.location.replace(url.toString());
    return true;
  }

  function pageBuildStamp() {
    return document.querySelector('meta[name="chiba-map-build"]')?.content?.trim() || "";
  }

  async function fetchLiveVersionMeta() {
    for (const url of liveVersionCandidates()) {
      try {
        const r = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
        if (!r.ok) continue;
        return await r.json();
      } catch (_) {
        /* try next candidate */
      }
    }
    return null;
  }

  async function maybeReloadForLatestBuild() {
    if (!IS_WEB_HOST && !document.querySelector('meta[name="chiba-map-live-base"]')) {
      return;
    }
    const ver = await fetchLiveVersionMeta();
    if (!ver?.built) return;

    const pageBuild = pageBuildStamp();
    const staleHtml = !pageBuild || ver.built > pageBuild;
    if (staleHtml && reloadOnce("chiba-map-reloaded-for", ver.built)) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  function liveMapDataCandidates() {
    const meta = document.querySelector('meta[name="chiba-map-live-base"]');
    if (!meta?.content?.trim()) return [];
    const base = meta.content.trim().replace(/\/?$/, "/");
    return [`${base}data/map_data.json`];
  }

  function mapDataGenerated(data) {
    return (data?.generated || "").trim();
  }

  function mapCollabStamp(data) {
    return (data?.map_collaborative || "").trim();
  }

  function countCollabCardFieldSites(data) {
    return (data?.sites || []).filter(
      (s) => s?.collab_card_fields && Object.keys(s.collab_card_fields).length > 0
    ).length;
  }

  /** 時間指定等: 選んだ map_data に他方の collab_card_fields を足す（更新で消えない・事例114） */
  function mergeCollabCardFieldsInto(target, source) {
    if (!target?.sites?.length || !source?.sites?.length) return target;
    const byId = new Map(source.sites.map((s) => [s.id, s]));
    for (const s of target.sites) {
      const src = byId.get(s.id);
      const extra = src?.collab_card_fields;
      if (!extra || typeof extra !== "object") continue;
      const cur = s.collab_card_fields || {};
      const merged = { ...cur };
      let changed = false;
      for (const [label, value] of Object.entries(extra)) {
        const v = String(value || "").trim();
        if (!v) continue;
        if (merged[label] !== v) {
          merged[label] = v;
          changed = true;
        }
      }
      if (changed || (!Object.keys(cur).length && Object.keys(merged).length)) {
        s.collab_card_fields = merged;
      }
    }
    return target;
  }

  /** 8765: 協調編集は live 正本。generated / map_collaborative で選ぶ（事例59/61） */
  function pickMapData(localData, liveData, { forceLive = false } = {}) {
    if (!liveData?.sites?.length) return localData;
    if (!localData?.sites?.length) return liveData;
    if (forceLive) return liveData;

    const liveCards = countCollabCardFieldSites(liveData);
    const localCards = countCollabCardFieldSites(localData);
    if (liveCards > localCards) return liveData;
    if (localCards > liveCards) return localData;

    const liveCollab = mapCollabStamp(liveData);
    const localCollab = mapCollabStamp(localData);
    if (liveCollab && localCollab && liveCollab > localCollab) return liveData;
    if (liveCollab && !localCollab) return liveData;

    const liveEnd = (liveData.visit_period_end || "").trim();
    const localEnd = (localData.visit_period_end || "").trim();
    if (localEnd && liveEnd) {
      if (liveEnd > localEnd) return liveData;
      if (localEnd > liveEnd) return localData;
    }

    const liveGen = mapDataGenerated(liveData);
    const localGen = mapDataGenerated(localData);
    if (liveGen && localGen) {
      if (liveGen > localGen) return liveData;
      if (localGen > liveGen) return localData;
    }

    if (!IS_WEB_HOST && document.querySelector('meta[name="chiba-map-live-base"]')) {
      return liveData;
    }
    return localData;
  }

  async function fetchMapDataJson(url, signal) {
    const r = await fetch(`${url}?v=${Date.now()}`, { signal, cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function mapDataLoadError() {
    return IS_WEB_HOST
      ? "map_data.json を読めません。ページを再読込（Ctrl+F5）するか、しばらく待ってから再度開いてください。"
      : "map_data.json を読めません。ターミナルで cd AI化/千葉配送地図 && python3 -m http.server 8765 を実行してください。";
  }

  async function loadMapDataOnce() {
    if (typeof L === "undefined") {
      throw new Error("地図ライブラリ（Leaflet）が読み込めません。ネット接続を確認して再読込してください。");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const forceLive = safeSessionGet("chiba-map-force-live") === "1";
    if (forceLive) {
      try {
        sessionStorage.removeItem("chiba-map-force-live");
      } catch (_) {
        /* ignore */
      }
    }

    try {
      let localData = null;
      let liveData = null;
      const liveUrls = liveMapDataCandidates();

      if (!forceLive) {
        try {
          localData = await fetchMapDataJson(DATA_URL, controller.signal);
        } catch (_) {
          /* local optional when live-base configured */
        }
      }

      for (const url of liveUrls) {
        try {
          liveData = await fetchMapDataJson(url, controller.signal);
          if (liveData?.sites?.length) break;
          liveData = null;
        } catch (_) {
          /* try next */
        }
      }

      clearTimeout(timer);

      let data = null;
      if (liveUrls.length && liveData) {
        data = pickMapData(localData, liveData, { forceLive });
      } else if (localData) {
        data = localData;
      }

      if (!data?.sites?.length) {
        throw new Error(mapDataLoadError());
      }

      if (liveData) mergeCollabCardFieldsInto(data, liveData);
      if (localData && localData !== liveData) mergeCollabCardFieldsInto(data, localData);
      applyMapPeriodFloor(data);

      const ver = await fetchLiveVersionMeta();
      const pageBuild = pageBuildStamp();
      if (ver?.built && (!pageBuild || ver.built > pageBuild)) {
        if (reloadOnce("chiba-map-reloaded-for", ver.built)) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
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
    if (!window.crypto?.subtle) {
      throw new Error(
        "合言葉の確認に HTTPS が必要です。URL が https:// で始まっているか確認してください。"
      );
    }
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function isLiveAccessRequired() {
    return (
      document.querySelector('meta[name="chiba-map-access-required"]')?.content === "1"
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
    if (isLiveAccessRequired()) {
      return "chiba-map-ok-live-gate-v2";
    }
    return null;
  }

  async function verifyAccessKey(key) {
    const trimmed = normalizeAccessKey(key || "");
    if (!trimmed) return false;
    const aliases = accessKeyAliases();
    if (aliases.length && aliases.includes(trimmed)) return true;
    const hashMeta = document.querySelector('meta[name="chiba-map-access-hash"]');
    if (hashMeta?.content?.trim()) {
      try {
        return (await sha256Hex(trimmed)) === hashMeta.content.trim();
      } catch (_) {
        return false;
      }
    }
    const keyMeta = document.querySelector('meta[name="chiba-map-access-key"]');
    if (keyMeta?.content?.trim()) {
      return trimmed === normalizeAccessKey(keyMeta.content.trim());
    }
    return !isLiveAccessRequired();
  }

  function stripAccessKeyFromUrl() {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("k")) return;
      url.searchParams.delete("k");
      window.history.replaceState({}, "", url.toString());
    } catch (_) {
      /* ignore */
    }
  }

  function normalizeAccessKey(key) {
    let k = (key || "").trim();
    // よくある typo: l（エル）↔ I（アイ）
    k = k.replace(/PK9aQfl/i, "PK9aQfI");
    return k;
  }

  function accessKeyAliases() {
    const raw = document.querySelector('meta[name="chiba-map-access-keys"]')?.content || "";
    return raw
      .split(/[,;\s]+/)
      .map((k) => normalizeAccessKey(k))
      .filter(Boolean);
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
      setStatus("合言葉を入力してください");

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
        sessionStorage.setItem(
          "chiba-map-edit-key",
          normalizeAccessKey(input.value)
        );
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
    stripAccessKeyFromUrl();
    const sk = accessStorageKey();
    const accessOk = sk && sessionStorage.getItem(sk) === "1";
    if (accessOk && mapEditKeyForUpload()) return;
    if (accessOk && !mapEditKeyForUpload()) {
      await showAccessGate();
      return;
    }
    if (accessOk) return;

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
      if (!current || v.built > current) {
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
    window.__chibaMapBooted = true;
    try {
      setStatus("合言葉を確認中…");
      await ensureLiveAccess();
      setStatus("最新版を確認中…");
      await maybeReloadForLatestBuild();
      setStatus("地図データを読込中…");
      const data = await loadMapDataWithRetry();
      mapData = data;
      await loadSiteCards();
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
      window.__chibaMapApi = {
        getMapData: () => mapData,
        getMap: () => map,
        getShopMarkers: () => shopMarkers,
        allCourseGroups,
        getMapCourse,
        setStatus,
        showHint,
        highlightSiteById(siteId, color) {
          const hit = shopMarkers.find((m) => m.site?.id === siteId);
          if (hit?.marker) applyShopMarkerStyle(hit.marker, hit.site, color || "#ffd54a");
        },
        resetMarkerStyles() {
          showAllShopMarkers();
        },
        flyToSite(siteId) {
          const hit = shopMarkers.find((m) => m.site?.id === siteId);
          if (hit?.marker && map) map.flyTo(hit.marker.getLatLng(), 14, { duration: 0.6 });
        },
        getWarehouseMarkers() {
          return Object.entries(warehouseMarkers).map(([id, marker]) => ({
            id,
            marker,
            warehouse: getWarehouse(id),
          }));
        },
        flyToWarehouse(warehouseId) {
          const wh = getWarehouse(warehouseId);
          if (wh && map) map.flyTo([wh.lat, wh.lng], 12, { duration: 0.6 });
        },
      };
      if (window.__chibaMapCollabInit) window.__chibaMapCollabInit(window.__chibaMapApi);
      const ver = await fetchLiveVersionMeta();
      startLiveVersionWatch(ver?.built || data.generated);
      setTimeout(() => {
        void syncLocalSiteMediaToShared("").then((n) => {
          if (n > 0) {
            setStatus(`この端末の現場写真 ${n} 件を全員共有しました（1〜2分で他端末にも表示）`);
            return;
          }
          const err = window.__siteMediaSyncLastError;
          if (err && err !== "no_key") {
            setStatus(`現場写真の共有に失敗しました（${err}）。＋から再追加するかページを再読込してください`);
          }
        });
      }, 1500);
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
