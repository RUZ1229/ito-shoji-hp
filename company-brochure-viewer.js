(function () {
  const SOURCE = "../会社案内/伊藤商事_会社案内_印刷版.html";
  let pages = [];
  let views = [];
  let viewIndex = 0;
  let zoom = 1;

  const els = {
    loading: document.getElementById("viewer-loading"),
    current: document.getElementById("page-current"),
    bookWrap: document.getElementById("book-wrap"),
    pageNum: document.getElementById("page-num"),
    btnPrev: document.getElementById("btn-prev"),
    btnNext: document.getElementById("btn-next"),
    btnZoomIn: document.getElementById("btn-zoom-in"),
    btnZoomOut: document.getElementById("btn-zoom-out"),
    btnTocOpen: document.getElementById("btn-toc"),
    toc: document.getElementById("viewer-toc"),
    btnTocClose: document.getElementById("btn-toc-close"),
    tocList: document.getElementById("toc-list"),
  };

  function fitZoom() {
    const stage = document.querySelector(".viewer-stage");
    if (!stage || !els.bookWrap) return;
    const pad = 40;
    const sw = els.bookWrap.offsetWidth;
    const sh = els.bookWrap.offsetHeight;
    if (!sw || !sh) return;
    const maxW = stage.clientWidth - pad;
    const maxH = stage.clientHeight - pad;
    const fit = Math.min(maxW / sw, maxH / sh, 1);
    zoom = Math.max(0.5, Math.min(1, fit));
    applyZoom();
  }

  function applyZoom() {
    els.bookWrap.style.transform = "scale(" + zoom + ")";
    els.btnZoomIn.disabled = zoom >= 1.05;
    els.btnZoomOut.disabled = zoom <= 0.5;
  }

  function renderPage(direction) {
    const view = views[viewIndex];
    els.current.classList.remove("viewer-page-slot--enter-next", "viewer-page-slot--enter-prev");
    void els.current.offsetWidth;
    if (direction === "next") els.current.classList.add("viewer-page-slot--enter-next");
    if (direction === "prev") els.current.classList.add("viewer-page-slot--enter-prev");

    els.current.innerHTML = "";
    const node = pages[view.page].cloneNode(true);
    node.querySelectorAll('img[src^="images/"]').forEach(function (img) {
      var s = img.getAttribute("src");
      if (s && s.indexOf("/") === -1) img.setAttribute("src", s);
    });
    els.current.appendChild(node);

    const total = pages.length;
    els.pageNum.textContent = view.pageNum + " / " + total;
    els.btnPrev.disabled = viewIndex <= 0;
    els.btnNext.disabled = viewIndex >= views.length - 1;
    requestAnimationFrame(fitZoom);
  }

  function goView(i, direction) {
    const next = Math.max(0, Math.min(views.length - 1, i));
    const dir =
      direction || (next > viewIndex ? "next" : next < viewIndex ? "prev" : null);
    viewIndex = next;
    renderPage(dir);
    closeToc();
  }

  function closeToc() {
    els.toc.classList.remove("is-open");
  }

  function buildToc() {
    els.tocList.innerHTML = "";
    views.forEach(function (view, i) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = view.pageNum + ". " + view.toc;
      btn.addEventListener("click", function () {
        goView(i);
      });
      li.appendChild(btn);
      els.tocList.appendChild(li);
    });
  }

  els.btnPrev.addEventListener("click", function () {
    goView(viewIndex - 1, "prev");
  });
  els.btnNext.addEventListener("click", function () {
    goView(viewIndex + 1, "next");
  });
  els.btnZoomIn.addEventListener("click", function () {
    zoom = Math.min(1.2, zoom + 0.1);
    applyZoom();
  });
  els.btnZoomOut.addEventListener("click", function () {
    zoom = Math.max(0.5, zoom - 0.1);
    applyZoom();
  });
  els.btnTocOpen.addEventListener("click", function () {
    els.toc.classList.add("is-open");
  });
  els.btnTocClose.addEventListener("click", closeToc);
  els.toc.addEventListener("click", function (e) {
    if (e.target === els.toc) closeToc();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "ArrowLeft") goView(viewIndex - 1, "prev");
    if (e.key === "ArrowRight") goView(viewIndex + 1, "next");
    if (e.key === "Escape") closeToc();
  });

  window.addEventListener("resize", fitZoom);

  BrochureBooklet.loadPages(SOURCE, { singlePageMode: true })
    .then(function (data) {
      pages = data.pages;
      views = data.views;
      buildToc();
      els.loading.classList.add("is-hidden");
      renderPage();
    })
    .catch(function () {
      els.loading.textContent =
        "ページを読み込めませんでした。広報/HP で http.server を起動して開いてください。";
    });
})();
