/**
 * 伊藤商事 千葉配送地図
 * 現場マスタ + 倉庫 + コースルート検索
 */
(function () {
  "use strict";

  const DATA_URL = "data/map_data.json";
  const SITE_CARDS_URL = "data/site_cards.json";
  const GEOJSON_URL = "data/chiba_cities.geojson";
  const IS_WEB_HOST = /github\.io$/i.test(window.location.hostname);

  let map;
  let mapData;
  /** @type {Record<string, object>} */
  let siteCardsById = {};
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
      applyShopMarkerStyle(marker, site, "");
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
    if (extraClass.includes("is-shop-highlight")) return "#ffd54a";
    if (extraClass.includes("is-zone-highlight")) return "#ffd54a";
    if (extraClass.includes("is-course-highlight")) {
      return getCourseHighlightColor(getMapCourse(site));
    }
    return null;
  }

  const SHOP_DOT_RADIUS = { circle: 7, square: 6.5, triangle: 7 };
  const WH_DOT_RADIUS = 8;

  function getShopDotStyle(site, extraClass) {
    const color = getHighlightColor(site, extraClass) || DEFAULT_SHOP_COLOR;
    const shape = site.marker_shape || "circle";
    const radius = SHOP_DOT_RADIUS[shape] || SHOP_DOT_RADIUS.circle;
    const cls = ["chiba-shop-dot", `shape-${shape}`, extraClass].filter(Boolean).join(" ");
    return {
      radius,
      fillColor: color,
      fillOpacity: 0.95,
      color,
      weight: shape === "circle" ? 2 : 2.5,
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
      fillColor: "#ff4757",
      fillOpacity: 1,
      color: "#ff4757",
      weight: 2.5,
      opacity: 1,
      className: "chiba-wh-dot",
    };
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

  function buildDefaultSiteFields(site) {
    const mc = getMapCourse(site);
    const fields = [
      { label: "配送先名", value: site.name },
      { label: "地図コース", value: mc },
    ];
    if (site.master_course && site.master_course !== mc) {
      fields.push({ label: "マスタコース", value: site.master_course });
    }
    const zl = zoneLabel(site);
    if (zl) fields.push({ label: "区域", value: zl });
    fields.push({ label: "住所", value: site.address || "—" });
    fields.push({
      label: "運送",
      value: formatVisitLine(site).replace(/^運送回数:\s*/, ""),
    });
    fields.push({
      label: "配送カード",
      value: "順次追加予定（現時点は基本情報のみ）",
    });
    return fields;
  }

  function ensurePhotoViewer() {
    let root = document.getElementById("photoViewer");
    if (root) return root;
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
        </div>
        <p id="photoViewerCounter" class="photo-viewer__counter"></p>
      </div>`;
    document.body.appendChild(root);
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

  /** @type {{src:string,label:string}[]} */
  let photoViewerItems = [];
  let photoViewerIndex = 0;

  function renderPhotoViewerFrame() {
    const root = document.getElementById("photoViewer");
    if (!root || root.hidden || !photoViewerItems.length) return;
    const item = photoViewerItems[photoViewerIndex];
    const img = root.querySelector("#photoViewerImg");
    const caption = root.querySelector("#photoViewerCaption");
    const counter = root.querySelector("#photoViewerCounter");
    if (img) {
      img.src = item.src;
      img.alt = item.label;
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

  function openPhotoViewer(items, startIndex = 0) {
    if (!items?.length) return;
    photoViewerItems = items;
    photoViewerIndex = Math.max(0, Math.min(startIndex, items.length - 1));
    const root = ensurePhotoViewer();
    renderPhotoViewerFrame();
    root.hidden = false;
    document.body.classList.add("photo-viewer-open");
  }

  function closePhotoViewer() {
    const root = document.getElementById("photoViewer");
    if (!root) return;
    root.hidden = true;
    document.body.classList.remove("photo-viewer-open");
  }

  function stepPhotoViewer(delta) {
    if (!photoViewerItems.length) return;
    const next = photoViewerIndex + delta;
    if (next < 0 || next >= photoViewerItems.length) return;
    photoViewerIndex = next;
    renderPhotoViewerFrame();
  }

  function printPhotoViewerImage() {
    const item = photoViewerItems[photoViewerIndex];
    if (!item) return;

    const absSrc = new URL(item.src, window.location.href).href;
    const title = escapeHtml(item.label || "現場写真");

    let frame = document.getElementById("photoViewerPrintFrame");
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = "photoViewerPrintFrame";
      frame.setAttribute("title", "印刷プレビュー");
      frame.style.cssText =
        "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none";
      document.body.appendChild(frame);
    }

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
  <img class="print-photo" src="${absSrc.replace(/"/g, "&quot;")}" alt="${title}">
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
    if (img.complete) {
      setTimeout(runPrint, 80);
    } else {
      img.onload = () => setTimeout(runPrint, 80);
      img.onerror = () => alert("写真を読み込めませんでした。");
    }
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

  function bindSiteCardPhotoClicks(body) {
    const items = [];
    body.querySelectorAll(".site-card-panel__photo img").forEach((img) => {
      const fig = img.closest(".site-card-panel__photo");
      const label = fig?.querySelector("figcaption")?.textContent?.trim() || img.alt || "現場写真";
      items.push({ src: img.src, label });
    });
    body.querySelectorAll(".site-card-panel__photo").forEach((fig, i) => {
      const img = fig.querySelector("img");
      if (!img) return;
      fig.classList.add("is-clickable");
      fig.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openPhotoViewer(items, i);
      });
    });
  }

  function ensureSiteCardPanel() {
    let root = document.getElementById("siteCardPanel");
    if (root) return root;
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
    return root;
  }

  function closeSiteCardPanel() {
    const root = document.getElementById("siteCardPanel");
    if (!root) return;
    root.hidden = true;
    document.body.classList.remove("site-card-panel-open");
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
      .map(
        (f) =>
          `<tr><th>${escapeHtml(f.label)}</th><td>${escapeHtml(f.value || "—")}</td></tr>`
      )
      .join("");
    return `<table class="site-card-panel__table"><tbody>${rows}</tbody></table>`;
  }

  function renderSiteCardPhotos(photos) {
    if (!photos?.length) {
      return `<p class="site-card-panel__empty">現場写真は準備中です。</p>`;
    }
    const cards = photos
      .map((p) => {
        const hasSrc = Boolean(p.src);
        const img = hasSrc
          ? `<img src="${escapeHtml(p.src)}" alt="${escapeHtml(p.label || "")}" loading="lazy">`
          : `<div class="site-card-panel__photo-placeholder">写真準備中</div>`;
        const memo = p.memo
          ? `<p class="site-card-panel__photo-memo">${escapeHtml(p.memo)}</p>`
          : "";
        return `<figure class="site-card-panel__photo">${img}<figcaption>${escapeHtml(p.label || "")}</figcaption>${memo}</figure>`;
      })
      .join("");
    return `<div class="site-card-panel__photos">${cards}</div>`;
  }

  function showSiteCardPanel(siteId) {
    const site = (mapData.sites || []).find((s) => s.id === siteId);
    if (!site) return;

    const card = getSiteCard(siteId);
    const hasDetail = siteHasDetailCard(card);
    const root = ensureSiteCardPanel();
    const titleEl = root.querySelector("#siteCardPanelTitle");
    const body = root.querySelector("#siteCardPanelBody");
    const title = card?.title || site.name || "配送先";
    const subtitle = card?.subtitle || "";
    const course = card?.course || getMapCourse(site);
    const address = card?.address || site.address || "";
    const visitLine = formatVisitLine(site);
    const fields = hasDetail && card?.fields?.length ? card.fields : buildDefaultSiteFields(site);
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
      ${renderSiteCardFields(fields)}
      ${card?.aliases_note ? `<p class="site-card-panel__aliases"><span>PDF別名:</span> ${escapeHtml(card.aliases_note)}</p>` : ""}
      <h3 class="site-card-panel__sec">現場写真</h3>
      ${renderSiteCardPhotos(hasDetail ? card?.photos : [])}
      ${cardLink}`;

    bindSiteCardPhotoClicks(body);

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
          mapData.new_courses?.[sel.course]?.hub ||
          matched[0]?.hub ||
          (sel.course.startsWith("柏") || sel.course.includes("千葉A")
            ? "yachiyo_dp"
            : "esr_kazo");
        drawHubToSites(hubId, matched, color);
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
    if (!filterMarkers && visibleSites.length) {
      showHint(`${totalShops}件表示中（${visibleSites.length}件選択） … ${labels}`);
      $("#statusText").textContent = `表示 ${totalShops}件（選択 ${visibleSites.length}件）`;
    } else {
      showHint(`${visibleSites.length}件表示中 … ${labels}`);
      $("#statusText").textContent = `表示 ${visibleSites.length}件 / 検索 ${activeSelections.length}件`;
    }
    maybeShowSiteCardForSelections();
    if (visibleSites.length) fitMapToSites(visibleSites);
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
      const marker = L.circleMarker([wh.lat, wh.lng], getWarehouseDotStyle())
        .bindPopup(`<b>${escapeHtml(wh.name)}</b><br>${escapeHtml(wh.address)}`)
        .addTo(map);
      bindWarehouseLabel(marker, wh.name);
      warehouseMarkers[wh.id] = marker;
    });

    // 工務店（常時表示・青。調べる／クリックでハイライト色）
    (mapData.sites || []).forEach((site) => {
      const marker = L.circleMarker([site.lat, site.lng], getShopDotStyle(site)).addTo(map);
      wireShopMarker(marker, site);
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
    const staleHtml = pageBuild && ver.built > pageBuild;
    if (staleHtml && reloadOnce("chiba-map-reloaded-for", ver.built)) {
      window.location.reload();
      await new Promise((resolve) => setTimeout(resolve, 3000));
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
      if (IS_WEB_HOST) {
        return data;
      }
      const ver = await fetchLiveVersionMeta();
      if (ver?.map_generated && data.generated && ver.map_generated > data.generated) {
        if (reloadOnce("chiba-map-data-reloaded-for", ver.map_generated)) {
          window.location.reload();
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
      return "chiba-map-ok-live-gate";
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
    return true;
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
    if (urlKey && (await verifyAccessKey(urlKey))) {
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
