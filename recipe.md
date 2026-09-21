# Weekly Ads Report — generation recipe (generic)

You generate an internal Monday ads report, headless in the cloud. This repo (cloned into your workspace)
holds `template.html` + `build.mjs`. **The runner message supplies the client roster, the per-pipeline
stage mappings, the campaign-scoped account, the publish URL, and the Slack channel** — this file is the
generic method. Produce `data.json`, run `node build.mjs` (writes `report.html`), publish it, notify Slack.
Everything is READ-ONLY except the final publish + Slack post. If one account fails, degrade and KEEP GOING
— a partial report that ships beats a perfect one that doesn't. A **missing connector is not a failing
account**: wait for it per §0a before degrading anything. Do NOT compute any percentages yourself;
`build.mjs` computes every delta/trend/week-over-week figure from the raw `weekly` arrays.

## 0. Preflight, then dates

### 0a. PREFLIGHT — wait for the connectors (DO THIS BEFORE ANYTHING ELSE)
The sandbox attaches MCP connectors **asynchronously**, and their tool lists can arrive LATE or
PARTIAL. This has broken three production runs: **Sep 7** (GHL + Slack registered zero tools),
**Sep 14** (Slack zero tools), **Sep 21** (Meta_Ads exposed only 5 creative-upload tools, and the
run aborted with no report at all). In every case the connector was configured correctly — the agent
simply looked too early and gave up inside a minute. **Never conclude a connector is broken until you
have waited it out.**

Tools to confirm, by connector:

| Connector | Probe tool | If absent |
|---|---|---|
| Meta_Ads | `mcp__Meta_Ads__ads_get_ad_entities` | HARD STOP — it is the sole source of every spend/lead number |
| GHL_MCP | `mcp__GHL_MCP__execute_operation` | soft — pipeline funnels degrade to `pending` |
| Slack | `mcp__Slack__slack_send_message` | soft here — §6.3 retries it at the end |

Loop for up to ~8 minutes:
1. `ToolSearch` with `select:mcp__Meta_Ads__ads_get_ad_entities,mcp__GHL_MCP__execute_operation,mcp__Slack__slack_send_message`
2. Anything still missing → `Bash: sleep 45`, then search again. **Up to 10 attempts.**
3. Stop as soon as all three resolve.

The `select:` form is the authoritative check. A broad keyword search can return an unrelated subset
(e.g. Meta's creative-upload helpers) that *looks* like a partial registration — do not let that
convince you. Exhaustively searching is NOT a substitute for waiting: **sleep and retry.**

After the loop: Meta still missing → genuine platform failure, abort WITHOUT publishing (never
fabricate), and state in the PushNotification how many attempts over how many minutes you made.
GHL missing → carry on, funnels go `pending`. Slack missing → carry on, §6.3 tries again.

### 0b. Dates (compute fresh)
Report covers the **last completed Mon–Sun week**. Run `date`. LAST_SUN = most recent Sunday; the four
weekly buckets = the 4 completed weeks ending LAST_SUN. Weekly Meta pull: one call, `time_increment:"7"`,
`time_range:{since:LAST_SUN-27d, until:LAST_SUN}` → 4 rows oldest→newest, label "Mon D – D".
30d = `date_preset:"last_30d"`; prior-30d = the 30 days before that (for the verdict's MoM facts).

## 1. Roster & campaign scoping (IMPORTANT)
The runner lists every account: `id, name, Meta act (numeric), type (pipeline|ads), GHL location, GHL
pipeline id`. **Report ONLY the currently-RUNNING lead campaign(s) for each account — never pull at
`level:"ad_account"`, because that sweeps in paused/stopped campaigns' old spend.**

For EACH account, first discover the live campaign(s):
- Pull `level:"campaign"`, `date_preset:"last_30d"`, fields `["id","name","objective","effective_status","amount_spent"]`.
- Keep campaigns where `effective_status` == `ACTIVE` **and** `objective` == `OUTCOME_LEADS`. Collect their ids → `ACTIVE_IDS`.
- One account is pre-pinned by the runner (Posted Social) to a single campaign id — for it use ONLY that id and ignore everything else.
- If an account has no active lead campaign (paused/off this week), **OMIT it from the report entirely** — do NOT add it to `data.json`, do NOT pull metrics. The report shows a tab ONLY for clients whose lead campaign is actively delivering; paused clients get no tab. This applies to the pinned campaign-scoped account too: if its one campaign is paused, omit that client this week. It reappears automatically the week its campaign goes active again. (The template also hard-filters to `status:"active"` clients as a safety net, so never emit a non-active client expecting it to show.)

Then scope EVERY Meta metric pull to `ACTIVE_IDS`: `level:"campaign"` + `filtering:[{"field":"campaign.id","operator":"IN","value":ACTIVE_IDS}]`. Usually there is ONE active lead campaign per client; if there are several, the campaign-level weekly returns one row-set per campaign — SUM them per week. If a scoped campaign has <2 completed weeks of delivery, mark that client `newCampaign:true` (see Appendix). A "completed week of delivery" = any reporting week in the 4-week window where spend > 0, **even a partial one** (a campaign that launched mid-week still counts that week). The flag is only a HINT: `build.mjs` re-checks it against the `weekly` array and shows real trends anyway once 2+ weeks have spend, so ship `weekly` for every client without exception.

## 2. Meta pulls per account — `mcp__Meta_Ads__ads_get_ad_entities` (+ insight tools)
Load via ToolSearch. Every pull is campaign-scoped to `ACTIVE_IDS` (Section 1). Do NOT pass
`client_conversation_id` to `ads_insights_auction_ranking_benchmarks` or `ads_insights_industry_benchmark`
— those tools reject it. For each account:
1. Weekly — `time_range:{since,until}`, `time_increment:"7"`, fields `["amount_spent","impressions","clicks","ctr","cpc","cpm","reach","frequency","lead","cost_per_lead"]` → 4 rows.
2. 30d — `date_preset:"last_30d"`; 3. Prior-30d — `time_range` of the previous 30 days (same fields).
4. Creatives — `level:"ad"`, `time_range` last ~30d, `sort:"amount_spent_descending"`, `limit:12`, fields incl `effective_status`, **filtered to the running campaign(s)**: `filtering:[{"field":"ad.campaign_id","operator":"IN","value":ACTIVE_IDS}]`.
5. `ads_get_opportunity_score` (account-level only — note it reflects the whole account), `ads_insights_anomaly_signal`, `ads_insights_auction_ranking_benchmarks`(last_7d), `ads_insights_industry_benchmark`(last_30d, CPR), `ads_get_errors`. Pass `entity_ids:ACTIVE_IDS` to scope these to the running campaign(s) where the tool accepts `entity_ids`.
Parse strings: `"$1,234.56 USD"`→1234.56, `"1.30%"`→1.30, `"Not available"`→null. For the CPR benchmark, "below benchmark" = cheaper than peers = GOOD.

## 3. GHL (pipeline clients only) — `mcp__GHL_MCP__execute_operation`
- `get-pipelines` for the location to confirm the pipeline id.
- `search-opportunity`, params EXACTLY `{"query":{"pipelineId":"<id>","date":"<45d ago mm-dd-yyyy>","endDate":"<today mm-dd-yyyy>","status":"all","limit":100,"order":"added_desc"}}`. Page 2–3 if `meta.total>100`. Large → save to file, parse with python.
- **RETRY:** on HTTP 422 `"property 0..N should not exist"`, RETRY the same call up to 4× (flaky; usually succeeds). If it still fails, or returns only ~20 location-wide records, STOP and set that client's `funnel` to the pending shape (Appendix). NEVER let GHL abort the run.
- If it works: matured-cohort funnel = opps created ~3–4 wks ago bucketed by current stage, mapped to Leads→Booked→Showed→Sold **using the per-pipeline stage mapping the runner provides**. Join creatives via `attributions[].utmAdId` for cost-per-sold. Emit numeric `funnel:{leads,booked,showed,sold,bp,sp,cp,note}`.

## 4. data.json schema
`{generatedUtc, reportingWeek, clients:[...]}`. Each client: identity (`id,name,act:"act_<num>",dot(ok|warn|bad|off),status,type,chips,sub,leadsWk`); pipeline clients add `ghlLoc,ghlPipe,funnel`(numeric or pending); **`weekly`**: 4 × `{wk,spend,leads,cpl,cpm,ctr,freq}` raw (null for N/A); `lowvol:true` if <~8 leads/wk; `creatives:{cols,rows}`; narrative `verdict:{tone,html}`, `wins:[{t,b,s}]`, `problems:[{tone,t,b,fix,s}]`. `newCampaign:true` clients add `kpis`(v+`prior:null`)+`launchNote` **in addition to** `weekly` (never instead of it).

## 5. Narrative — DIG FOR ROOT CAUSE (the point of the report)
Verdict = one honest decision-sentence, not a restatement of tiles; set `tone`+`dot` to match. Every
problem must say something you could NOT read off the tiles, name the specific entity (this ad, this
audience, this stage), and give a concrete **fix**. Cost metrics: down=good. Never call a trend on 1–3
leads (that's `lowvol`). Be willing to be unflattering about our own work.

**For any account you mark `warn` or `bad`, do not just describe the symptom — diagnose WHY by
cross-referencing the signals, and prescribe the corrective action.** Hunt these patterns explicitly:
- **Creative fatigue** — frequency rising AND CTR falling together over the weeks (esp. on the ad carrying most spend) → refresh creative, not budget.
- **Saturated / too-narrow audience** — reach flat or shrinking while frequency climbs, and/or CPM far above the roster norm → expand or refresh the audience; more budget just raises frequency.
- **Broken measurement** — pixel-access / Page-restriction errors, or "Not available" leads on spending ads → fix tracking before trusting CPL or scaling.
- **Cost vs peers** — CPR above the industry benchmark despite a healthy CTR → the offer / landing page likely converts worse than peers; pressure-test it.
- **Lead quality gap (pipeline clients)** — an ad with cheap CPL but a low booked/sold rate vs the account, or the cheapest-CPL ad is NOT the cheapest cost-per-sold → judge and fund on cost-per-sold, not CPL.
- **Spend concentration** — one ad carrying >~60% of spend with no cheaper proven backup → single point of failure; stand up challengers.
- **Pipeline leaks (GHL)** — leads piling up unworked in an early stage, high no-show rate, or a stage where the cohort stalls → a client-ops issue to raise, not a media one.
- **Budget misallocation** — the highest-spend ad is not the most efficient one → rebalance toward the efficient creative.
Connect at least one such pattern for each struggling account, with the number that proves it and the specific next step.

## 6. Build → publish → notify
1. Write `data.json`; run `node build.mjs`. Fix JSON + rerun if it errors.
2. Publish `report.html` with the Artifact tool: `file_path:"report.html"`, `url:"<REPORT_URL from runner>"`, `title:"Posted — Monday Ads Review"`, favicon a chart-decreasing emoji. Capture PAGE_URL.
3. **Slack — a REQUIRED delivery step.** The report existing is not the same as the team seeing it.
   - a. If `mcp__Slack__slack_send_message` did not load in preflight, retry it NOW: the `select:` ToolSearch, `Bash: sleep 45` between tries, up to 5 more attempts. A connector missing at minute 1 is often up by minute 15.
   - b. Post to `<SLACK_CHANNEL from runner>`, message starting with `<!channel>`: `<!channel> ✅ Weekly Ads Review — week of <reportingWeek>. <one line, e.g. "1 needs work (X), 3 to watch, rest healthy">. Report: PAGE_URL`
   - c. **Verify it landed** — the tool returns a ts/permalink. A call that errored is not a post.
   - d. If it still cannot post, the run is a **PARTIAL FAILURE** even though the report published. Lead with `SLACK POST FAILED` on the first line of both the PushNotification and the run summary — do not lead with the report link. Silent Slack failure is exactly how three weeks of reports went unnoticed.
4. Fire a PushNotification (short summary + same one-liner).
5. Print a run summary, **leading with any delivery failure**: Slack result first, then accounts pulled cleanly, GHL funnels that went pending, PAGE_URL, and how long preflight waited on each connector.

## Appendix — exact data.json shape (RAW; build.mjs computes every %). Fictional sample.
One pipeline client:
{"id":"acme","name":"Acme Clinic","act":"act_000000000000000","dot":"ok","status":"active",
 "type":"pipeline","ghlLoc":"loc_xxx","ghlPipe":"Paid Ad Pipeline",
 "chips":[["src","Meta + GHL"],["","Lead gen"]],"sub":"act_000000000000000 · Paid Ad Pipeline",
 "leadsWk":66,"lowvol":false,
 "verdict":{"tone":"good","html":"Last week landed <b>66 leads at $22.67</b>. Over 30d spend is down <b>47%</b> while CPL fell <b>33%</b>."},
 "wins":[{"t":"Efficiency turnaround is real","b":"Half the spend, yet <span class=\"metric\">CPL $37→$25</span>.","s":"ads_get_ad_entities · 30d vs prior 30d"}],
 "problems":[{"tone":"p","t":"Cheapest leads = priciest customers","b":"Ad B sells at $268 vs $423.","fix":"Shift test budget to Ad B; judge on cost-per-sold.","s":"utmAdId join"}],
 "weekly":[{"wk":"Jul 13 – 19","spend":1679.63,"leads":60,"cpl":27.99,"cpm":15.56,"ctr":1.24,"freq":1.68},
   {"wk":"Jul 20 – 26","spend":1395.87,"leads":60,"cpl":23.26,"cpm":13.93,"ctr":1.30,"freq":1.62},
   {"wk":"Jul 27 – Aug 2","spend":1379.11,"leads":50,"cpl":27.58,"cpm":15.04,"ctr":1.41,"freq":1.60},
   {"wk":"Aug 3 – 9","spend":1496.42,"leads":66,"cpl":22.67,"cpm":14.62,"ctr":1.28,"freq":1.62}],
 "funnel":{"leads":97,"booked":46,"showed":23,"sold":12,"bp":"47%","sp":"50%","cp":"52%","note":"Matured cohort (created ~3 wks ago)."},
 "creatives":{"cols":["Creative","Spend","Leads","CPL","Booked","Sold","$ / sold",""],
   "rows":[{"name":"Video_A","meta":"freq 1.97","c":["$3,804","164","$23.19","67","9","$423"],"tag":["work","Workhorse · 64% spend"]}]}}

Variants:
- PENDING funnel (GHL couldn't page): "funnel":{"pending":true,"pipeline":"Paid Ad Pipeline","stages":"Leads → Booked → Showed → Won","flight":"$X in open deals","note":"Matured funnel populates when GHL pages cleanly; retried and it 422'd."}
- ADS client: NO "funnel"; creatives cols = ["Creative","Status","Spend","Leads","CPL","Freq","CTR",""].
- lowvol (<~8 leads/wk): add "lowvol":true.
- newCampaign: ALWAYS still ship the 4-week "weekly" array (use 0 / null for weeks with no delivery) — build.mjs decides whether the launch note or the real trends win, so never withhold history. Add "newCampaign":true,"launchNote":"...", and "kpis":[{"l":"Spend","fmt":"money0","v":448,"prior":null},{"l":"Leads","fmt":"int","v":5,"prior":null},{"l":"Cost / lead","fmt":"money2","v":89.62,"prior":null},{"l":"CPM","fmt":"money2","v":82.19,"prior":null},{"l":"Link CTR","fmt":"pct2","v":2.18,"prior":null},{"l":"Frequency","fmt":"dec2","v":1.84,"prior":null}].
