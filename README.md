# RegionShare

Share only a part of your screen in Microsoft Teams, or in any app that can share one window.

Teams can share a full screen or one window. It cannot share a region. RegionShare captures the region
that you select and shows it live in its own window. In Teams, you share that window.

Runs on macOS and Windows (Electron).

## Use

1. Run `npm install` one time.
2. On macOS, run `npm run app`. The script builds and opens `dist/mac-arm64/RegionShare.app`. On Windows, run `npm start`.
3. Drag a rectangle around the part of the screen that you want to share.
4. In Teams, select **Share** > **Window** > **RegionShare – Shared Region**.

The red border shows the shared region on your screen. The border is outside the region, so the
people in the meeting do not see it.

The tray icon (menu bar on macOS) has these items:
- **Select a New Region** (also `Cmd+Shift+2` / `Ctrl+Shift+2`). The shared window changes live, so you do not need to share again in Teams.
- **Show Shared Window**.
- **Show Border Around Region**.
- **Stop Sharing**.
- **Quit RegionShare**.

## Points to know

- On a single display, keep the shared window outside the region. The app puts it there at the start.
- Other windows can cover the shared window, and Teams still shares it. Do not minimize the shared window.
- macOS asks for the Screen Recording permission. After you give the permission, quit the app and start it again.
- On macOS, do not use `npm start` for screen capture. When a terminal starts the app, macOS gives the permission request to the terminal, and the app does not show in System Settings.

## Build

- macOS: `npm run dist:mac` (makes a `.dmg` in `dist/`).
- Windows: `npm run dist:win` (makes an installer in `dist/`). Run this on a Windows computer for the best result.

## Test option

`npm start -- --region=x,y,width,height` selects a region on the primary display at the start.
Set `REGIONSHARE_DEBUG=1` to print the capture statistics.
