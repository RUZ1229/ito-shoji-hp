/**
 * 手渡し冊子ビューア共通（枚数可変）
 * .sheet を DOM 順に並べ、表1・中見開き・裏1 を自動生成。
 * data-booklet-label … 目次用。data-booklet … 紙の役割（spread-left 等・CSS用）
 */
(function (root, factory) {
  root.BrochureBooklet = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  function pageMeta(el, index) {
    return {
      index: index,
      role: el.getAttribute("data-booklet") || "",
      label:
        el.getAttribute("data-booklet-label") ||
        el.getAttribute("aria-label") ||
        "P" + (index + 1),
    };
  }

  /**
   * 表1 → 中見開きペア… → （概要など単独）→ 最終が back-outside なら裏表紙1枚
   */
  /** LOYAL系 … 1ページずつ縦めくり（1/10 表示） */
  function buildSinglePageViews(pages) {
    return pages.map(function (el, index) {
      const m = pageMeta(el, index);
      return { mode: "single", page: index, toc: m.label, pageNum: index + 1 };
    });
  }

  function buildViews(pages) {
    const meta = pages.map(pageMeta);
    const n = pages.length;
    if (n === 0) return [];
    if (n === 1) return [{ mode: "single", page: 0, toc: meta[0].label }];

    const views = [{ mode: "single", page: 0, toc: meta[0].label }];
    const last = n - 1;
    const lastIsBack = meta[last].role === "back-outside";
    const middleEnd = lastIsBack ? last - 1 : last;

    let i = 1;
    while (i < middleEnd) {
      if (i + 1 < middleEnd) {
        views.push({
          mode: "spread",
          left: i,
          right: i + 1,
          toc: meta[i].label + "｜" + meta[i + 1].label,
        });
        i += 2;
      } else {
        views.push({ mode: "single", page: i, toc: meta[i].label });
        i += 1;
      }
    }

    while (i < last) {
      views.push({ mode: "single", page: i, toc: meta[i].label });
      i += 1;
    }

    if (!views.some(function (v) {
      return v.page === last || (v.mode === "spread" && v.right === last);
    })) {
      views.push({ mode: "single", page: last, toc: meta[last].label });
    }

    return views;
  }

  async function loadPages(sourceUrl, options) {
    options = options || {};
    const res = await fetch(sourceUrl, { cache: "no-store" });
    if (!res.ok) throw new Error("load failed");
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    injectBrochureStyles(doc);
    let pages = Array.from(doc.querySelectorAll(".page"));
    if (pages.length < 1) pages = Array.from(doc.querySelectorAll(".sheet"));
    if (pages.length < 1) throw new Error("pages missing");
    const views = options.singlePageMode
      ? buildSinglePageViews(pages)
      : buildViews(pages);
    return { pages: pages, views: views };
  }

  function injectBrochureStyles(doc) {
    const style = doc.querySelector("style");
    if (style && !document.getElementById("brochure-injected-style")) {
      const injected = document.createElement("style");
      injected.id = "brochure-injected-style";
      let css = style.textContent;
      css = css.replace(/\bbody\s*\{[^}]*\}/g, "");
      css = css.replace(/\.sheet\s*\{[^}]*margin:[^}]*\}/g, function (m) {
        return m.replace(/margin:\s*[^;]+;/, "margin: 0;");
      });
      css +=
        "\n.viewer-page-slot .page,.viewer-page-slot .sheet{width:100%!important;height:100%!important;margin:0!important;box-shadow:none!important;page-break-after:auto!important;}\n" +
        ".viewer-page-slot .page .toolbar{display:none!important;}\n";
      injected.textContent = css;
      document.head.appendChild(injected);
    }
    const link = doc.querySelector('link[href*="fonts.googleapis.com"]');
    if (link && !document.querySelector('link[href*="fonts.googleapis.com"]')) {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = link.getAttribute("href");
      document.head.appendChild(l);
    }
  }

  return {
    buildViews: buildViews,
    buildSinglePageViews: buildSinglePageViews,
    loadPages: loadPages,
    pageMeta: pageMeta,
  };
});
