// RegionShare main process.
// The app captures one rectangle of a display and shows it live in a normal window.
// You then share that window in Teams (or any other app that can share a window).
const {
  app, BrowserWindow, Tray, Menu, screen, desktopCapturer, session, webContents,
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
const LABEL_PX = 22; // the space above the region for the zoom label
const IS_MAC = process.platform === 'darwin';
const SHORTCUTS = {
  select: 'CommandOrControl+Shift+2',
  zoomIn: 'CommandOrControl+Alt+=',
  zoomOut: 'CommandOrControl+Alt+-',
  zoomReset: 'CommandOrControl+Alt+0',
};
const SHORTCUT_LABELS = IS_MAC
  ? { select: '⌘⇧2', zoomIn: '⌘⌥=', zoomOut: '⌘⌥-', zoomReset: '⌘⌥0' }
  : { select: 'Ctrl+Shift+2', zoomIn: 'Ctrl+Alt+=', zoomOut: 'Ctrl+Alt+-', zoomReset: 'Ctrl+Alt+0' };

// Self-test of the minimize behavior. See runSelfTest().
const SELFTEST = process.env.REGIONSHARE_SELFTEST || '';

let tray = null;
let mirrorWin = null;
let borderWin = null;
let selectorWins = [];
let showBorder = true;
let zoomLevel = 1;
// The region in DIP (device-independent pixels), relative to the top-left of its display.
let region = null;
// The bounds of the mirror window before the app moved it off the screen.
let parkedBounds = null;
let parkBusy = false;

// A self-test uses its own data folder, so it can run next to a normal copy of the app.
if (SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), 'regionshare-selftest'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function displayById(id) {
  return screen.getAllDisplays().find((d) => d.id === id) || screen.getPrimaryDisplay();
}

function liveMirror() {
  return mirrorWin && !mirrorWin.isDestroyed() ? mirrorWin : null;
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
  zoomLevel = 1;
  updateDock();
  updateBorder();
  const win = liveMirror();
  if (win) {
    win.setAspectRatio(region.width / region.height);
    if (!parkedBounds) {
      const [w] = win.getContentSize();
      win.setContentSize(w, Math.round((w * region.height) / region.width));
    }
    win.webContents.send('region:update', regionPayload());
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
  parkedBounds = null;
  mirrorWin = new BrowserWindow({
    ...b,
    useContentSize: true,
    title: 'RegionShare – Shared Region',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    // macOS: let the app put the window fully off the screen. See parkMirror().
    enableLargerThanScreen: true,
    webPreferences: { preload: PRELOAD, backgroundThrottling: false },
  });
  const win = mirrorWin;
  win.setAspectRatio(region.width / region.height);
  win.loadFile(path.join(__dirname, 'mirror.html'), { query: { selftest: SELFTEST ? '1' : '' } });
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('region:update', regionPayload());
  });
  if (process.env.REGIONSHARE_DEBUG) {
    // Print the capture statistics every two seconds, for tests.
    const timer = setInterval(async () => {
      if (win.isDestroyed()) return clearInterval(timer);
      const stats = await win.webContents.executeJavaScript('window.__regionShareStats && window.__regionShareStats()');
      console.log('[debug] mirror', JSON.stringify(stats), 'bounds', JSON.stringify(win.getBounds()));
    }, 2000);
  }
  // A minimized window does not draw, so a window share in Teams stops.
  // When the user minimizes the window, restore it and move it off the screen.
  win.on('minimize', () => {
    if (SELFTEST === 'nopark') return;
    parkMirror();
  });
  // A click on the taskbar button or the Dock icon brings the window back.
  win.on('focus', () => {
    if (parkedBounds && !parkBusy) unparkMirror();
  });
  win.on('closed', () => {
    if (mirrorWin === win) {
      mirrorWin = null;
      stopSharing();
    }
  });
}

// The union of all displays, in DIP.
function desktopBounds() {
  const all = screen.getAllDisplays().map((d) => d.bounds);
  const left = Math.min(...all.map((b) => b.x));
  const top = Math.min(...all.map((b) => b.y));
  const right = Math.max(...all.map((b) => b.x + b.width));
  const bottom = Math.max(...all.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function parkMirror() {
  const win = liveMirror();
  if (!win) return;
  parkBusy = true;
  if (win.isMinimized()) win.restore();
  if (!parkedBounds) parkedBounds = win.getBounds();
  const desk = desktopBounds();
  // Put the window below and to the right of all displays. The size stays the same,
  // so the share keeps the same resolution. Windows lets the window go fully off the screen.
  // macOS keeps a small part of the title bar (about 40 x 32 px) in the bottom-right corner.
  // A click on that part brings the window back (see the "focus" event).
  // Do not make the window transparent: at opacity 0 the share freezes, and at low opacity
  // the share is dark.
  const spot = {
    x: desk.x + desk.width + 200,
    y: desk.y + desk.height + 200,
    width: parkedBounds.width,
    height: parkedBounds.height,
  };
  const place = () => {
    if (!win.isDestroyed() && parkedBounds) win.setBounds(spot);
  };
  place();
  win.blur();
  // The restore animation can move the window back after the first move. Move it again.
  for (const ms of [250, 600, 1200]) setTimeout(place, ms);
  setTimeout(() => { parkBusy = false; }, 1500);
  updateMenu();
  if (process.env.REGIONSHARE_DEBUG) console.log('[debug] parked at', JSON.stringify(win.getBounds()));
}

function unparkMirror() {
  const win = liveMirror();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (parkedBounds) {
    win.setBounds(parkedBounds);
    parkedBounds = null;
  }
  win.show();
  win.focus();
  updateMenu();
}

function borderBounds() {
  const r = absoluteRegion();
  // The border window is a little larger than the region.
  // The border lines and the zoom label are outside the region, so the capture does not show them.
  return {
    x: r.x - BORDER_PX,
    y: r.y - BORDER_PX - LABEL_PX,
    width: r.width + BORDER_PX * 2,
    height: r.height + BORDER_PX * 2 + LABEL_PX,
  };
}

function sendBorderZoom() {
  if (borderWin && !borderWin.isDestroyed()) borderWin.webContents.send('zoom:level', zoomLevel);
}

function updateBorder() {
  if (!region || !showBorder) {
    if (borderWin && !borderWin.isDestroyed()) borderWin.hide();
    return;
  }
  const bounds = borderBounds();
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
    borderWin.loadFile(path.join(__dirname, 'border.html'), {
      query: { px: String(BORDER_PX), label: String(LABEL_PX) },
    });
    borderWin.once('ready-to-show', () => {
      borderWin.showInactive();
      sendBorderZoom();
    });
  } else {
    borderWin.setBounds(bounds);
    borderWin.showInactive();
    sendBorderZoom();
  }
}

function stopSharing() {
  region = null;
  zoomLevel = 1;
  updateDock();
  parkedBounds = null;
  if (borderWin && !borderWin.isDestroyed()) borderWin.close();
  borderWin = null;
  const win = liveMirror();
  mirrorWin = null;
  if (win) win.close();
  updateMenu();
}

// ---------- Zoom ----------

// Send a zoom command to the mirror page. When the mouse cursor is in the region,
// the zoom keeps the point under the cursor in the same place.
function zoom(action) {
  const win = liveMirror();
  if (!win || !region) return;
  const r = absoluteRegion();
  const c = screen.getCursorScreenPoint();
  const inside = c.x >= r.x && c.x < r.x + r.width && c.y >= r.y && c.y < r.y + r.height;
  win.webContents.send('zoom:command', {
    action,
    point: inside ? { x: c.x - r.x, y: c.y - r.y } : null,
  });
}

ipcMain.on('zoom:changed', (_e, level) => {
  zoomLevel = level;
  sendBorderZoom();
  updateMenu();
});

// ---------- Screen capture ----------

let selfTestWin = null;

function setupCapture() {
  // The mirror page calls getDisplayMedia(). This handler gives it the display
  // that holds the region, and the user does not see a picker.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      // The self-test page captures the mirror window, as Teams does.
      const from = request.frame ? webContents.fromFrame(request.frame) : null;
      if (selfTestWin && from && from === selfTestWin.webContents && liveMirror()) {
        callback({ video: { id: mirrorWin.getMediaSourceId(), name: mirrorWin.getTitle() } });
        return;
      }
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
  if (!IS_MAC) return;
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
      'Turn on RegionShare. Then quit and open the app again.',
    buttons: ['Open System Settings', 'Later'],
  });
  if (response === 0) {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
}

// ---------- Self-test ----------

// REGIONSHARE_SELFTEST=park or =nopark, with --region=... and REGIONSHARE_DEBUG=1.
// A hidden page captures the mirror window, as Teams does, and counts the frames.
// The test minimizes the mirror window and prints the frames for each second.
// With "nopark", the app does not move the window, so the test shows the old behavior.
function runZoomTest() {
  const stats = () => mirrorWin.webContents.executeJavaScript('window.__regionShareStats()');
  const steps = [['in'], ['in'], ['in'], ['out'], ['reset']];
  let t = 3000;
  for (const [action] of steps) {
    setTimeout(() => zoom(action), t);
    setTimeout(async () => console.log(`[selftest] after zoom ${action}:`, JSON.stringify(await stats()), 'level', zoomLevel), t + 800);
    t += 1200;
  }
  setTimeout(() => app.exit(0), t + 500);
}

function runSelfTest() {
  if (SELFTEST === 'zoom') return runZoomTest();
  const counts = [];
  const bright = [];
  ipcMain.on('selftest:frames', (_e, n, b) => { counts.push(n); bright.push(b); });
  setTimeout(() => {
    selfTestWin = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      webPreferences: { preload: PRELOAD, backgroundThrottling: false },
    });
    selfTestWin.loadFile(path.join(__dirname, 'selftest.html'));
  }, 3000);
  setTimeout(() => {
    console.log('[selftest] minimize the mirror window');
    if (liveMirror()) mirrorWin.minimize();
  }, 9000);
  setTimeout(() => {
    console.log('[selftest] frames per second, before and after the minimize:', JSON.stringify(counts));
    const after = counts.slice(-5);
    // The test pixels are bright green or magenta. A dark image means that the capture lost the content.
    const ok = after.length >= 5 && after.every((n) => n > 5) && bright.slice(-5).every((b) => b > 100);
    console.log('[selftest] brightness of the test pixels:', JSON.stringify(bright));
    const bounds = liveMirror() ? JSON.stringify(mirrorWin.getBounds()) : 'none';
    const result = `mode=${SELFTEST} result=${ok ? 'LIVE' : 'FROZEN'} bounds=${bounds}`;
    console.log(`[selftest] ${result}`);
    // Windows does not show console output for an app, so also show the result in a dialog.
    dialog.showMessageBoxSync({
      type: ok ? 'info' : 'warning',
      message: `RegionShare self-test: ${ok ? 'LIVE' : 'FROZEN'}`,
      detail: `${result}\nFrames per second: ${JSON.stringify(counts)}`,
    });
    app.exit(0);
  }, 17000);
}

// ---------- Tray ----------

function trayImage() {
  const file = IS_MAC ? 'trayTemplate.png' : 'tray-win.png';
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', file));
  if (IS_MAC) img.setTemplateImage(true);
  return img;
}

function updateMenu() {
  if (!tray) return;
  const sharing = !!region;
  const L = SHORTCUT_LABELS;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${sharing ? 'Select a New Region…' : 'Select Region…'} (${L.select})`, click: startSelection },
    {
      label: parkedBounds ? 'Show Shared Window (now hidden)' : 'Show Shared Window',
      enabled: sharing,
      click: unparkMirror,
    },
    { label: 'Hide Shared Window (keeps the share live)', enabled: sharing && !parkedBounds, click: parkMirror },
    { type: 'separator' },
    { label: `Zoom In (${L.zoomIn})`, enabled: sharing, click: () => zoom('in') },
    { label: `Zoom Out (${L.zoomOut})`, enabled: sharing && zoomLevel > 1, click: () => zoom('out') },
    { label: `Reset Zoom (${L.zoomReset})`, enabled: sharing && zoomLevel > 1, click: () => zoom('reset') },
    { type: 'separator' },
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
  const zoomText = zoomLevel > 1 ? `, zoom ${zoomLevel.toFixed(1)}×` : '';
  tray.setToolTip(sharing ? `RegionShare – ${region.width}×${region.height}${zoomText}` : 'RegionShare');
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

function registerShortcuts() {
  const actions = {
    select: startSelection,
    zoomIn: () => zoom('in'),
    zoomOut: () => zoom('out'),
    zoomReset: () => zoom('reset'),
  };
  for (const [name, accel] of Object.entries(SHORTCUTS)) {
    if (!globalShortcut.register(accel, actions[name])) {
      console.warn(`Another app uses the shortcut ${accel}. Use the tray menu.`);
    }
  }
}

// macOS: show the Dock icon only while a share is open. Teams lists the windows
// of normal apps, so the app is a normal app while the shared window is open.
function updateDock() {
  if (!IS_MAC || !app.dock) return;
  if (region) app.dock.show();
  else app.dock.hide();
}

app.whenReady().then(async () => {
  updateDock();
  setupCapture();
  tray = new Tray(trayImage());
  updateMenu();
  registerShortcuts();
  // Stop when the display with the region goes away.
  screen.on('display-removed', () => {
    if (region && !screen.getAllDisplays().some((d) => d.id === region.displayId)) stopSharing();
  });
  await checkMacPermission();
  const fromArgs = regionFromArgs();
  // At the start, the app only adds its icon to the menu bar or the tray.
  if (fromArgs) setRegion(fromArgs);
  if (SELFTEST) runSelfTest();
});

// A second start of the app does nothing. The first copy is already in the menu bar or the tray.
app.on('second-instance', () => {});

// macOS: a click on the Dock icon brings the hidden window back.
app.on('activate', () => {
  if (parkedBounds && !parkBusy) unparkMirror();
});

// Keep the app in the tray when all windows close.
app.on('window-all-closed', () => {});

app.on('will-quit', () => globalShortcut.unregisterAll());
