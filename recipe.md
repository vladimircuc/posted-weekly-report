# Posted Social — Weekly Ads Report generation recipe

You are generating Posted Social's **internal Monday ads report**, headless in the cloud. Produce
`data.json`, run `node build.mjs`, publish `report.html` to the fixed URL, and notify Slack.
Everything is READ-ONLY except the final publish + Slack post. If any single account fails, degrade
gracefully and KEEP GOING — a partial report that ships beats a perfect one that doesn't.

**Study `data.example.json` first.** It is last week's real, validated output. Produce `data.json` in
the **exact same shape**, with this week's numbers and freshly-written analysis. Match its structure,
field names, and the voice of the verdict/wins/problems. Do not invent new fields.

---

## 0. Dates (compute fresh every run)

Run `date -u +%F` and `date -u +%u` (1=Mon…7=Sun). The report covers the **last completed Mon–Sun week**.
```
LAST_SUN   = most recent Sunday (today is Monday → yesterday)
WK_UNTIL   = LAST_SUN
WK_SINCE   = LAST_SUN - 27 days      # 4 completed weeks, Mon–Sun
PRIOR_UNTIL= WK_SINCE - 1 day        # for the 30d-vs-prior context
```
Use `date -u -d` (Linux) to compute these. The four weekly buckets come from one Meta call with
`time_increment:"7"` over `{since:WK_SINCE, until:WK_UNTIL}` → 4 rows, oldest→newest. Label them
"Mon DD – DD" like the example (e.g. "Aug 3 – 9").

---

## 1. Roster (7 accounts; LT's Pressure Washing is PAUSED — skip it)

| id | name | Meta act (numeric) | type | GHL location | GHL pipeline id | note |
|----|------|--------------------|------|--------------|-----------------|------|
| stlsc | St. Louis Sports Clinic | 1074959853578156 | pipeline | pe05G0gHIvcVk337tcO0 | LYkln8LNw6vQ5MvDhceP | |
| ballwin | Ballwin Tree Service | 1094709792623478 | pipeline | cM2gIu9EA0CHmXFB3rmU | GieYpK2VklsTmKi7zJER | |
| ncorp | NEUAGE Corp | 743171384286711 | ads | — | — | |
| nleaw | NEUAGE Leawood | 409030241842556 | ads | — | — | |
| trinity | Trinity Pools | 2382637378894955 | ads | — | — | |
| varble | Varble Orthodontics | 1274718994214501 | pipeline | NchMBuPj77FSNeXz3SYz | Rw5WDA4pYsRiMWlwwJoT | |
| posted | Posted Social (own) | 1252617339464304 | ads | — | — | **CAMPAIGN-ONLY** |

**Posted Social is campaign-scoped:** report ONLY campaign `120249143843510467`
(`PostedSocial_PostedSocial_Leads_8/7/26`). Every Meta call for `posted` MUST add
`filtering:[{"field":"campaign.id","operator":"IN","value":["120249143843510467"]}]` and use
`level:"campaign"`. Never report the whole account (it has awareness/engagement campaigns). It launched
Aug 10 2026 — if it has <2 completed weeks of delivery, mark it `newCampaign:true` (see the example).

---

## 2. Meta pulls (per account) — tool `mcp__Meta_Ads__ads_get_ad_entities`

Load via ToolSearch `select:mcp__Meta_Ads__ads_get_ad_entities,mcp__Meta_Ads__ads_get_opportunity_score,mcp__Meta_Ads__ads_insights_anomaly_signal,mcp__Meta_Ads__ads_insights_auction_ranking_benchmarks,mcp__Meta_Ads__ads_insights_industry_benchmark,mcp__Meta_Ads__ads_get_errors`.

Per account (add the campaign `filtering` + `level:"campaign"` only for `posted`; others use `level:"ad_account"`):
1. **Weekly** — `time_range:{since:WK_SINCE,until:WK_UNTIL}`, `time_increment:"7"`, fields `["amount_spent","impressions","clicks","ctr","cpc","cpm","reach","frequency","lead","cost_per_lead"]` → 4 rows.
2. **30d** — `date_preset:"last_30d"`, same fields (for the verdict's month-over-month facts).
3. **Prior 30d** — `time_range:{since:PRIOR_UNTIL-29, until:PRIOR_UNTIL}`, same fields.
4. **Creatives** — `level:"ad"`, `time_range` last ~30d, `sort:"amount_spent_descending"`, `limit:12`, fields `["id","name","effective_status","amount_spent","impressions","clicks","ctr","cpm","frequency","lead","cost_per_lead"]` (+ campaign filter for posted).
5. `ads_get_opportunity_score`, `ads_insights_anomaly_signal`, `ads_insights_auction_ranking_benchmarks`(date_preset "last_7d"), `ads_insights_industry_benchmark`(date_preset "last_30d", analysis_metric "CPR"), `ads_get_errors`(entity_ids [act]).

**Parsing:** values come as strings — `"$1,234.56 USD"`→1234.56, `"1.30%"`→1.30, `"2,393"`→2393.
`"Not available"` → `null`. For the benchmark tool, remember a **cost** metric (CPR) "below benchmark"
= cheaper than peers = GOOD; "above" = worse. Empty qualitative responses are normal — just omit.

---

## 3. GHL pulls (pipeline clients only: stlsc, ballwin, varble)

Load `select:mcp__e2396f07-...__execute_operation` (search_operations/describe if needed).
1. `get-pipelines` for the location → confirm the pipeline id in the roster still exists.
2. `search-opportunity`, params **exactly**: `{"query":{"pipelineId":"<id>","date":"<45d ago mm-dd-yyyy>","endDate":"<today mm-dd-yyyy>","status":"all","limit":100,"order":"added_desc"}}`. Page (page 2,3) if `meta.total>100`, up to 300 opps. Results are large → save to file and parse with python, don't read raw into context.

**⚠ GHL retry logic (important):** the executor is flaky and sometimes char-spreads params →
HTTP 422 `"property 0..N should not exist"`. If you get that, **RETRY the same call up to 4 times** —
it usually succeeds on retry (it does for St. Louis). If after retries it still 422s, OR returns only
~20 location-wide records (params ignored), STOP and set that client's `funnel` to the **pending** shape
from the example (`{"pending":true,"pipeline":"<name>","stages":"...","flight":"...","note":"..."}`).
Never let a GHL failure abort the run.

**If GHL works**, compute the matured-cohort funnel: take opps CREATED ~3–4 weeks ago, bucket by current
`pipelineStageId`, and map stages to Leads → Booked → Showed → Sold using:
- **stlsc** (Paid Ad New Patient Pipeline): booked = stage `07 IE Booked` and beyond; showed = `09/10/11`; sold = `10 POC Sold`.
- **ballwin** (Lead Pipeline): booked = `Request Created`+; showed = `Quote Sent`+; sold = `Quote Accepted`/`Job Completed`/`Job Paid`.
- **varble** (Meta Ad Pipeline): booked = `Appointment Booked`+; showed = consult stages (`Bad Fit NC`/`Good Fit NC`/`Conversion`); sold = `Conversion`.
Join creatives to GHL via `attributions[].utmAdId` (real Meta ad id; dedupe first/last touch) for
cost-per-sold. Emit the numeric funnel `{"leads":N,"booked":N,"showed":N,"sold":N,"bp":"47%","sp":"50%","cp":"52%","note":"..."}`.

---

## 4. data.json schema

`{ "generatedUtc": "<ISO>", "reportingWeek": "Aug 3 – Aug 9", "clients": [ <client>, ... ] }`

Each client (see `data.example.json` for every field):
- Identity: `id,name,act:"act_<numeric>",dot,status:"active",type,chips,sub,leadsWk`. `dot` ∈ ok|warn|bad|off.
- Pipeline clients add `ghlLoc,ghlPipe` and a `funnel` (numeric OR pending). Ads clients: no funnel.
- **`weekly`**: array of 4 `{wk:"Aug 3 – 9",spend,leads,cpl,cpm,ctr,freq}` (raw numbers; use `null` for "Not available"). build.mjs computes ALL deltas/trends/WoW from this — do NOT compute percentages yourself.
- `lowvol:true` if the client gets <~8 leads/week (marks leads & CPL as noisy). 
- `creatives:{cols:[...],rows:[...]}` — top 2–3, exactly like the example (pipeline cols include Booked/Sold/$-per-sold; ads cols use Status/Freq/CTR).
- Narrative: `verdict:{tone,html}`, `wins:[{t,b,s}]`, `problems:[{tone,t,b,fix,s}]`.
- `newCampaign:true` clients supply `kpis` (v + `prior:null`) and `launchNote` instead of `weekly` (see `posted` in the example).

---

## 5. Narrative rules (the analysis is the point)

- **Verdict** = one honest sentence a human is glad to read Monday 9am — the decision, not a restatement of tiles. Set `tone` good|warn|bad to match, and `dot` accordingly.
- **wins / problems**: each must say something you could NOT read straight off the numbers. Every problem needs a concrete **fix** naming the specific entity (this ad set, this creative, this stage). Be willing to be unflattering about our own work (stale creative, unworked leads, budget on the wrong ad).
- Cost metrics: down is good. Guard small-n — never declare a trend on 1–3 leads (that's what `lowvol` is for). Prefer the 30-day view over noisy single weeks for low-volume accounts.

---

## 6. Build → publish → notify

1. Write `data.json`. Then run: `node build.mjs` (writes `report.html`). If it errors, fix the JSON and rerun.
2. **Publish** `report.html` with the Artifact tool, updating the fixed page in place:
   `file_path:"report.html"`, `url:"https://claude.ai/code/artifact/03c29e62-f85d-4360-bdae-28abafd30782"`, `title:"Posted — Monday Ads Review"`, `favicon:"📉"`. Capture the URL as PAGE_URL.
3. **Slack** — load `select:mcp__Slack__slack_send_message`, post to channel `C0BPYC7GH6G` (#ad-reports).
   Start the message with `<!channel>` (that is how you @channel via the API). Message:
   `<!channel> ✅ Weekly Ads Review — week of <reportingWeek>. <one line: how many need attention, e.g. "1 needs work (NEUAGE Corp), 3 watch, rest healthy">. Report: PAGE_URL`
4. **Mobile push** — fire a PushNotification: short summary + the same one-liner.
5. Print a plain-text run summary (which accounts pulled cleanly, which GHL funnels went pending, PAGE_URL, Slack result).
