const installAction = document.querySelector('#installAction');
const statusPanel = document.querySelector('#statusPanel');
const statusTitle = document.querySelector('#statusTitle');
const statusCopy = document.querySelector('#statusCopy');
const installedPanel = document.querySelector('#installedPanel');
const installSheet = document.querySelector('#installSheet');
const closeSheet = document.querySelector('#closeSheet');
const sheetEyebrow = document.querySelector('#sheetEyebrow');
const sheetTitle = document.querySelector('#sheetTitle');
const stepOne = document.querySelector('#stepOne');
const stepTwo = document.querySelector('#stepTwo');
const stepThree = document.querySelector('#stepThree');
const installParams = new URLSearchParams(window.location.search);
const shouldOpenInstallGuide =
  installParams.get('source') === 'circle' || installParams.get('install') === '1';

const ua = window.navigator.userAgent;
const platform = window.navigator.platform || '';
const vendor = window.navigator.vendor || '';
const isAppleTouchDevice =
  /iphone|ipad|ipod/i.test(ua) ||
  /iphone|ipad|ipod/i.test(platform) ||
  (platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
const isIOS = isAppleTouchDevice;
const isSafari =
  /Apple/i.test(vendor) &&
  /safari/i.test(ua) &&
  !/crios|fxios|edgios|opios|mercury/i.test(ua);
const isAndroid = /android/i.test(ua);
const isDesktopSafari = isSafari && !isIOS;
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  window.navigator.standalone === true ||
  document.referrer.startsWith('android-app://');

let deferredPrompt = null;

function setStatus(title, copy, tone = 'default') {
  statusTitle.textContent = title;
  statusCopy.textContent = copy;
  statusPanel.classList.toggle('isReady', tone === 'ready');
  statusPanel.classList.toggle('isWarning', tone === 'warning');
}

function setSheet(kind) {
  if (kind === 'mac') {
    sheetEyebrow.textContent = 'Mac install';
    sheetTitle.textContent = 'Add Finch to the Dock';
    stepOne.textContent = 'Open this page in Safari on your Mac.';
    stepTwo.textContent = 'Use File > Add to Dock from the Safari menu bar.';
    stepThree.textContent = 'Click Add. Then launch Finch from the Dock or Applications.';
    return;
  }

  if (kind === 'android') {
    sheetEyebrow.textContent = 'Android install';
    sheetTitle.textContent = 'Install Finch';
    stepOne.textContent = 'Tap the browser menu or the install prompt when it appears.';
    stepTwo.textContent = 'Choose Install app or Add to Home screen.';
    stepThree.textContent = 'Tap Install. Then launch Finch from the new app icon.';
    return;
  }

  if (kind === 'desktop') {
    sheetEyebrow.textContent = 'Desktop install';
    sheetTitle.textContent = 'Install Finch';
    stepOne.textContent = 'Use the install icon in the address bar, or open the browser app menu.';
    stepTwo.textContent = 'Choose Install Finch, Install this site as an app, or Add to Dock.';
    stepThree.textContent = 'Open Finch from the new app icon. It will launch the app shell.';
    return;
  }

  sheetEyebrow.textContent = 'iPhone install';
  sheetTitle.textContent = 'Add Finch to Home Screen';
  stepOne.textContent = "Tap Safari's Share button at the bottom of the screen.";
  stepTwo.textContent = 'Choose Add to Home Screen.';
  stepThree.textContent = 'Tap Add. Then launch Finch from the new Home Screen icon.';
}

function showDeviceGuide() {
  if (!installSheet?.showModal || isStandalone) return;

  if (isIOS) {
    setSheet('iphone');
  } else if (isDesktopSafari) {
    setSheet('mac');
  } else if (isAndroid) {
    setSheet('android');
  } else {
    setSheet('desktop');
  }

  installSheet.showModal();
}

if (isStandalone) {
  installedPanel.hidden = false;
  installAction.textContent = 'Continue to Finch';
  setStatus('Finch is installed', 'You are already running Finch as an installed app.', 'ready');
} else if (isIOS && isSafari) {
  installAction.textContent = 'Show iPhone install steps';
  setStatus('iPhone Safari detected', 'This is the right place to install Finch. Tap below and Finch will show exactly where to add it to the Home Screen.', 'ready');
} else if (isIOS) {
  installAction.textContent = 'Open this page in Safari';
  setStatus('Open in Safari', 'iPhone only allows Home Screen installs from Safari. Copy or reopen this page in Safari, then add Finch.', 'warning');
} else if (isDesktopSafari) {
  installAction.textContent = 'Show Mac install steps';
  setStatus('Mac Safari detected', 'This is the desktop install path. Add Finch to the Dock, then open it from the Finch icon.', 'ready');
} else {
  installAction.textContent = 'Install Finch';
  setStatus('Ready to install', 'Tap install. If this browser supports web app installation, Finch will open its native installer.');
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredPrompt = event;
  installAction.textContent = 'Install Finch';
  setStatus('Installer ready', 'Your browser is ready to install Finch.', 'ready');
});

installAction?.addEventListener('click', async () => {
  if (isStandalone) {
    window.location.href = '/app?source=pwa';
    return;
  }

  if (isIOS && isSafari) {
    setSheet('iphone');
    installSheet?.showModal();
    return;
  }

  if (isIOS) {
    setStatus('Open in Safari', 'Use Safari for the Finch Home Screen install. Then tap Share and choose Add to Home Screen.', 'warning');
    return;
  }

  if (isDesktopSafari) {
    setSheet('mac');
    installSheet?.showModal();
    return;
  }

  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installAction.textContent = 'Install requested';
    setStatus('Install requested', 'If Finch was added, leave this browser tab and open Finch from the new icon.', 'ready');
    return;
  }

  if (installSheet?.showModal) {
    if (isAndroid) {
      setSheet('android');
    } else {
      setSheet('desktop');
    }
    installSheet.showModal();
    return;
  }

  statusCopy.textContent = 'Tap Share, choose Add to Home Screen, then tap Add.';
});

closeSheet?.addEventListener('click', () => {
  installSheet?.close();
});

installSheet?.addEventListener('click', (event) => {
  if (event.target === installSheet) {
    installSheet.close();
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

if (shouldOpenInstallGuide) {
  window.setTimeout(showDeviceGuide, 250);
}
