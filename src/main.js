// RegionShare main process.
// The app captures one rectangle of a display and shows it live in a normal window.
// You then share that window in Teams (or any other app that can share a window).
const {
  app, BrowserWindow, Tray, Menu, screen, desktopCapturer, session,
  ipcMain, nativeImage, systemPreferences, dialog, shell, globalShortcut,
} = require('electron');
const path = require('path');

// Keep the mirror window live when other windows cover it.
// Without these switches, Chromium stops the paint of hidden windows.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const PRELOAD = path.join(__dirname, 'preload.js');
const BORDER_PX = 3;
const SHORTCUT = 'CommandOrControl+Shift+2';

let tray = null;
let mirrorWin = null;
let borderWin = null;
let selectorWins = [];
let showBorder = true;
// The region in DIP (device-independent pixels), relative to the top-left of its display.
let region = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function displayById(id) {
  return screen.getAllDisplays().find((d) => d.id === id) || screen.getPrimaryDisplay();
}

// The data that the mirror page needs to crop the display stream.
function regionPayload() {
  const d = displayById(region.displayId);
  return {
    displayId: d.id,
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    displayWidth: d.bounds.width,
    displayHeight: d.bounds.height,
    scaleFactor: d.scaleFactor,
  };
}

// The region in absolute screen coordinates (DIP).
function absoluteRegion() {
  const d = displayById(region.displayId);
  return {
    x: d.bounds.x + region.x,
    y: d.bounds.y + region.y,
    width: region.width,
    height: region.height,
  };
}

// ---------- Selection ----------

function closeSelectors() {
  for (const w of selectorWins) if (!w.isDestroyed()) w.close();
  selectorWins = [];
}

function startSelection() {
  closeSelectors();
  if (borderWin && !borderWin.isDestroyed()) borderWin.hide();
  for (const d of screen.getAllDisplays()) {
    const w = new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: { preload: PRELOAD },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // macOS moves a window below the menu bar. Set the bounds again after the window level changes.
    w.setBounds(d.bounds);
    w.loadFile(path.join(__dirname, 'selector.html'), { query: { displayId: String(d.id) } });
    w.once('ready-to-show', () => {
      w.show();
      w.focus();
    });
    selectorWins.push(w);
  }
}

ipcMain.on('selection:done', (_e, sel) => {
  closeSelectors();
  setRegion({
    displayId: Number(sel.displayId),
    x: Math.round(sel.x),
    y: Math.round(sel.y),
    width: Math.round(sel.width),
    height: Math.round(sel.height),
  });
});

ipcMain.on('selection:cancel', () => {
  closeSelectors();
  if (region) updateBorder();
});

// ---------- Region, mirror window, and border ----------

function setRegion(r) {
  region = r;
  updateBorder();
  if (mirrorWin && !mirrorWin.isDestroyed()) {
    mirrorWin.setAspectRatio(region.width / region.height);
    const [w] = mirrorWin.getContentSize();
    mirrorWin.setContentSize(w, Math.round((w * region.height) / region.width));
    mirrorWin.webContents.send('region:update', regionPayload());
  } else {
    openMirror();
  }
  updateMenu();
}

// Find a size for the mirror window. Keep the aspect ratio of the region.
function mirrorSize(maxW, maxH) {
  let w = Math.min(region.width, maxW);
  let h = Math.round((w * region.height) / region.width);
  if (h > maxH) {
    h = maxH;
    w = Math.round((h * region.width) / region.height);
  }
  return { width: Math.max(160, w), height: Math.max(90, h) };
}

// Put the mirror window outside the region. If the window is inside the region,
// the capture shows a mirror inside a mirror.
function mirrorBounds() {
  const regionDisplay = displayById(region.displayId);
  const other = screen.getAllDisplays().find((d) => d.id !== regionDisplay.id);
  if (other) {
    const wa = other.workArea;
    const size = mirrorSize(wa.width * 0.6, wa.height * 0.6);
    return {
      x: Math.round(wa.x + (wa.width - size.width) / 2),
      y: Math.round(wa.y + (wa.height - size.height) / 2),
      ...size,
    };
  }
  const wa = regionDisplay.workArea;
  const r = absoluteRegion();
  const gap = 16;
  const room = {
    right: wa.x + wa.width - (r.x + r.width) - gap * 2,
    left: r.x - wa.x - gap * 2,
    below: wa.y + wa.height - (r.y + r.height) - gap * 2,
    above: r.y - wa.y - gap * 2,
  };
  const side = Object.keys(room).sort((a, b) => room[b] - room[a])[0];
  const horizontal = side === 'right' || side === 'left';
  const size = horizontal
    ? mirrorSize(Math.max(160, room[side]), wa.height * 0.8)
    : mirrorSize(wa.width * 0.8, Math.max(90, room[side]));
  const pos = {
    right: { x: r.x + r.width + gap, y: r.y },
    left: { x: r.x - gap - size.width, y: r.y },
    below: { x: r.x, y: r.y + r.height + gap },
    above: { x: r.x, y: r.y - gap - size.height },
  }[side];
  // Keep the window on the display.
  pos.x = Math.min(Math.max(pos.x, wa.x), wa.x + wa.width - size.width);
  pos.y = Math.min(Math.max(pos.y, wa.y), wa.y + wa.height - size.height);
  return { ...pos, ...size };
}

function openMirror() {
  const b = mirrorBounds();
  mirrorWin = new BrowserWindow({
    ...b,
    useContentSize: true,
    title: 'RegionShare – Shared Region',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, backgroundThrottling: false },
  });
  mirrorWin.setAspectRatio(region.width / region.height);
  mirrorWin.loadFile(path.join(__dirname, 'mirror.html'));
  mirrorWin.webContents.once('did-finish-load', () => {
    mirrorWin.webContents.send('region:update', regionPayload());
  });
  if (process.env.REGIONSHARE_DEBUG) {
    // Print the capture statistics every two seconds, for tests.
    const timer = setInterval(async () => {
      if (!mirrorWin || mirrorWin.isDestroyed()) return clearInterval(timer);
      const stats = await mirrorWin.webContents.executeJavaScript('window.__regionShareStats && window.__regionShareStats()');
      console.log('[debug] mirror', JSON.stringify(stats), 'bounds', JSON.stringify(mirrorWin.getBounds()));
    }, 2000);
  }
  mirrorWin.on('closed', () => {
    mirrorWin = null;
    stopSharing();
  });
}

function updateBorder() {
  if (!region || !showBorder) {
    if (borderWin && !borderWin.isDestroyed()) borderWin.hide();
    return;
  }
  const r = absoluteRegion();
  // The border window is a little larger than the region.
  // The border lines are outside the region, so the capture does not show them.
  const bounds = {
    x: r.x - BORDER_PX,
    y: r.y - BORDER_PX,
    width: r.width + BORDER_PX * 2,
    height: r.height + BORDER_PX * 2,
  };
  if (!borderWin || borderWin.isDestroyed()) {
    borderWin = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: { preload: PRELOAD },
    });
    borderWin.setAlwaysOnTop(true, 'floating');
    borderWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    borderWin.setIgnoreMouseEvents(true);
    // Ask the system to keep the border out of all screen captures.
    borderWin.setContentProtection(true);
    borderWin.loadFile(path.join(__dirname, 'border.html'), { query: { px: String(BORDER_PX) } });
    borderWin.once('ready-to-show', () => borderWin.showInactive());
  } else {
    borderWin.setBounds(bounds);
    borderWin.showInactive();
  }
}

function stopSharing() {
  region = null;
  if (borderWin && !borderWin.isDestroyed()) borderWin.close();
  borderWin = null;
  if (mirrorWin && !mirrorWin.isDestroyed()) mirrorWin.close();
  mirrorWin = null;
  updateMenu();
}

// ---------- Screen capture ----------

function setupCapture() {
  // The mirror page calls getDisplayMedia(). This handler gives it the display
  // that holds the region, and the user does not see a picker.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      const id = region ? String(region.displayId) : String(screen.getPrimaryDisplay().id);
      const src = sources.find((s) => s.display_id === id) || sources[0];
      if (!src) {
        callback({});
        return;
      }
      callback({ video: src });
    } catch (err) {
      console.error('Screen capture failed:', err);
      callback({});
    }
  }, { useSystemPicker: false });
}

async function checkMacPermission() {
  if (process.platform !== 'darwin') return;
  if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return;
  // Ask for a capture one time. macOS adds the app to the list in System Settings
  // only after the app asks for a capture.
  try {
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  } catch (err) {
    console.error('The permission request failed:', err);
  }
  if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return;
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: 'RegionShare needs the Screen Recording permission.',
    detail:
      'Open System Settings > Privacy & Security > Screen & System Audio Recording. ' +
      'Turn on RegionShare (or "Electron" when you run from source). Then quit and open the app again.',
    buttons: ['Open System Settings', 'Later'],
  });
  if (response === 0) {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
}

// ---------- Tray ----------

function trayImage() {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray-win.png';
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', file));
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

function updateMenu() {
  if (!tray) return;
  const sharing = !!region;
  const shortcutLabel = process.platform === 'darwin' ? '⌘⇧2' : 'Ctrl+Shift+2';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: sharing ? `Select a New Region… (${shortcutLabel})` : `Select Region… (${shortcutLabel})`, click: startSelection },
    {
      label: 'Show Shared Window',
      enabled: sharing,
      click: () => { if (mirrorWin) { mirrorWin.show(); mirrorWin.focus(); } },
    },
    {
      label: 'Show Border Around Region',
      type: 'checkbox',
      checked: showBorder,
      click: (item) => { showBorder = item.checked; updateBorder(); },
    },
    { label: 'Stop Sharing', enabled: sharing, click: stopSharing },
    { type: 'separator' },
    { label: 'Quit RegionShare', role: 'quit' },
  ]));
  tray.setToolTip(sharing ? `RegionShare – ${region.width}×${region.height}` : 'RegionShare');
}

// ---------- Start ----------

// For tests: --region=x,y,width,height selects a region on the primary display at start.
function regionFromArgs() {
  const arg = process.argv.find((a) => a.startsWith('--region='));
  if (!arg) return null;
  const [x, y, width, height] = arg.slice('--region='.length).split(',').map(Number);
  if ([x, y, width, height].some((n) => !Number.isFinite(n)) || width < 20 || height < 20) return null;
  return { displayId: screen.getPrimaryDisplay().id, x, y, width, height };
}

app.whenReady().then(async () => {
  setupCapture();
  tray = new Tray(trayImage());
  updateMenu();
  globalShortcut.register(SHORTCUT, startSelection);
  // Stop when the display with the region goes away.
  screen.on('display-removed', () => {
    if (region && !screen.getAllDisplays().some((d) => d.id === region.displayId)) stopSharing();
  });
  await checkMacPermission();
  const fromArgs = regionFromArgs();
  if (fromArgs) setRegion(fromArgs);
  else startSelection();
});

app.on('second-instance', startSelection);

// Keep the app in the tray when all windows close.
app.on('window-all-closed', () => {});

app.on('will-quit', () => globalShortcut.unregisterAll());
