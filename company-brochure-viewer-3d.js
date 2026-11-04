(function () {
  const SOURCE = "company-brochure-view.html";
  let pages = [];
  let views = [];
  let viewIndex = 0;
  let flipping = false;

  const els = {
    loading: document.getElementById("viewer-loading"),
    bookRoot: document.getElementById("book-root"),
    spread: document.getElementById("book-spread"),
    left: document.getElementById("book-left"),
    right: document.getElementById("book-right"),
    pageNum: document.getElementById("page-num"),
    btnPrev: document.getElementById("btn-prev"),
    btnNext: document.getElementById("btn-next"),
    btnTocOpen: document.getElementById("btn-toc"),
    toc: document.getElementById("viewer-toc"),
    btnTocClose: document.getElementById("btn-toc-close"),
    tocList: document.getElementById("toc-list"),
  };

  function mountPage(slot, index) {
    slot.innerHTML = "";
    slot.classList.remove("book-page--empty");
    if (index == null) {
      slot.classList.add("book-page--empty");
      slot.style.visibility = "hidden";
      return;
    }
    slot.style.visibility = "visible";
    slot.appendChild(pages[index].cloneNode(true));
  }

  function renderView(animate) {
    const view = views[viewIndex];
    const isSingle = view.mode === "single";
    els.spread.classList.toggle("book-spread--single", isSingle);

    if (isSingle) {
      mountPage(els.left, null);
      mountPage(els.right, view.page);
    } else {
      mountPage(els.left, view.left);
      mountPage(els.right, view.right);
    }

    els.pageNum.textContent = viewIndex + 1 + " / " + views.length;
    els.btnPrev.disabled = viewIndex <= 0 || flipping;
    els.btnNext.disabled = viewIndex >= views.length - 1 || flipping;

    if (animate) {
      els.bookRoot.classList.remove("is-flipping-forward", "is-flipping-back");
      void els.bookRoot.offsetWidth;
    }
  }

  function goView(nextIndex, direction) {
    if (flipping || nextIndex === viewIndex) return;
    if (nextIndex < 0 || nextIndex >= views.length) return;
    flipping = true;
    els.btnPrev.disabled = true;
    els.btnNext.disabled = true;

    const turning = direction > 0 ? els.right : els.left;
    if (turning && views[viewIndex].mode === "spread") {
      turning.classList.add("is-turning");
    }
    els.bookRoot.classList.add(direction > 0 ? "is-flipping-forward" : "is-flipping-back");

    window.setTimeout(function () {
      viewIndex = nextIndex;
      if (turning) turning.classList.remove("is-turning");
      renderView(true);
      flipping = false;
    }, direction > 0 ? 520 : 380);
  }

  function buildToc() {
    els.tocList.innerHTML = "";
    views.forEach(function (v, i) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = v.toc;
      btn.addEventListener("click", function () {
        viewIndex = i;
        renderView(false);
        closeToc();
      });
      li.appendChild(btn);
      els.tocList.appendChild(li);
    });
  }

  function closeToc() {
    els.toc.classList.remove("is-open");
  }

  els.btnPrev.addEventListener("click", function () {
    goView(viewIndex - 1, -1);
  });
  els.btnNext.addEventListener("click", function () {
    goView(viewIndex + 1, 1);
  });
  els.btnTocOpen.addEventListener("click", function () {
    els.toc.classList.add("is-open");
  });
  els.btnTocClose.addEventListener("click", closeToc);
  els.toc.addEventListener("click", function (e) {
    if (e.target === els.toc) closeToc();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "ArrowLeft") goView(viewIndex - 1, -1);
    if (e.key === "ArrowRight") goView(viewIndex + 1, 1);
    if (e.key === "Escape") closeToc();
  });

  BrochureBooklet.loadPages(SOURCE)
    .then(function (data) {
      pages = data.pages;
      views = data.views;
      buildToc();
      els.loading.classList.add("is-hidden");
      renderView(false);
    })
    .catch(function () {
      els.loading.textContent =
        "読み込み失敗。広報/HP で http.server を起動してください。";
    });
})();
