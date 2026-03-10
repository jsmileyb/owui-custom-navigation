# OWUI Custom Nav Overlay

## Purpose

This project provides a portable, prune-style customization overlay for Open WebUI running in Docker.
You copy these files into the container, run a Python patcher, and optionally restart the container.
No local Open WebUI source checkout or host-side image rebuild is required.

## Prerequisites

- A running Open WebUI Docker container
- `docker cp`
- `docker exec`
- Admin shell access
- Container name or ID (examples use `open-webui`)

## Folder Structure

```text
owui-custom-nav/
  patch_openwebui.py
  nav-injector.js
  nav-injector.css
  nav-config.json
  README.md
```

## Step 1: Copy Files Into The Container

```bash
docker cp owui-custom-nav/. open-webui:/app/custom-nav/
```

## Step 2: Run Interactively Inside Container

```bash
docker exec -it open-webui bash
cd /app/custom-nav
python3 patch_openwebui.py --apply
```

Optional preview mode:

```bash
python3 patch_openwebui.py --dry-run --verbose
```

## Step 3: Restart Container If Needed

```bash
docker restart open-webui
```

## Step 4: Restore Original Files

```bash
docker exec -it open-webui bash
cd /app/custom-nav
python3 patch_openwebui.py --restore
docker restart open-webui
```

## Updating An Already-Patched Running Container

### Full update (JS/CSS/config/patcher changes)

Use this when you changed any of:

- `nav-injector.js`
- `nav-injector.css`
- `patch_openwebui.py`
- `nav-config.json`

```bash
docker cp ./. open-webui:/app/custom-nav/
docker exec -it open-webui bash
cd /app/custom-nav
python3 patch_openwebui.py --apply
exit
docker restart open-webui
```

### Config-only update (usually no re-apply needed)

Use this when only `nav-config.json` changed.

```bash
docker cp ./nav-config.json open-webui:/app/custom-nav/nav-config.json
docker exec -it open-webui bash -lc "cp /app/custom-nav/nav-config.json /app/backend/open_webui/frontend/custom/nav-config.json"
```

Then refresh the browser. Restart the container only if you suspect aggressive caching.

## Runtime Config Updates

`nav-injector.js` fetches `/custom/nav-config.json` at runtime (with cache-busting), so you can edit `nav-config.json` and copy only that file without re-running `--apply`.

Example:

```bash
docker cp nav-config.json open-webui:/app/custom-nav/nav-config.json
docker exec -it open-webui bash -lc "cp /app/custom-nav/nav-config.json /app/backend/open_webui/frontend/custom/nav-config.json"
```

### Positioning The Custom Section

You can place the custom section relative to a sidebar item (for example, above `New Chat`) using `placement`:

```json
{
  "sectionLabel": "Custom Links",
  "placement": {
    "position": "before",
    "anchorText": "New Chat"
  },
  "items": []
}
```

`position` supports: `before`, `after`, `top`, `bottom`.
If the anchor is not found, the injector falls back to appending at the bottom.

### Adding OOTB-Style Icons

Each item can include SVG stroke-path icon settings:

```json
{
  "id": "docs",
  "label": "Documentation",
  "type": "external",
  "url": "https://example.com/docs",
  "newTab": true,
  "iconPath": "M...Z",
  "iconViewBox": "0 0 24 24",
  "iconStrokeWidth": 2
}
```

- `iconPath`: SVG `path d` data (single path)
- `iconViewBox`: optional, defaults to `0 0 24 24`
- `iconStrokeWidth`: optional, defaults to `2`

### How To Create An `iconPath`

1. Pick an SVG icon source (for example [Heroicons](https://heroicons.com/) outline icons).
2. Open the SVG and copy the `<path d="...">` value.
3. Paste that value into `iconPath` in `nav-config.json`.
4. Copy the SVG `viewBox` into `iconViewBox` (or keep the default `0 0 24 24`).
5. Set `iconStrokeWidth` to match the source icon (commonly `1.5` or `2`).

Example source SVG:

```xml
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M12 4v16m8-8H4" />
</svg>
```

Matching config:

```json
{
  "id": "new-item",
  "label": "My Link",
  "type": "external",
  "url": "https://example.com",
  "newTab": true,
  "iconPath": "M12 4v16m8-8H4",
  "iconViewBox": "0 0 24 24",
  "iconStrokeWidth": 2
}
```

Notes:

- If the icon does not show, check browser devtools for malformed `iconPath` data.
- Complex icons with multiple `<path>` elements are not supported in this v1 shape; use a single-path icon.
- Modal items can optionally include `modalFooterLabel` to customize the footer button text (defaults to `Okay, Let's Go!`).

### Home Page Pop-Up

You can optionally show a modal when the home page (`/`) loads by adding `homePopup`:

```json
{
  "homePopup": {
    "enabled": true,
    "modalTitle": "Welcome",
    "modalHtml": "<p>Welcome to Open WebUI.</p>",
    "modalFooterLabel": "Okay, Let's Go!",
    "toolbarLabel": "Show Welcome",
    "toolbarIconPath": "M12 8h.01M11 12h1v4h1m-1 6a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"
  }
}
```

Behavior:
- Only shows on `location.pathname === "/"`.
- Displays once per day per browser (local time).
- If `enabled` is `false` or required fields are missing, it is ignored.
- After the first show each day, a custom nav button appears in the sidebar for the rest of the day. Clicking it reopens the modal.
- `toolbarIconPath` is optional; if omitted, the default modal icon is used.

## What The Patcher Does

- Discovers likely frontend build directories
- Finds a stable shell file (`index.html` preferred)
- Copies:
  - `nav-injector.js`
  - `nav-injector.css`
  - `nav-config.json`
- Creates backup(s) for modified file(s) using:
  - `.original.customnav.bak`
- Injects:
  - `<link rel="stylesheet" href="/custom/nav-injector.css">`
  - `<script src="/custom/nav-injector.js"></script>`
- Uses marker comments for idempotent re-runs
- Writes `.customnav-manifest.json` for restore metadata

## Selector Strategy (Sidebar Fallback)

`nav-injector.js` attempts in this order:

1. Semantic/landmark containers (`aside`, `nav`, `#nav`, sidebar-like test IDs)
2. Containers with dense internal nav link/button patterns
3. Injection near bottom of selected sidebar host
4. Graceful no-op with console diagnostics if no reliable host is found

## Troubleshooting

### Locate Actual App Shell Files

Inside the container:

```bash
find /app -maxdepth 5 -type f \( -name "index.html" -o -name "app.html" \)
```

Then run:

```bash
python3 patch_openwebui.py --dry-run --verbose
```

### If Selectors Fail After OWUI Upgrade

- Open browser devtools and inspect current sidebar markup.
- Update selector logic in `nav-injector.js`.
- Re-copy `nav-injector.js` into container custom directory.
- Refresh the browser (or restart container if needed).

### Verify Script/CSS Load

In browser devtools:

- Network tab: confirm `/custom/nav-injector.js` and `/custom/nav-injector.css` return 200.
- Console: check for `[custom-nav]` warnings.
- Elements tab: verify a node with `data-custom-nav-root="true"` under the sidebar.

### Patcher Cannot Find Entry Point

If the patcher exits safely with no patch target:

- use `--dry-run --verbose` to view checked candidates
- confirm `FRONTEND_BUILD_DIR` inside container
- manually inspect selected frontend directory for `index.html` or `app.html`

## CLI Reference

```bash
python3 patch_openwebui.py --dry-run [--verbose]
python3 patch_openwebui.py --apply [--verbose]
python3 patch_openwebui.py --restore [--verbose]
```


