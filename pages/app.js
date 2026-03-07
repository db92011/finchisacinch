/* app.js — Finch app logic (UI -> API -> output)
   - Calls Finch API
   - Updates output + char counter
   - Calls FinchPaywall.markUse() ONLY after real output is shown
   - Handles Copy + Clear
   - Stores user name only if they type it (no defaults)
   - Avoids newer JS syntax that breaks older Android WebViews
*/

(() => {
  if (window.__FINCH_APP_LOADED__ === true) return;
  window.__FINCH_APP_LOADED__ = true;

  console.log("APPJS RUNNING v77785 — " + new Date().toISOString());

  const API_URL = "https://finch-api.txxqryxhg6.workers.dev/api/finch";
  const NAME_KEY = "finch_owner_name";

  const $ = (id) => document.getElementById(id);

  const elName    = $("ownerName");
  const elTone    = $("tone");
  const elMode    = $("mode");
  const elOutlang = $("outlang");
  const elPaste   = $("paste");
  const elContext = $("context");

  const elAction  = $("actionBtn");
  const elClear   = $("clearBtn");
  const elCopy    = $("copyBtn");

  const elResult  = $("result");
  const elCount   = $("charCount");
  const elStatus  = $("status");

  const safeTrim = (s) => String(s || "").trim();

  function setStatus(msg) {
    if (elStatus) elStatus.textContent = msg || "";
  }

  function setCount() {
    if (elCount && elResult) {
      elCount.textContent = String((elResult.value || "").length);
    }
  }

  function setWorking(isWorking) {
    if (!elAction) return;
    elAction.disabled = !!isWorking;
    elAction.textContent = isWorking ? "Working…" : "Let’s do this";
  }

  function saveNameIfUserTyped() {
    if (!elName) return;
    const v = safeTrim(elName.value);
    if (v) localStorage.setItem(NAME_KEY, v);
    else localStorage.removeItem(NAME_KEY);
  }

  function loadNameIfExists() {
    if (!elName) return;
    const saved = safeTrim(localStorage.getItem(NAME_KEY));
    if (saved) elName.value = saved;
  }

  function extractOutput(data) {
    if (!data) return "";
    if (typeof data === "string") return data.trim();

    const candidates = [
      data.output,
      data.result,
      data.text,
      data.response,
      data.message,
      data.data && data.data.output,
    ];

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (typeof c === "string" && c.trim()) return c.trim();
    }
    return "";
  }

  async function callFinch(payload) {
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const ct = (resp.headers.get("content-type") || "").toLowerCase();

    // If server didn’t return JSON, we still want a useful error object.
    if (!ct.includes("application/json")) {
      let text = "";
      try { text = await resp.text(); } catch (e) {}
      return { ok: resp.ok, status: resp.status, data: null, text };
    }

    let json = null;
    try { json = await resp.json(); } catch (e) {}
    return { ok: resp.ok, status: resp.status, data: json, text: "" };
  }

  // Canonical copy source (prevents iOS mailto encoding bleed)
  let lastOutputText = "";

  async function onRun() {
    const paste = safeTrim(elPaste && elPaste.value);
    if (!paste) {
      setStatus("Add a message first.");
      return;
    }

    setWorking(true);
    setStatus("");

    try {
      const toneVal = elTone ? elTone.value : "friendly";
      const modeVal = elMode ? elMode.value : "reply";
      const outlangVal = elOutlang ? elOutlang.value : "auto";

      const payload = {
        input: paste,
        context: safeTrim(elContext && elContext.value),
        tone: toneVal || "friendly",
        mode: modeVal || "reply",
        outlang: outlangVal || "auto",
        signature: safeTrim(elName && elName.value),
      };

      const res = await callFinch(payload);
      const ok = !!res.ok;
      const status = res.status;
      const data = res.data;

      // IMPORTANT:
      // paywall.js returns a local 429 JSON when cap is hit.
      // worker can also return 429 when cap is hit server-side.
      if (!ok) {
        const serverMsg =
          (data && (data.message || data.error || data.detail)) ||
          (res.text || "");

        if (status === 429) {
          setStatus(serverMsg || "Daily limit reached. You’re out of uses for today.");
          return;
        }

        if (status === 403) {
          setStatus(serverMsg || "Access blocked.");
          return;
        }

        setStatus(serverMsg || ("Something went wrong. (Status " + (status || "?") + ")"));
        return;
      }

      if (!data) {
        setStatus("Something went wrong.");
        return;
      }

      const out = extractOutput(data);
      if (!out) {
        setStatus("This reply needs info. Add it to the Context box to finish.");
        if (elContext) elContext.focus();
        return;
      }

      lastOutputText = out;
      if (elResult) elResult.value = out;
      setCount();
      setStatus("Done.");

      if (window.FinchPaywall && typeof window.FinchPaywall.markUse === "function") {
        window.FinchPaywall.markUse();
      }

      saveNameIfUserTyped();
    } catch (e) {
      setStatus("Network error.");
    } finally {
      setWorking(false);
    }
  }

  async function onCopy() {
    if (!lastOutputText) return;

    const btn = document.getElementById("copyBtn");

    function animate() {
      if (!btn) return;
      btn.classList.add("copied");
      setTimeout(() => btn.classList.remove("copied"), 700);
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(lastOutputText);
      } else {
        throw new Error("clipboard-unavailable");
      }
      setStatus("Copied.");
      animate();
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = lastOutputText;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setStatus("Copied.");
      animate();
    }
  }

  function onClear() {
    if (elPaste) elPaste.value = "";
    if (elContext) elContext.value = "";
    if (elResult) elResult.value = "";
    lastOutputText = "";
    setCount();
    setStatus("");
  }

  function init() {
    loadNameIfExists();
    setCount();

    if (elAction) elAction.addEventListener("click", onRun);
    if (elCopy) elCopy.addEventListener("click", onCopy);
    if (elClear) elClear.addEventListener("click", onClear);
    if (elResult) elResult.addEventListener("input", setCount);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();