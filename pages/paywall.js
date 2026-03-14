/* paywall.js — BULLETPROOF (v77792)
   - Free cap: 3/day (UI-local)
   - Plus cap: 200/day (UI-local)
   - Clicking "Finch Plus" opens #plusModal (from app.html)
   - /api/plan determines plus/free + enforces 2-device seats
   - On DEVICE_LIMIT_REACHED:
       - keep modal open
       - show clean notice + one action: "Remove your oldest device"
       - everything happens IN the modal (no navigation)
       - after removal, automatically retries unlock
   - Intercepts Finch API POST when cap is hit (local counter)
   - Automatically attaches x-finch-email + x-finch-device to Finch API calls
   - Avoids newer JS syntax that breaks older Android WebViews (catch{}, replaceAll, optional chaining)
*/

(() => {
  console.log("PAYWALL RUNNING v77792 - " + new Date().toISOString());

  if (window.__FINCH_PAYWALL_LOADED__ === true) return;
  window.__FINCH_PAYWALL_LOADED__ = true;

  // =========================
  // CONFIG
  // =========================
  const FREE_DAILY_LIMIT = 3;
  const PLUS_DAILY_LIMIT = 200;

  const STRIPE_URL = "https://buy.stripe.com/3cIdR90dd5Fd4CR1CX4ow01";
  function safeTrim(v) {
    return String(v || "").trim();
  }

  function stripTrailingSlashes(v) {
    return String(v || "").replace(/\/+$/, "");
  }

  function getConfiguredApiBase() {
    const globalBase = safeTrim(window.__FINCH_API_BASE__);
    if (globalBase) return stripTrailingSlashes(globalBase);

    const meta = document.querySelector('meta[name="finch-api-base"]');
    const metaBase = safeTrim(meta && meta.getAttribute("content"));
    if (metaBase) return stripTrailingSlashes(metaBase);

    return stripTrailingSlashes(window.location.origin || "");
  }

  const API_BASE = getConfiguredApiBase();
  const API_URL   = API_BASE + "/api/finch";
  const PLAN_URL  = API_BASE + "/api/plan";
  const REMOVE_OLDEST_URL = API_BASE + "/api/devices/remove-oldest";

  const PLUS_ACTIVE_KEY = "finch_plus_active";
  const PLUS_EMAIL_KEY  = "finch_plus_email";
  const DEVICE_ID_KEY   = "finch_device_id";

  let stripeNavStarted = false;
  let plusClickBusy = false;
  let continueBusy = false;
  let removeBusy = false;

  // =========================
  // STATE
  // =========================
  function isPlusActive() {
    return localStorage.getItem(PLUS_ACTIVE_KEY) === "true";
  }

  function getPlusEmail() {
    return (localStorage.getItem(PLUS_EMAIL_KEY) || "").trim().toLowerCase();
  }

  function setPlusActive(email) {
    localStorage.setItem(PLUS_ACTIVE_KEY, "true");
    if (email) localStorage.setItem(PLUS_EMAIL_KEY, String(email).trim().toLowerCase());
    refreshUI();
  }

  function clearPlusActive() {
    localStorage.removeItem(PLUS_ACTIVE_KEY);
    localStorage.removeItem(PLUS_EMAIL_KEY);
    refreshUI();
  }

  // =========================
  // DEVICE ID (stable per device)
  // =========================
  function getOrCreateDeviceId() {
    const existing = (localStorage.getItem(DEVICE_ID_KEY) || "").trim();
    if (existing) return existing;

    let id = "";
    try {
      if (self.crypto && crypto.randomUUID) id = "dev_" + crypto.randomUUID();
    } catch (e) {}

    if (!id) id = "dev_" + Math.random().toString(16).slice(2) + "_" + Date.now();

    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  }

  // =========================
  // LOCAL USAGE COUNTER (UI-only)
  // =========================
  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function storageKey() {
    return "finch_usage_" + todayKey();
  }

  function getUsed() {
    const n = parseInt(localStorage.getItem(storageKey()) || "0", 10);
    return isFinite(n) ? n : 0;
  }

  function setUsed(n) {
    const safe = isFinite(n) ? n : 0;
    localStorage.setItem(storageKey(), String(Math.max(0, safe)));
  }

  function currentLimit() {
    return isPlusActive() ? PLUS_DAILY_LIMIT : FREE_DAILY_LIMIT;
  }

  function remaining() {
    return Math.max(0, currentLimit() - getUsed());
  }

  function refreshUI() {
    const el = document.getElementById("counterText");
    if (!el) return;

    el.textContent = isPlusActive()
      ? "Finch Plus Active"
      : (remaining() + " uses left today");
  }

  function markUse() {
    setUsed(getUsed() + 1);
    refreshUI();
  }

  function resetToday() {
    setUsed(0);
    refreshUI();
  }

  // =========================
  // STRIPE NAV (single tab)
  // =========================
  function goToStripeSingleTab() {
    if (!STRIPE_URL) return;
    if (stripeNavStarted) return;
    stripeNavStarted = true;
    window.location.href = STRIPE_URL;
  }

  // =========================
  // MODAL HELPERS
  // =========================
  function getModalEls() {
    return {
      overlay: document.getElementById("plusModal"),
      card: document.querySelector("#plusModal .modalCard"),
      email: document.getElementById("plusEmail"),
      cancel: document.getElementById("plusCancelBtn"),
      cont: document.getElementById("plusContinueBtn"),
      deviceMsg: document.getElementById("deviceLimitMsg"),
      manageLink: document.getElementById("manageDevicesLink"),
    };
  }

  function forceModalHidden() {
    const els = getModalEls();
    const overlay = els.overlay;
    if (!overlay) return;

    overlay.hidden = true;
    overlay.setAttribute("hidden", "");
    overlay.style.display = "none";

    document.documentElement.style.overflow = "";
    document.body.style.overflow = "";
  }

  function resetDeviceLimitUI() {
    const els = getModalEls();
    const deviceMsg = els.deviceMsg;
    const manageLink = els.manageLink;

    if (deviceMsg) {
      deviceMsg.style.display = "none";
      deviceMsg.textContent = "";
      deviceMsg.innerHTML = "";
    }

    if (manageLink) {
      manageLink.style.display = "none";
      manageLink.onclick = null;

      if (manageLink.tagName === "A") {
        manageLink.setAttribute("href", "#");
        manageLink.removeAttribute("target");
        manageLink.removeAttribute("rel");
      }
      manageLink.textContent = "Remove your oldest device";
      manageLink.disabled = false;
    }
  }

  function showModal() {
    const els = getModalEls();
    const overlay = els.overlay;
    const email = els.email;
    if (!overlay || !email) return;

    resetDeviceLimitUI();

    overlay.hidden = false;
    overlay.removeAttribute("hidden");
    overlay.style.display = "flex";

    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";

    const saved = getPlusEmail();
    if (saved && !email.value) email.value = saved;

    setTimeout(() => {
      try { email.focus(); } catch (e) {}
    }, 30);
  }

  // =========================
  // PLAN CHECK (server)
  // =========================
  async function checkPlan(email) {
    const e = String(email || "").trim().toLowerCase();
    if (!e) return { plan: "free", status: "none" };

    const deviceId = getOrCreateDeviceId();

    try {
      const resp = await fetch(PLAN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-finch-device": deviceId,
          "x-finch-email": e,
        },
        body: JSON.stringify({ email: e, device_id: deviceId }),
      });

      let data = {};
      try { data = (await resp.json()) || {}; } catch (e2) {}

      if (
        resp.status === 403 &&
        (data.reason === "DEVICE_LIMIT_REACHED" ||
         data.blockReason === "device_limit" ||
         data.allowed === false)
      ) {
        return {
          plan: "plus",
          status: data.status || "active",
          blocked: true,
          blockReason: "device_limit",
          message: data.message || ("You've already used Finch Plus on " + (data.seatsMax || 2) + " devices."),
          seatsUsed: data.seatsUsed,
          seatsMax: data.seatsMax,
        };
      }

      if (!resp.ok) return { plan: "free", status: "unknown" };

      return {
        plan: data.plan === "plus" ? "plus" : "free",
        status: data.status || "none",
        allowed: data.allowed,
      };
    } catch (e3) {
      return { plan: "free", status: "unknown" };
    }
  }

  async function syncPlusFromServer() {
    if (!isPlusActive()) return;

    const email = getPlusEmail();
    if (!email) {
      clearPlusActive();
      return;
    }

    const data = await checkPlan(email);
    if (data.plan !== "plus") clearPlusActive();
    // If device-limited, do NOT clear local badge
  }

  // =========================
  // DEVICE LIMIT UI + IN-MODAL REMOVE OLDEST
  // =========================
  function escapeHtml(s) {
    const str = String(s || "");
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function setDeviceMsg(html) {
    const els = getModalEls();
    const deviceMsg = els.deviceMsg;
    if (!deviceMsg) return;
    deviceMsg.innerHTML = html;
    deviceMsg.style.display = "block";
  }

  function setManageBusy(isBusy) {
    const els = getModalEls();
    const manageLink = els.manageLink;
    if (!manageLink) return;

    if (manageLink.tagName === "BUTTON") manageLink.disabled = !!isBusy;

    manageLink.style.opacity = isBusy ? "0.7" : "";
    manageLink.style.pointerEvents = isBusy ? "none" : "";
  }

  async function removeOldestDevice(emailLower) {
    if (removeBusy) return { ok: false, message: "Please wait…" };
    removeBusy = true;
    setManageBusy(true);

    const deviceId = getOrCreateDeviceId();

    try {
      const resp = await fetch(REMOVE_OLDEST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-finch-device": deviceId,
          "x-finch-email": emailLower,
        },
        body: JSON.stringify({ email: emailLower, device_id: deviceId }),
      });

      let data = {};
      try { data = (await resp.json()) || {}; } catch (e) {}

      if (!resp.ok || !data.ok) {
        const msg =
          data.message ||
          (resp.status === 403 ? "This device can’t manage seats for that email." :
           resp.status === 429 ? "Too many tries. Give it a minute." :
           "Couldn’t remove a device. Try again.");

        return { ok: false, message: msg };
      }

      return { ok: true, message: data.message || "Oldest device removed." };
    } catch (e2) {
      return { ok: false, message: "Network issue. Try again." };
    } finally {
      removeBusy = false;
      setManageBusy(false);
    }
  }

  function showDeviceLimitUI(serverMessage, emailForAction) {
    const els = getModalEls();
    const manageLink = els.manageLink;

    const seatsLine = serverMessage ? String(serverMessage).trim() : "You’ve hit the 2-device limit for this email.";

    setDeviceMsg(
      "<strong>Device limit reached</strong><br>" +
      escapeHtml(seatsLine) + "<br><br>" +
      "To use Finch Plus on this device, remove your oldest device seat.<br>" +
      '<span style="opacity:.85;">This happens instantly here — no new screens.</span>'
    );

    if (!manageLink) return;

    manageLink.textContent = "Remove your oldest device";
    manageLink.style.display = "inline-flex";

    if (manageLink.tagName === "A") {
      manageLink.setAttribute("href", "#");
      manageLink.removeAttribute("target");
      manageLink.removeAttribute("rel");
    }

    manageLink.onclick = async (ev) => {
      if (ev) ev.preventDefault();

      setDeviceMsg("<strong>Device limit reached</strong><br>Removing your oldest device…");

      const res = await removeOldestDevice(emailForAction);

      if (!res.ok) {
        setDeviceMsg("<strong>Device limit reached</strong><br>" + escapeHtml(res.message));
        return;
      }

      setDeviceMsg("<strong>Device limit reached</strong><br>Oldest device removed. Unlocking this device…");

      const data = await checkPlan(emailForAction);

      if (data.plan === "plus" && data.blocked !== true) {
        forceModalHidden();
        setPlusActive(emailForAction);
        return;
      }

      showDeviceLimitUI(data.message || "Still blocked. Try once more.", emailForAction);
    };
  }

  // =========================
  // PLUS BUTTON / MODAL BINDINGS
  // =========================
  async function handlePlusClick(e) {
    if (e) e.preventDefault();
    if (plusClickBusy) return;

    plusClickBusy = true;
    try {
      showModal();
    } finally {
      plusClickBusy = false;
    }
  }

  async function handleContinue() {
    if (continueBusy) return;
    continueBusy = true;

    const els1 = getModalEls();
    const cont = els1.cont;

    if (cont) {
      cont.disabled = true;
      cont.style.opacity = "0.85";
    }

    try {
      const els = getModalEls();
      const emailEl = els.email;

      const val = (emailEl && emailEl.value ? emailEl.value : "").trim().toLowerCase();
      if (!val) return;

      resetDeviceLimitUI();

      const data = await checkPlan(val);

      if (data.blocked === true) {
        showDeviceLimitUI(data.message, val);
        return;
      }

      forceModalHidden();

      if (data.plan === "plus") {
        setPlusActive(val);
        return;
      }

      goToStripeSingleTab();
    } finally {
      continueBusy = false;
      const els2 = getModalEls();
      const c2 = els2.cont;
      if (c2) {
        c2.disabled = false;
        c2.style.opacity = "";
      }
    }
  }

  function bindModalControlsOnce() {
    const els = getModalEls();
    const overlay = els.overlay;
    const card = els.card;
    const cancel = els.cancel;
    const cont = els.cont;

    if (!overlay || !card || !cancel || !cont) return;

    if (overlay.dataset.finchBound === "1") return;
    overlay.dataset.finchBound = "1";

    cancel.addEventListener("click", () => forceModalHidden(), false);
    cont.addEventListener("click", handleContinue, false);

    overlay.addEventListener("click", (e) => {
      if (!card.contains(e.target)) forceModalHidden();
    }, false);

    document.addEventListener("keydown", (e) => {
      const els2 = getModalEls();
      const ov = els2.overlay;
      if (!ov || ov.hidden) return;

      if (e.key === "Escape") forceModalHidden();
      if (e.key === "Enter") {
        e.preventDefault();
        handleContinue();
      }
    });
  }

  function bindPlusButtons() {
    const btns = Array.prototype.slice.call(document.querySelectorAll("#plusBtn"));
    if (!btns.length) return;

    for (let i = 0; i < btns.length; i++) {
      const btn = btns[i];
      if (btn.dataset && btn.dataset.finchBound === "1") continue;
      if (btn.dataset) btn.dataset.finchBound = "1";
      btn.addEventListener("click", handlePlusClick, false);
    }
  }

  // =========================
  // FETCH INTERCEPT
  // 1) Hard block at local cap (UI-only)
  // 2) Auto-attach x-finch-email + x-finch-device on Finch API calls
  // =========================
  const _fetch = window.fetch.bind(window);

  function toHeaders(h) {
    try {
      if (h instanceof Headers) return h;
      return new Headers(h || {});
    } catch (e) {
      return new Headers();
    }
  }

  window.fetch = async function (input, init) {
    if (!init) init = {};

    try {
      const u =
        typeof input === "string"
          ? input
          : (input && input.url ? input.url : "");

      const method =
        (init && init.method) ||
        (typeof input !== "string" && input && input.method) ||
        "GET";

      const M = String(method).toUpperCase();

      // Only touch Finch API calls
      if (u && u.indexOf(API_URL) === 0) {
        const deviceId = getOrCreateDeviceId();
        const email = getPlusEmail();

        const baseHeaders =
          init.headers ||
          (typeof input !== "string" && input ? input.headers : undefined);

        const headers = toHeaders(baseHeaders);

        headers.set("x-finch-device", deviceId);
        if (email) headers.set("x-finch-email", email);

        init = Object.assign({}, init, { headers: headers });

        // Hard block only for POST (actual “use” call)
        if (M === "POST") {
          refreshUI();

          if (remaining() <= 0) {
            return new Response(
              JSON.stringify({
                error: "cap_reached",
                message: "Daily limit reached. You've used all " + currentLimit() + " runs for today.",
                subscribe_url: STRIPE_URL,
                plan: isPlusActive() ? "plus" : "free",
                cap: currentLimit(),
                remaining_today: 0,
              }),
              { status: 429, headers: { "Content-Type": "application/json" } }
            );
          }
        }
      }
    } catch (e) {
      // fail-open
    }

    return _fetch(input, init);
  };

  // =========================
  // INIT
  // =========================
  function init() {
    refreshUI();
    forceModalHidden();
    bindModalControlsOnce();
    bindPlusButtons();
    syncPlusFromServer();
  }

  window.FinchPaywall = {
    init: init,
    markUse: markUse,
    resetToday: resetToday,
    refreshUI: refreshUI,
    remaining: remaining,
    clearPlus: clearPlusActive,
    syncPlusFromServer: syncPlusFromServer,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
