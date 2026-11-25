# PulseBoard — Interactive Mockery Prototype

### 1. Canvas & Flow Overview

Styled interactive Mockery canvas (`desktop` 1440×900) organized into `admin` and `public` sections, validating all four `sf-ux` screens using `sf-ui` design tokens.

### 2. Screen & Component Inventory

Maps `admin-dashboard`, `monitor-drawer`, `incident-detail`, and `public-status` with shared `<x-include>` partials `topbar` and `status-pill` across 3 interactive navigation edges.

### 3. Token Mapping & Viewer Commands

`tokens.css` maps `sf-ui` `color_palette`, `typography`, and `border_radius_base` verbatim (`tokens_synced_from_ui: true`). Launch locally with the bundled `sf-mockery` CLI (`serve`, `check`, `export`).

<system_state>
{
  "phase": "mockery",
  "fidelity": "styled",
  "mockups_dir": "docs/factory/mockups",
  "devices": ["desktop"],
  "sections": ["admin", "public"],
  "screens": [
    {
      "id": "admin-dashboard",
      "title": "Admin Dashboard",
      "file": "screens/admin-dashboard.html",
      "device": "desktop",
      "ux_screen_ref": "Admin Monitor Dashboard",
      "variant": "happy"
    },
    {
      "id": "monitor-drawer",
      "title": "New Monitor Drawer",
      "file": "screens/monitor-drawer.html",
      "device": "desktop",
      "ux_screen_ref": "Create/Edit Monitor Drawer",
      "variant": "happy"
    },
    {
      "id": "incident-detail",
      "title": "Incident Detail",
      "file": "screens/incident-detail.html",
      "device": "desktop",
      "ux_screen_ref": "Incident Detail & Timeline",
      "variant": "happy"
    },
    {
      "id": "public-status",
      "title": "Public Status Page",
      "file": "screens/public-status.html",
      "device": "desktop",
      "ux_screen_ref": "Public Status Page",
      "variant": "happy"
    }
  ],
  "components": ["topbar", "status-pill"],
  "edges_count": 3,
  "tokens_synced_from_ui": true
}
</system_state>
