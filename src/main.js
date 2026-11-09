// RegionShare main process.
// The app captures one rectangle of a display and shows it live in a normal window.
// You then share that window in Teams (or any other app that can share a window).
const {
  app, BrowserWindow, Tray, Menu, Notification, screen, desktopCapturer, session, webContents,
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
let toolbarWin = null;
const TOOLBAR_W = 330;
const TOOLBAR_H = 36;
let borderWin = null;
let selectorWins = [];
let showBorder = true;
let zoomLevel = 1;
let sizeScale = 1; // the shared window size: 1 = actual size, 2 = double size, 0 = fit
let sharpScaling = true; // copy pixels without smoothing at whole-number scales
let captureInfo = null; // the size of the capture, from the mirror page
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
    win.webContents.send('region:update', regionPayload());
    applyMirrorSize();
  } else {
    openMirror();
  }
  updateMenu();
}

// The content size of the shared window, in DIP.
// With sizeScale 1 or 2, each region pixel is 1 or 2 window pixels. A whole-number
// scale keeps text sharp. Teams shares the window pixels, so a larger window gives
// a sharper image to the viewers.
// With sizeScale 0, the window fits the free space. The image is then often smaller
// than the region, and text is blurry.
function mirrorSize(maxW, maxH) {
  if (sizeScale > 0) {
    let k = sizeScale;
    while (k > 1 && (region.width * k > maxW || region.height * k > maxH)) k--;
    return { width: region.width * k, height: region.height * k };
  }
  let w = Math.min(region.width, maxW);
  let h = Math.round((w * region.height) / region.width);
  if (h > maxH) {
    h = maxH;
    w = Math.round((h * region.width) / region.height);
  }
  return { width: Math.max(160, w), height: Math.max(90, h) };
}

// The content bounds of the shared window (DIP). Put the window outside the region.
// If the window is inside the region, the capture shows a mirror inside a mirror.
// "park" is true when the window does not fit next to the region. The app then
// moves the window off the screen, and the share stays live.
const TITLE_BAR = 40; // room for the title bar of the window
function mirrorBounds() {
  const regionDisplay = displayById(region.displayId);
  const other = screen.getAllDisplays().find((d) => d.id !== regionDisplay.id);
  if (other) {
    const wa = other.workArea;
    const size = sizeScale > 0
      ? mirrorSize(wa.width, wa.height - TITLE_BAR)
      : mirrorSize(wa.width * 0.6, wa.height * 0.6);
    return {
      x: Math.round(wa.x + Math.max(0, wa.width - size.width) / 2),
      y: Math.round(wa.y + TITLE_BAR + Math.max(0, wa.height - TITLE_BAR - size.height) / 2),
      ...size,
      park: false,
    };
  }
  const wa = regionDisplay.workArea;
  const r = absoluteRegion();
  const gap = 16;
  const room = {
    right: wa.x + wa.width - (r.x + r.width) - gap * 2,
    left: r.x - wa.x - gap * 2,
    below: wa.y + wa.height - (r.y + r.height) - gap * 2 - TITLE_BAR,
    above: r.y - wa.y - gap * 2 - TITLE_BAR,
  };
  const horizontal = (side) => side === 'right' || side === 'left';
  let size;
  let side;
  if (sizeScale > 0) {
    size = mirrorSize(wa.width, wa.height - TITLE_BAR);
    // Use a side where the full size fits. If no side has the room, park the window.
    side = Object.keys(room).find((k) => (horizontal(k)
      ? room[k] >= size.width && wa.height - TITLE_BAR >= size.height
      : room[k] >= size.height && wa.width >= size.width));
  } else {
    side = Object.keys(room).sort((a, b) => room[b] - room[a])[0];
    size = horizontal(side)
      ? mirrorSize(Math.max(160, room[side]), wa.height * 0.8)
      : mirrorSize(wa.width * 0.8, Math.max(90, room[side]));
  }
  const park = !side;
  side = side || 'right';
  const pos = {
    right: { x: r.x + r.width + gap, y: r.y },
    left: { x: r.x - gap - size.width, y: r.y },
    below: { x: r.x, y: r.y + r.height + gap + TITLE_BAR },
    above: { x: r.x, y: r.y - gap - size.height },
  }[side];
  // Keep the window on the display.
  pos.x = Math.min(Math.max(pos.x, wa.x), wa.x + Math.max(0, wa.width - size.width));
  pos.y = Math.min(Math.max(pos.y, wa.y + TITLE_BAR), wa.y + Math.max(TITLE_BAR, wa.height - size.height));
  return { ...pos, ...size, park };
}

// Tell the user one time why the shared window is not on the screen.
let parkNoticeShown = false;
function noticeParked() {
  if (parkNoticeShown || SELFTEST) return;
  parkNoticeShown = true;
  if (!Notification.isSupported()) return;
  new Notification({
    title: 'RegionShare',
    body: 'The shared window does not fit next to the region, so it is hidden off the screen. '
      + 'The share stays live. In Teams, share the window "RegionShare – Shared Region".',
  }).show();
}

// Set the size of the shared window again, for example after a new region or a new size option.
function applyMirrorSize() {
  const win = liveMirror();
  if (!win || !region) return;
  const b = mirrorBounds();
  win.setAspectRatio(0);
  if (parkedBounds || b.park) {
    win.setContentSize(b.width, b.height);
    const outer = win.getBounds();
    parkedBounds = { x: b.x, y: b.y - (outer.height - b.height), width: outer.width, height: outer.height };
    parkMirror();
    if (b.park) noticeParked();
  } else {
    win.setContentBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  }
  win.setAspectRatio(region.width / region.height);
}

function openMirror() {
  const b = mirrorBounds();
  parkedBounds = null;
  const startParked = b.park;
  delete b.park;
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
  win.loadFile(path.join(__dirname, 'mirror.html'), {
    query: { selftest: SELFTEST ? '1' : '', control: SELFTEST === 'toolbarcontrol' ? '1' : '' },
  });
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('region:update', regionPayload());
    win.webContents.send('quality', { sharp: sharpScaling });
  });
  openToolbar(win);
  win.on('move', placeToolbar);
  win.on('resize', placeToolbar);
  if (startParked) {
    parkMirror();
    noticeParked();
  }
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

// A small bar with a "Hide this window" button, on top of the shared window.
// The bar is a separate window, so a window share in Teams does not show it.
// Content protection also keeps the bar out of screen captures.
function openToolbar(parent) {
  toolbarWin = new BrowserWindow({
    parent,
    width: TOOLBAR_W,
    height: TOOLBAR_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: PRELOAD },
  });
  const bar = toolbarWin;
  bar.setContentProtection(true);
  bar.loadFile(path.join(__dirname, 'toolbar.html'), { query: { selftest: SELFTEST ? '1' : '' } });
  bar.once('ready-to-show', () => {
    placeToolbar();
    if (!parkedBounds) bar.showInactive();
  });
  bar.on('closed', () => {
    if (toolbarWin === bar) toolbarWin = null;
  });
}

function liveToolbar() {
  return toolbarWin && !toolbarWin.isDestroyed() ? toolbarWin : null;
}

// Put the bar at the top center of the shared window content.
function placeToolbar() {
  const win = liveMirror();
  const bar = liveToolbar();
  if (!win || !bar || parkedBounds) return;
  const c = win.getContentBounds();
  bar.setBounds({
    x: Math.round(c.x + (c.width - TOOLBAR_W) / 2),
    y: c.y + 8,
    width: TOOLBAR_W,
    height: TOOLBAR_H,
  });
}

ipcMain.on('mirror:hide', () => parkMirror());

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
  if (liveToolbar()) toolbarWin.hide();
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
  placeToolbar();
  if (liveToolbar()) toolbarWin.showInactive();
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
  captureInfo = null;
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

function setSizeScale(k) {
  sizeScale = k;
  applyMirrorSize();
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

ipcMain.on('capture:info', (_e, info) => {
  captureInfo = info;
  updateMenu();
});

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

// REGIONSHARE_SELFTEST=toolbar: capture the shared window, as Teams does, and count
// the pixels with the test color of the toolbar (cyan). The count must be 0.
function runToolbarTest() {
  const cyan = [];
  ipcMain.on('selftest:frames', (_e, _n, _b, c) => cyan.push(c));
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
    const bar = liveToolbar();
    console.log('[selftest] toolbar visible', bar && bar.isVisible(), 'bounds', bar && JSON.stringify(bar.getBounds()),
      'mirror content', JSON.stringify(mirrorWin.getContentBounds()));
    console.log('[selftest] cyan pixels in the window capture, each second:', JSON.stringify(cyan));
    const ok = cyan.length >= 3 && cyan.every((c) => c === 0);
    console.log(`[selftest] mode=${SELFTEST} result=${ok ? 'NOT IN SHARE' : 'IN SHARE'}`);
    // Click the button in the bar. The shared window must go off the screen.
    if (bar) bar.webContents.executeJavaScript("document.getElementById('hide').click()");
  }, 10000);
  setTimeout(() => {
    const bar = liveToolbar();
    console.log('[selftest] after the click: parked', !!parkedBounds, 'bar visible', !!(bar && bar.isVisible()),
      'mirror', JSON.stringify(mirrorWin.getBounds()));
    app.exit(0);
  }, 12500);
}

function runSelfTest() {
  if (SELFTEST === 'zoom') return runZoomTest();
  if (SELFTEST === 'toolbar' || SELFTEST === 'toolbarcontrol') return runToolbarTest();
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
      label: 'Shared Window Size',
      enabled: sharing,
      submenu: [
        { label: 'Actual Size (1:1, sharp)', type: 'radio', checked: sizeScale === 1, click: () => setSizeScale(1) },
        { label: 'Double Size (2×, sharper for viewers)', type: 'radio', checked: sizeScale === 2, click: () => setSizeScale(2) },
        { label: 'Fit Next to the Region (can be blurry)', type: 'radio', checked: sizeScale === 0, click: () => setSizeScale(0) },
      ],
    },
    {
      label: 'Sharp Scaling',
      type: 'checkbox',
      checked: sharpScaling,
      click: (item) => {
        sharpScaling = item.checked;
        const win = liveMirror();
        if (win) win.webContents.send('quality', { sharp: sharpScaling });
      },
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
  const zoomText = zoomLevel > 1 ? `, zoom ${zoomLevel.toFixed(1)}×` : '';
  let captureText = '';
  if (captureInfo) {
    captureText = `\nCapture ${captureInfo.videoWidth}×${captureInfo.videoHeight}`;
    if (captureInfo.videoWidth < captureInfo.expectedWidth) {
      captureText += ` (lower than the display: ${captureInfo.expectedWidth}×${captureInfo.expectedHeight})`;
    }
  }
  tray.setToolTip(sharing ? `RegionShare – ${region.width}×${region.height}${zoomText}${captureText}` : 'RegionShare');
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
  // For tests: --size=0, 1, or 2 sets the shared window size.
  const sizeArg = process.argv.find((x) => x.startsWith('--size='));
  if (sizeArg && ['0', '1', '2'].includes(sizeArg.slice(7))) sizeScale = Number(sizeArg.slice(7));
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
