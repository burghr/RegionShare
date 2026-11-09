# RegionShare

Share only a part of your screen in Microsoft Teams, or in any app that can share one window.

Teams can share a full screen or one window. It cannot share a region. RegionShare captures the region
that you select and shows it live in its own window. In Teams, you share that window.

Runs on macOS and Windows (Electron).

## Use

1. Run `npm install` one time.
2. On macOS, run `npm run app`. The script builds and opens `dist/mac-arm64/RegionShare.app`. On Windows, run `npm start`, or install the app from the releases page.
3. The app adds an icon to the menu bar (macOS) or the tray (Windows). The app does not open a window at the start.
4. Click the icon and select **Select Region…**, or press `Cmd+Shift+2` / `Ctrl+Shift+2`.
5. Drag a rectangle around the part of the screen that you want to share.
6. In Teams, select **Share** > **Window** > **RegionShare – Shared Region**.

The red border shows the shared region on your screen. The border is outside the region, so the
people in the meeting do not see it.

## Zoom

Zoom in to show a larger image of a smaller part of the region. The border shows the zoom level.

| Action | Shortcut (all apps) | In the shared window |
| --- | --- | --- |
| Zoom in | `Cmd+Option+=` / `Ctrl+Alt+=` | Scroll wheel, `+`, or a click |
| Zoom out | `Cmd+Option+-` / `Ctrl+Alt+-` | Scroll wheel or `-` |
| Reset the zoom | `Cmd+Option+0` / `Ctrl+Alt+0` | Double-click or `0` |
| Move the zoomed view | — | Drag, or the arrow keys |

When the mouse pointer is in the region, the shortcuts zoom at the pointer.

## Hide the shared window

A minimized window does not draw, so a share in Teams stops. For this reason, RegionShare does not
minimize the shared window. When you click minimize (or **Hide Shared Window** in the menu), the app
moves the window off the screen. The share stays live.

- **Windows:** the window goes fully off the screen. Click its taskbar button, or **Show Shared Window** in the tray menu, to bring it back.
- **macOS:** macOS keeps a small part of the title bar (about 40 × 32 px) in the bottom-right corner of the screen. Click that part, the Dock icon, or **Show Shared Window** in the menu bar, to bring it back.

## Points to know

- On a single display, keep the shared window outside the region. The app puts it there at the start.
- Other windows can cover the shared window, and Teams still shares it.
- macOS asks for the Screen Recording permission. After you give the permission, quit the app and start it again.
- On macOS, do not use `npm start` for screen capture. When a terminal starts the app, macOS gives the permission request to the terminal, and the app does not show in System Settings.
- On macOS, the Dock icon shows only while a share is open.

## Build

- macOS: `npm run dist:mac` (makes a `.dmg` in `dist/`).
- Windows: `npm run dist:win` (makes an installer in `dist/`).

## Self-test

The self-test shows if a window share stays live after a minimize. A hidden page in the app captures
the shared window in the same way as Teams, and counts the frames.

Windows (Command Prompt):

```
set REGIONSHARE_SELFTEST=park
"%LOCALAPPDATA%\Programs\RegionShare\RegionShare.exe" --region=200,200,800,450
```

macOS:

```
open -n --env REGIONSHARE_SELFTEST=park dist/mac-arm64/RegionShare.app --args --region=200,200,800,450
```

After about 17 seconds, a dialog shows **LIVE** or **FROZEN**. Set `REGIONSHARE_SELFTEST=nopark` to see
the old behavior (the share freezes). Set `REGIONSHARE_SELFTEST=zoom` to test the zoom commands.

## Test options

- `--region=x,y,width,height` selects a region on the primary display at the start.
- `REGIONSHARE_DEBUG=1` prints the capture statistics.
