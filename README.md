# posted-weekly-report

Generator for Posted Social's internal Monday ads report (runs unattended in a Claude cloud routine).

- `recipe.md` — what the cloud agent does each Monday (roster, MCP calls, GHL retry, publish + Slack).
- `template.html` — the fixed report shell (design, charts, password gate). Contains `__CLIENTS_DATA__`.
- `build.mjs` — deterministic generator: reads `data.json` (raw weekly numbers + analysis), computes
  every delta / trend / week-over-week figure, writes `report.html`. No LLM arithmetic.
- `data.example.json` — last week's real, validated data — the structural + style template to mirror.

Local run: `node build.mjs` (reads `data.json`, writes `report.html`).
