(function () {
  "use strict";

  document.documentElement.classList.add("js");

  var toggle = document.getElementById("navToggle");
  var nav = document.getElementById("nav");
  if (toggle && nav) {
    function closeMenu() {
      nav.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "メニューを開く");
    }
    function openMenu() {
      nav.classList.add("open");
      toggle.setAttribute("aria-expanded", "true");
      toggle.setAttribute("aria-label", "メニューを閉じる");
    }
    toggle.addEventListener("click", function () {
      if (nav.classList.contains("open")) closeMenu();
      else openMenu();
    });
    nav.addEventListener("click", function (e) {
      if (e.target.tagName === "A") closeMenu();
    });
    window.addEventListener("resize", function () {
      if (window.innerWidth > 760) closeMenu();
    });
  }

  var header = document.querySelector(".site-header-overlay");
  if (header) {
    function onScroll() {
      header.classList.toggle("is-scrolled", window.scrollY > 60);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  var fvVideo = document.querySelector(".fv-video");
  if (fvVideo) {
    fvVideo.play().catch(function () {
      fvVideo.style.display = "none";
    });
  }

  /* FV：運送／シャッター自動切替（日鉄型） */
  (function initFvHero() {
    var hero = document.getElementById("fvHero");
    if (!hero) return;

    var slides = hero.querySelectorAll(".fv-slide");
    var panels = hero.querySelectorAll(".fv-panel");
    var tabs = hero.querySelectorAll(".fv-business-tab");
    if (!slides.length || !panels.length) return;

    var interval = parseInt(hero.getAttribute("data-interval"), 10) || 4000;
    var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var current = 0;
    var timer = null;

    function restartProgress(tab) {
      tabs.forEach(function (t) { t.classList.remove("is-timing"); });
      if (!tab || reducedMotion) return;
      tab.style.setProperty("--fv-duration", interval + "ms");
      void tab.offsetWidth;
      tab.classList.add("is-timing");
    }

    function replayPanelLines(panel) {
      if (!panel || reducedMotion) return;
      panel.querySelectorAll(".reveal-line").forEach(function (line) {
        line.style.animation = "none";
        void line.offsetWidth;
        line.style.animation = "";
      });
    }

    function goTo(index) {
      current = (index + slides.length) % slides.length;
      var activeSlide = slides[current];
      var business = activeSlide ? parseInt(activeSlide.getAttribute("data-business"), 10) : 0;
      if (isNaN(business)) business = 0;

      slides.forEach(function (slide, i) {
        slide.classList.toggle("is-active", i === current);
      });
      panels.forEach(function (panel, i) {
        var on = i === business;
        panel.classList.toggle("is-active", on);
        panel.hidden = !on;
        if (on) replayPanelLines(panel);
      });
      tabs.forEach(function (tab, i) {
        var on = tabs.length ? i === business : false;
        tab.classList.toggle("is-active", on);
        tab.setAttribute("aria-selected", on ? "true" : "false");
      });
      hero.querySelectorAll(".fv-dot").forEach(function (dot, i) {
        dot.classList.toggle("is-active", i === current);
      });
      if (tabs.length) restartProgress(tabs[business]);
    }

    function scheduleNext() {
      if (timer) clearInterval(timer);
      if (reducedMotion) return;
      timer = setInterval(function () {
        goTo(current + 1);
      }, interval);
    }

    function activate(index) {
      goTo(index);
      scheduleNext();
    }

    function pauseAutoplay() {
      if (timer) clearInterval(timer);
      tabs.forEach(function (t) { t.classList.remove("is-timing"); });
    }

    function resumeAutoplay() {
      var activeSlide = slides[current];
      var business = activeSlide ? parseInt(activeSlide.getAttribute("data-business"), 10) : 0;
      if (isNaN(business)) business = 0;
      restartProgress(tabs[business]);
      scheduleNext();
    }

    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var idx = parseInt(tab.getAttribute("data-slide-to"), 10);
        if (!isNaN(idx)) activate(idx);
      });
    });

    hero.querySelectorAll(".fv-dot").forEach(function (dot) {
      dot.addEventListener("click", function () {
        var idx = parseInt(dot.getAttribute("data-slide-to"), 10);
        if (!isNaN(idx)) activate(idx);
      });
    });

    hero.addEventListener("mouseenter", pauseAutoplay);
    hero.addEventListener("mouseleave", resumeAutoplay);
    hero.addEventListener("focusin", pauseAutoplay);
    hero.addEventListener("focusout", function (e) {
      if (!hero.contains(e.relatedTarget)) resumeAutoplay();
    });

    activate(0);
  })();

  /* スクロール表示・数字カウント */
  (function initScrollFx() {
    var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    (function initAutoReveal() {
      var skipWithin = ".site-header, .site-footer, #pagetop, .nav-mega__panel, .ik-kv, .page-photo-header, .ik-biz-panel__bg, .ik-biz-panel__shade, .ik-biz-panel__watermark";
      var selectors = [
        ".ik-intro__catch",
        ".ik-intro__txt",
        ".ik-mascot__inner > *",
        ".ik-biz .ik-heading",
        ".ik-biz__lead",
        ".ik-biz-panel",
        ".ik-merit .ik-heading",
        ".ik-merit-item",
        ".ik-area .ik-heading",
        ".ik-area__card > *",
        ".ik-company .ik-heading",
        ".ik-company table",
        ".location-card",
        ".ik-inquiry .ik-heading",
        ".ik-inquiry-box",
        ".page-mascot-bar .mascot-strip-inner > *",
        ".section-head",
        ".subsection-head",
        ".step-flow > li",
        ".vehicle-card",
        ".vehicle-track__item",
        ".info-band",
        ".check-list > li",
        ".business-detail-item",
        ".service-highlight",
        ".photo-block",
        ".service-grid > .card",
        ".feature-grid > .feature-card",
        ".feature-cards > .feature-card",
        ".recruit-banner",
        ".recruit-cards > *",
        ".requirements",
        ".faq-item",
        ".flow > li",
        ".form-placeholder",
        ".contact-grid > *",
        ".page-cta-actions",
        ".legal-body > *"
      ];
      var seen = new Set();

      selectors.forEach(function (sel) {
        document.querySelectorAll("main " + sel).forEach(function (el) {
          if (el.closest(skipWithin) || seen.has(el)) return;
          seen.add(el);
          el.classList.add("reveal");
        });
      });

      document.querySelectorAll(
        "main .ik-merit__grid, main .service-grid, main .feature-grid, main .feature-cards, main .business-detail-grid, main .ik-inquiry__boxes, main .recruit-cards, main .contact-grid"
      ).forEach(function (grid) {
        Array.prototype.forEach.call(grid.children, function (child, i) {
          if (!child.classList.contains("reveal")) return;
          child.classList.add(i % 2 === 0 ? "reveal--left" : "reveal--right");
        });
      });

      document.querySelectorAll("main .ik-area__card > .reveal").forEach(function (el, i) {
        el.classList.add(i === 0 ? "reveal--left" : "reveal--right");
      });

      document.querySelectorAll(
        "main .ik-merit__grid, main .step-flow, main .business-detail-grid, main .ik-inquiry__boxes, main .recruit-cards, main .contact-grid, main .flow, main .faq-list, main .check-list"
      ).forEach(function (group) {
        var items = group.querySelectorAll(":scope > .reveal");
        items.forEach(function (el, i) {
          el.style.setProperty("--reveal-delay", i * 100 + "ms");
        });
      });

      document.querySelectorAll("main .photo-block, main .vehicle-card__media").forEach(function (el) {
        if (el.classList.contains("reveal")) el.classList.add("reveal--fade");
      });
    })();

    if ("IntersectionObserver" in window) {
      var revealObs = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          if (entry.target.querySelector("[data-count]")) {
            animateCounters(entry.target);
          }
          revealObs.unobserve(entry.target);
        });
      }, { threshold: 0.12, rootMargin: "0px 0px -80px 0px" });

      document.querySelectorAll(".reveal").forEach(function (el) {
        revealObs.observe(el);
      });

      var statsBand = document.querySelector(".stats-band");
      if (statsBand) {
        statsBand.classList.add("reveal");
        revealObs.observe(statsBand);
      }
    } else {
      document.querySelectorAll(".reveal").forEach(function (el) {
        el.classList.add("is-visible");
      });
      var statsBandFallback = document.querySelector(".stats-band");
      if (statsBandFallback) statsBandFallback.classList.add("is-visible");
    }

    function animateCounters(root) {
      if (reducedMotion) return;
      (root.querySelectorAll ? root.querySelectorAll("[data-count]") : []).forEach(function (el) {
        var target = parseInt(el.getAttribute("data-count"), 10);
        if (isNaN(target)) return;
        var unit = el.querySelector(".stat-unit");
        var unitHtml = unit ? unit.outerHTML : "";
        var start = 0;
        var duration = 1200;
        var t0 = performance.now();
        function tick(now) {
          var p = Math.min((now - t0) / duration, 1);
          var val = Math.round(start + (target - start) * (1 - Math.pow(1 - p, 3)));
          el.innerHTML = val + unitHtml;
          if (p < 1) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      });
    }

    var statsBand = document.querySelector(".stats-band");
    if (statsBand && reducedMotion) {
      statsBand.querySelectorAll("[data-count]").forEach(function (el) {
        var target = el.getAttribute("data-count");
        var unit = el.querySelector(".stat-unit");
        el.innerHTML = target + (unit ? unit.outerHTML : "");
      });
    }
  })();

  /* スクロール連動ヘッダー（トップ・下層写真ページ） */
  var findHeaderTheme = (function initScrollHeader() {
    var header = document.querySelector(".site-header-nitetsu");
    if (!header) return;
    var enabled = document.body.classList.contains("page-top")
      || document.body.classList.contains("page-scroll-header");
    if (!enabled) return;

    var lastTheme = "hero";

    function findHeaderTheme() {
      if (header.classList.contains("has-mega-open")) {
        if (lastTheme !== "light") {
          lastTheme = "light";
          header.setAttribute("data-theme", "light");
          header.style.removeProperty("--header-sync-bg");
          header.classList.add("is-solid");
        }
        return;
      }

      var probeY = header.getBoundingClientRect().bottom + 4;
      var probeX = Math.min(window.innerWidth * 0.5, window.innerWidth - 8);
      var theme = "hero";
      var bg = "";

      if (window.scrollY > 40) {
        var stack = document.elementsFromPoint(probeX, probeY);
        for (var i = 0; i < stack.length; i++) {
          if (stack[i].closest(".site-header-nitetsu")) continue;
          var themed = stack[i].closest("[data-header-theme]");
          if (themed) {
            theme = themed.getAttribute("data-header-theme") || "light";
            bg = themed.getAttribute("data-header-bg") || "";
            break;
          }
        }
        if (theme === "hero" && lastTheme !== "hero") {
          theme = lastTheme;
        }
      }

      lastTheme = theme;
      header.setAttribute("data-theme", theme);
      header.classList.toggle("is-solid", theme !== "hero");
      if (bg && theme !== "hero") {
        header.style.setProperty("--header-sync-bg", bg);
      } else {
        header.style.removeProperty("--header-sync-bg");
      }
    }

    findHeaderTheme();
    window.addEventListener("scroll", findHeaderTheme, { passive: true });
    window.addEventListener("resize", findHeaderTheme);

    return findHeaderTheme;
  })();

  /* 事業案内パネル → メガメニュー */
  (function initMegaMenu() {
    var header = document.querySelector(".site-header-nitetsu");
    var megas = document.querySelectorAll(".nav-mega");
    if (!megas.length || !findHeaderTheme) return;

    megas.forEach(function (item) {
      var trigger = item.querySelector(".nav-mega__trigger");
      if (!trigger) return;

      trigger.addEventListener("click", function (e) {
        if (window.innerWidth > 760) return;
        e.preventDefault();
        var wasOpen = item.classList.contains("is-open");
        megas.forEach(function (m) { m.classList.remove("is-open"); });
        if (!wasOpen) item.classList.add("is-open");
        findHeaderTheme();
      });

      item.addEventListener("mouseenter", function () {
        if (header) header.classList.add("has-mega-open");
        findHeaderTheme();
      });
      item.addEventListener("mouseleave", function () {
        if (header) header.classList.remove("has-mega-open");
        if (window.innerWidth > 760) item.classList.remove("is-open");
        findHeaderTheme();
      });
    });

    document.addEventListener("click", function (e) {
      if (e.target.closest(".nav-mega")) return;
      megas.forEach(function (m) { m.classList.remove("is-open"); });
      if (header) header.classList.remove("has-mega-open");
      findHeaderTheme();
    });
  })();

  (function initBizPanels() {
    var root = document.getElementById("bizPanels");
    if (!root) return;
    var panels = root.querySelectorAll(".ik-biz-panel");
    var canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

    panels.forEach(function (panel) {
      panel.addEventListener("mouseenter", function () {
        if (!canHover) return;
        panels.forEach(function (p) { p.classList.remove("is-active"); });
        panel.classList.add("is-active");
      });
    });
    root.addEventListener("mouseleave", function () {
      if (!canHover) return;
      panels.forEach(function (p) { p.classList.remove("is-active"); });
    });

    if (!canHover) {
      panels.forEach(function (panel) {
        panel.addEventListener("click", function (e) {
          if (panel.classList.contains("is-active")) return;
          e.preventDefault();
          panels.forEach(function (p) { p.classList.remove("is-active"); });
          panel.classList.add("is-active");
        });
      });
    }
  })();

  /* ページトップへ */
  var pagetop = document.getElementById("pagetop");
  if (pagetop) {
    function togglePagetop() {
      pagetop.classList.toggle("is-visible", window.scrollY > 400);
    }
    togglePagetop();
    window.addEventListener("scroll", togglePagetop, { passive: true });
    pagetop.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  document.querySelectorAll(".mascot-figure .mascot-img").forEach(function (img) {
    function applyMascotVariant() {
      var fig = img.closest(".mascot-figure");
      if (!fig) return;
      var src = img.currentSrc || img.src || "";
      var isPng = /\.png(\?|#|$)/i.test(src);
      fig.classList.toggle("is-png", isPng);
      fig.classList.toggle("is-sheet", !isPng);
    }
    if (img.complete) applyMascotVariant();
    else img.addEventListener("load", applyMascotVariant);
  });

  document.querySelectorAll(".media-slot").forEach(function (slot) {
    var img = slot.querySelector(".media-slot__img");
    if (!img) return;
    function sync() {
      slot.classList.toggle("is-empty", !img.complete || img.naturalWidth === 0);
    }
    img.addEventListener("load", sync);
    img.addEventListener("error", function () { slot.classList.add("is-empty"); });
    sync();
  });

  /* 任意写真（images/ に置いたときだけ表示。無ければ非表示のまま） */
  document.querySelectorAll(".photo-slot, .vehicle-card__img").forEach(function (img) {
    function sync() {
      var ok = img.complete && img.naturalWidth > 0;
      img.classList.toggle("is-loaded", ok);
      var li = img.closest(".step-flow li");
      if (li) li.classList.toggle("has-photo", ok);
      var fleet = img.closest(".fleet-item");
      if (fleet) fleet.classList.toggle("has-photo", ok);
      var vcard = img.closest(".vehicle-card");
      if (vcard) vcard.classList.toggle("has-photo", ok);
    }
    img.addEventListener("load", sync);
    img.addEventListener("error", function () {
      img.classList.remove("is-loaded");
      var li = img.closest(".step-flow li");
      if (li) li.classList.remove("has-photo");
      var fleet = img.closest(".fleet-item");
      if (fleet) fleet.classList.remove("has-photo");
      var vcard = img.closest(".vehicle-card");
      if (vcard) vcard.classList.remove("has-photo");
    });
    sync();
  });
})();
