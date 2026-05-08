(() => {
  const y = document.getElementById("year");
  if (y) y.textContent = String(new Date().getFullYear());

  const installButtons = document.querySelectorAll("[data-install-action]");
  const installStatus = document.querySelector("[data-install-status]");
  const ua = window.navigator.userAgent || "";
  const platform = window.navigator.platform || "";
  const vendor = window.navigator.vendor || "";
  const isAppleTouch =
    /iphone|ipad|ipod/i.test(ua) ||
    /iphone|ipad|ipod/i.test(platform) ||
    (platform === "MacIntel" && window.navigator.maxTouchPoints > 1);
  const isSafari =
    /Apple/i.test(vendor) &&
    /safari/i.test(ua) &&
    !/crios|fxios|edgios|opios|mercury/i.test(ua);
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true ||
    document.referrer.startsWith("android-app://");
  let deferredPrompt = null;

  function setInstallStatus(copy) {
    if (installStatus) installStatus.textContent = copy;
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    setInstallStatus("Ready to install. Use the Install Finch button and the saved icon will open the app.");
  });

  for (const button of installButtons) {
    button.addEventListener("click", async () => {
      if (isStandalone) {
        window.location.href = "/app?source=pwa";
        return;
      }

      if (deferredPrompt) {
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        setInstallStatus("Install requested. Open Finch from the new app icon when it appears.");
        return;
      }

      if (isAppleTouch && isSafari) {
        setInstallStatus("Tap Share, choose Add to Home Screen, then tap Add. Open Finch from the new icon.");
        return;
      }

      setInstallStatus("Use the browser install control here. Chrome and Edge may show Install app in the address bar or menu; Safari uses Add to Dock.");
    });
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
})();
