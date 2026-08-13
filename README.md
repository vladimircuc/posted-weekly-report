# posted-weekly-report

Rendering shell for an internal weekly ads report generator (no business data lives here).

- `template.html` — report shell (design, charts, gate). Has a `__CLIENTS_DATA__` placeholder; contains no data.
- `build.mjs` — deterministic renderer: reads a local `data.json`, computes deltas/trends/week-over-week, writes `report.html`.

Run: `node build.mjs` (expects `data.json` alongside).
