(function () {
  "use strict";

  var ROOT_ATTR = "data-custom-nav-root";
  var ITEM_ATTR = "data-custom-nav-id";
  var MODAL_ATTR = "data-custom-nav-modal";
  var CONFIG_URL = "/custom/nav-config.json";
  var LOG_PREFIX = "[custom-nav]";
  var WARN_INTERVAL_MS = 10000;
  var CONFIG_CACHE_MS = 30000;

  var lastWarnAt = 0;
  var configCache = null;
  var configCacheAt = 0;
  var reapplyTimer = null;
  var observer = null;
  var stableHost = null;

  function logWarn(msg) {
    var now = Date.now();
    if (now - lastWarnAt < WARN_INTERVAL_MS) {
      return;
    }
    lastWarnAt = now;
    console.warn(LOG_PREFIX + " " + msg);
  }

  function isVisibleElement(el) {
    if (!el) return false;
    var style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function isLikelyAuthPage() {
    var negativeSelectors = [
      "input[type='password']",
      "form[action*='login']",
      "a[href*='/auth']",
      "[data-testid*='login']",
      "[data-testid*='auth']",
      "[id*='login']"
    ];
    for (var i = 0; i < negativeSelectors.length; i += 1) {
      if (document.querySelector(negativeSelectors[i])) {
        return true;
      }
    }
    return false;
  }

  function hasTokenLikeStorageKey() {
    var stores = [window.localStorage, window.sessionStorage];
    for (var s = 0; s < stores.length; s += 1) {
      var store = stores[s];
      if (!store) continue;
      for (var i = 0; i < store.length; i += 1) {
        var key = String(store.key(i) || "").toLowerCase();
        if (
          key.indexOf("token") !== -1 ||
          key.indexOf("auth") !== -1 ||
          key.indexOf("jwt") !== -1 ||
          key.indexOf("session") !== -1
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function isAuthenticated() {
    if (isLikelyAuthPage()) {
      return false;
    }

    var positiveSelectors = [
      "aside",
      "#nav",
      "nav[aria-label*='side' i]",
      "button[aria-label*='account' i]",
      "[data-testid*='user-menu']"
    ];

    var positiveCount = 0;
    for (var i = 0; i < positiveSelectors.length; i += 1) {
      var match = document.querySelector(positiveSelectors[i]);
      if (match && isVisibleElement(match)) {
        positiveCount += 1;
      }
    }

    if (positiveCount > 0) {
      return true;
    }
    return hasTokenLikeStorageKey();
  }

  function sanitizeHtml(input) {
    if (typeof input !== "string") {
      return "";
    }
    var parser = new DOMParser();
    var doc = parser.parseFromString(input, "text/html");

    var blockedTags = ["script", "iframe", "object", "embed", "style", "link", "meta"];
    for (var i = 0; i < blockedTags.length; i += 1) {
      var nodes = doc.querySelectorAll(blockedTags[i]);
      nodes.forEach(function (node) {
        node.remove();
      });
    }

    doc.querySelectorAll("*").forEach(function (el) {
      var attrs = Array.prototype.slice.call(el.attributes || []);
      attrs.forEach(function (attr) {
        var name = String(attr.name || "").toLowerCase();
        var value = String(attr.value || "");
        if (name.indexOf("on") === 0) {
          el.removeAttribute(attr.name);
          return;
        }
        if ((name === "href" || name === "src") && /^\s*javascript:/i.test(value)) {
          el.removeAttribute(attr.name);
        }
      });
    });

    return doc.body.innerHTML;
  }

  function validateConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new Error("config must be an object");
    }
    if (typeof raw.sectionLabel !== "string" || raw.sectionLabel.trim() === "") {
      throw new Error("config.sectionLabel must be a non-empty string");
    }
    if (!Array.isArray(raw.items)) {
      throw new Error("config.items must be an array");
    }

    var placement = {
      position: "bottom",
      anchorText: "New Chat",
      anchorSelector: ""
    };
    if (raw.placement && typeof raw.placement === "object") {
      if (
        typeof raw.placement.position === "string" &&
        ["before", "after", "top", "bottom"].indexOf(raw.placement.position) !== -1
      ) {
        placement.position = raw.placement.position;
      }
      if (typeof raw.placement.anchorText === "string" && raw.placement.anchorText.trim() !== "") {
        placement.anchorText = raw.placement.anchorText.trim();
      }
      if (typeof raw.placement.anchorSelector === "string") {
        placement.anchorSelector = raw.placement.anchorSelector.trim();
      }
    }

    var validItems = [];
    raw.items.forEach(function (item) {
      if (!item || typeof item !== "object") {
        return;
      }
      if (typeof item.id !== "string" || typeof item.label !== "string") {
        return;
      }
      if (item.type === "external") {
        if (typeof item.url !== "string" || item.url.trim() === "") {
          return;
        }
        validItems.push({
          id: item.id,
          label: item.label,
          type: "external",
          url: item.url,
          newTab: Boolean(item.newTab),
          iconPath: typeof item.iconPath === "string" ? item.iconPath : "",
          iconViewBox: typeof item.iconViewBox === "string" ? item.iconViewBox : "0 0 24 24",
          iconStrokeWidth:
            typeof item.iconStrokeWidth === "number" && item.iconStrokeWidth > 0
              ? item.iconStrokeWidth
              : 2
        });
        return;
      }
      if (item.type === "modal") {
        if (typeof item.modalTitle !== "string" || typeof item.modalHtml !== "string") {
          return;
        }
        validItems.push({
          id: item.id,
          label: item.label,
          type: "modal",
          modalTitle: item.modalTitle,
          modalHtml: item.modalHtml,
          iconPath: typeof item.iconPath === "string" ? item.iconPath : "",
          iconViewBox: typeof item.iconViewBox === "string" ? item.iconViewBox : "0 0 24 24",
          iconStrokeWidth:
            typeof item.iconStrokeWidth === "number" && item.iconStrokeWidth > 0
              ? item.iconStrokeWidth
              : 2
        });
      }
    });

    if (validItems.length === 0) {
      throw new Error("config.items has no valid entries");
    }

    return {
      sectionLabel: raw.sectionLabel,
      placement: placement,
      items: validItems
    };
  }

  function loadConfig() {
    var now = Date.now();
    if (configCache && now - configCacheAt < CONFIG_CACHE_MS) {
      return Promise.resolve(configCache);
    }
    var sep = CONFIG_URL.indexOf("?") === -1 ? "?" : "&";
    return fetch(CONFIG_URL + sep + "t=" + now, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) {
          throw new Error("HTTP " + res.status + " loading nav-config");
        }
        return res.json();
      })
      .then(function (raw) {
        var cfg = validateConfig(raw);
        configCache = cfg;
        configCacheAt = now;
        return cfg;
      });
  }

  function sidebarCandidates() {
    var selectors = [
      "aside nav",
      "aside",
      "nav[aria-label*='side' i]",
      "nav#nav",
      "#nav",
      "[data-testid*='sidebar' i]"
    ];
    var results = [];
    for (var i = 0; i < selectors.length; i += 1) {
      document.querySelectorAll(selectors[i]).forEach(function (el) {
        if (results.indexOf(el) !== -1) return;
        if (!isVisibleElement(el)) return;
        var interactive = el.querySelectorAll("a,button").length;
        if (interactive < 3) return;
        results.push(el);
      });
      if (results.length > 0) {
        break;
      }
    }

    if (results.length > 0) {
      return results;
    }

    document.querySelectorAll("aside,nav,div").forEach(function (el) {
      if (results.indexOf(el) !== -1) return;
      if (!isVisibleElement(el)) return;
      var links = el.querySelectorAll("a[href^='/'],button").length;
      var cls = String(el.className || "").toLowerCase();
      if (links >= 6 && (cls.indexOf("sidebar") !== -1 || cls.indexOf("nav") !== -1)) {
        results.push(el);
      }
    });
    return results;
  }

  function resolveHost() {
    if (stableHost && stableHost.isConnected && isVisibleElement(stableHost)) {
      return stableHost;
    }
    var candidates = sidebarCandidates();
    if (candidates.length === 0) {
      return null;
    }
    stableHost = candidates[0];
    return stableHost;
  }

  function closeModal() {
    var existing = document.querySelector("[" + MODAL_ATTR + "='true']");
    if (existing) {
      existing.remove();
      document.body.style.overflow = "";
    }
  }

  function stopEvent(evt) {
    if (!evt) return;
    if (typeof evt.preventDefault === "function") evt.preventDefault();
    if (typeof evt.stopPropagation === "function") evt.stopPropagation();
    if (typeof evt.stopImmediatePropagation === "function") evt.stopImmediatePropagation();
  }

  function bindIsolatedActivate(el, onActivate) {
    // Capture-phase handlers run before parent framework handlers.
    function pointerGuard(evt) {
      evt.stopPropagation();
      if (typeof evt.stopImmediatePropagation === "function") {
        evt.stopImmediatePropagation();
      }
    }
    function activate(evt) {
      stopEvent(evt);
      onActivate();
    }
    function keyActivate(evt) {
      var key = evt.key;
      if (key === "Enter" || key === " ") {
        stopEvent(evt);
        onActivate();
      }
    }
    el.addEventListener("pointerdown", pointerGuard, true);
    el.addEventListener("mousedown", pointerGuard, true);
    el.addEventListener("click", activate, true);
    el.addEventListener("keydown", keyActivate, true);
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function buildConfigSignature(config) {
    var normalized = {
      sectionLabel: config.sectionLabel,
      placement: config.placement,
      items: config.items.map(function (item) {
        if (item.type === "external") {
          return {
            id: item.id,
            label: item.label,
            type: item.type,
            url: item.url,
            newTab: Boolean(item.newTab),
            iconPath: item.iconPath,
            iconViewBox: item.iconViewBox,
            iconStrokeWidth: item.iconStrokeWidth
          };
        }
        return {
          id: item.id,
          label: item.label,
          type: item.type,
          modalTitle: item.modalTitle,
          modalHtml: item.modalHtml,
          iconPath: item.iconPath,
          iconViewBox: item.iconViewBox,
          iconStrokeWidth: item.iconStrokeWidth
        };
      })
    };
    return JSON.stringify(normalized);
  }

  function defaultIconPath(item) {
    if (item.type === "external") {
      return "M13.5 6H18m0 0v4.5M18 6l-7.5 7.5M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6";
    }
    return "M12 8h.01M11 12h1v4h1m-1 6a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z";
  }

  function buildItemIcon(item) {
    var iconWrap = document.createElement("div");
    iconWrap.className = "self-center";

    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("fill", "none");
    svg.setAttribute("viewBox", item.iconViewBox || "0 0 24 24");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("stroke-width", String(item.iconStrokeWidth || 2));
    svg.setAttribute("class", "size-4.5");

    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("d", item.iconPath || defaultIconPath(item));
    svg.appendChild(path);
    iconWrap.appendChild(svg);
    return iconWrap;
  }

  function findAnchorElement(host, placement) {
    if (!host || !placement) return null;

    if (placement.anchorSelector) {
      try {
        var selected = host.querySelector(placement.anchorSelector);
        if (selected) return selected;
      } catch (_err) {
        logWarn("Invalid placement.anchorSelector. Falling back to anchorText matching.");
      }
    }

    var target = normalizeText(placement.anchorText);
    if (!target) return null;
    var candidates = host.querySelectorAll("a,button,[role='button'],div");
    for (var i = 0; i < candidates.length; i += 1) {
      var el = candidates[i];
      if (el.closest("[" + ROOT_ATTR + "='true']")) continue;
      var text = normalizeText(el.textContent);
      if (!text) continue;
      if (text === target || text.indexOf(target) !== -1) {
        return el;
      }
    }
    return null;
  }

  function insertNavRoot(host, root, placement) {
    var mode = placement && placement.position ? placement.position : "bottom";
    if (mode === "top") {
      host.prepend(root);
      return;
    }
    if (mode === "bottom") {
      host.appendChild(root);
      return;
    }

    var anchor = findAnchorElement(host, placement);
    if (!anchor) {
      logWarn(
        "Placement anchor not found (" +
          (placement && placement.anchorText ? placement.anchorText : "unknown") +
          "). Appending custom nav to bottom."
      );
      host.appendChild(root);
      return;
    }

    var anchorContainer = anchor.closest("li,div,a,button") || anchor;
    if (mode === "after") {
      anchorContainer.insertAdjacentElement("afterend", root);
    } else {
      anchorContainer.insertAdjacentElement("beforebegin", root);
    }
  }

  function openModal(title, html) {
    closeModal();
    var overlay = document.createElement("div");
    overlay.setAttribute(MODAL_ATTR, "true");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("style", "scrollbar-gutter: stable;");
    overlay.className =
      "modal fixed top-0 right-0 left-0 bottom-0 bg-black/30 dark:bg-black/60 w-full h-screen max-h-[100dvh] p-3 flex justify-center z-9999 overflow-y-auto overscroll-contain svelte-1vr5p4p";

    var dialog = document.createElement("div");
    dialog.className =
      "m-auto max-w-full w-[70rem] mx-2 shadow-3xl min-h-fit scrollbar-hidden bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm rounded-4xl border border-white dark:border-gray-850 svelte-1vr5p4p";
    dialog.setAttribute("role", "document");
    dialog.addEventListener("click", function (evt) {
      evt.stopPropagation();
    });

    var shell = document.createElement("div");
    shell.className = "py-3 dark:text-gray-300 text-gray-700";

    var header = document.createElement("div");
    header.className = "px-4 pb-1.5 flex items-center justify-between gap-3";

    var heading = document.createElement("h2");
    heading.className = "text-base font-medium";
    heading.textContent = title;
    heading.id = "custom-nav-modal-title";
    overlay.setAttribute("aria-labelledby", heading.id);

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className =
      "px-2.5 py-1.5 rounded-lg text-sm border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-850 transition";
    closeBtn.textContent = "Close";
    closeBtn.setAttribute("aria-label", "Close modal");

    var body = document.createElement("div");
    body.className = "px-4 pb-2 text-sm";
    body.innerHTML = sanitizeHtml(html);

    header.appendChild(heading);
    header.appendChild(closeBtn);
    shell.appendChild(header);
    shell.appendChild(body);
    dialog.appendChild(shell);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";
    closeBtn.focus();

    function onEsc(evt) {
      if (evt.key === "Escape") {
        closeModal();
        document.removeEventListener("keydown", onEsc, true);
      }
    }
    function onBackdropClick(evt) {
      if (evt.target === overlay) {
        closeModal();
        document.removeEventListener("keydown", onEsc, true);
      }
    }
    function onCloseClick() {
      closeModal();
      document.removeEventListener("keydown", onEsc, true);
    }

    closeBtn.addEventListener("click", onCloseClick);
    overlay.addEventListener("click", onBackdropClick);
    document.addEventListener("keydown", onEsc, true);
  }

  function buildNavRoot(config) {
    var root = document.createElement("section");
    root.setAttribute(ROOT_ATTR, "true");

    var label = document.createElement("div");
    label.className = "custom-nav-section-label";
    label.textContent = config.sectionLabel;
    root.appendChild(label);

    var list = document.createElement("ul");
    list.className = "custom-nav-list";
    root.appendChild(list);

    config.items.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "custom-nav-item px-[0.4375rem] flex justify-center text-gray-800 dark:text-gray-200";
      li.setAttribute(ITEM_ATTR, item.id);

      if (item.type === "external") {
        var a = document.createElement("a");
        a.className =
          "custom-nav-link group grow flex items-center space-x-3 rounded-2xl px-2.5 py-2 hover:bg-gray-100 dark:hover:bg-gray-900 transition outline-none";
        a.href = item.url;
        bindIsolatedActivate(a, function () {
          if (item.newTab) {
            window.open(item.url, "_blank", "noopener,noreferrer");
          } else {
            window.location.assign(item.url);
          }
        });
        if (item.newTab) {
          a.target = "_blank";
          a.rel = "noopener noreferrer";
        }
        a.appendChild(buildItemIcon(item));
        var aLabelWrap = document.createElement("div");
        aLabelWrap.className = "flex flex-1 self-center translate-y-[0.5px]";
        var aLabel = document.createElement("div");
        aLabel.className = "self-center text-sm font-primary";
        aLabel.textContent = item.label;
        aLabelWrap.appendChild(aLabel);
        a.appendChild(aLabelWrap);
        li.appendChild(a);
      } else if (item.type === "modal") {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          "custom-nav-link custom-nav-button group grow flex items-center space-x-3 rounded-2xl px-2.5 py-2 hover:bg-gray-100 dark:hover:bg-gray-900 transition outline-none";
        bindIsolatedActivate(btn, function () {
          openModal(item.modalTitle, item.modalHtml);
        });
        btn.appendChild(buildItemIcon(item));
        var bLabelWrap = document.createElement("div");
        bLabelWrap.className = "flex flex-1 self-center translate-y-[0.5px]";
        var bLabel = document.createElement("div");
        bLabel.className = "self-center text-sm font-primary";
        bLabel.textContent = item.label;
        bLabelWrap.appendChild(bLabel);
        btn.appendChild(bLabelWrap);
        li.appendChild(btn);
      }

      list.appendChild(li);
    });

    return root;
  }

  function ensureInjected() {
    if (!isAuthenticated()) {
      document.querySelectorAll("[" + ROOT_ATTR + "='true']").forEach(function (el) {
        el.remove();
      });
      closeModal();
      return;
    }

    loadConfig()
      .then(function (config) {
        var host = resolveHost();
        if (!host) {
          logWarn("No sidebar candidate found. Custom nav not injected.");
          return;
        }
        var signature = buildConfigSignature(config);
        var existing = document.querySelector("[" + ROOT_ATTR + "='true']");
        if (existing && existing.getAttribute("data-custom-nav-signature") === signature) {
          if (existing.parentElement !== host && host.isConnected) {
            host.appendChild(existing);
          }
          return;
        }
        if (existing) {
          existing.remove();
        }
        var built = buildNavRoot(config);
        built.setAttribute("data-custom-nav-signature", signature);
        insertNavRoot(host, built, config.placement);
      })
      .catch(function (err) {
        logWarn("Failed to load or apply nav-config: " + String(err && err.message ? err.message : err));
      });
  }

  function scheduleEnsure() {
    if (reapplyTimer) {
      window.clearTimeout(reapplyTimer);
    }
    reapplyTimer = window.setTimeout(function () {
      ensureInjected();
    }, 120);
  }

  function installHistoryHooks() {
    var originalPushState = history.pushState;
    var originalReplaceState = history.replaceState;

    history.pushState = function () {
      var result = originalPushState.apply(this, arguments);
      scheduleEnsure();
      return result;
    };
    history.replaceState = function () {
      var result = originalReplaceState.apply(this, arguments);
      scheduleEnsure();
      return result;
    };
    window.addEventListener("popstate", scheduleEnsure);
  }

  function installObserver() {
    if (observer) return;
    observer = new MutationObserver(function (mutations) {
      var hasRelevantMutation = mutations.some(function (mutation) {
        var target = mutation.target;
        if (!target || !target.closest) {
          return true;
        }
        var insideCustomNav = target.closest("[" + ROOT_ATTR + "='true']");
        var insideModal = target.closest("[" + MODAL_ATTR + "='true']");
        return !insideCustomNav && !insideModal;
      });
      if (!hasRelevantMutation) {
        return;
      }
      scheduleEnsure();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function boot() {
    ensureInjected();
    installHistoryHooks();
    installObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
