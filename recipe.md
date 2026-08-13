# Weekly Ads Report — generation recipe (generic)

You generate an internal Monday ads report, headless in the cloud. This repo (cloned into your workspace)
holds `template.html` + `build.mjs`. **The runner message supplies the client roster, the per-pipeline
stage mappings, the campaign-scoped account, the publish URL, and the Slack channel** — this file is the
generic method. Produce `data.json`, run `node build.mjs` (writes `report.html`), publish it, notify Slack.
Everything is READ-ONLY except the final publish + Slack post. If one account fails, degrade and KEEP GOING
— a partial report that ships beats a perfect one that doesn't. Do NOT compute any percentages yourself;
`build.mjs` computes every delta/trend/week-over-week figure from the raw `weekly` arrays.

## 0. Dates (compute fresh)
Report covers the **last completed Mon–Sun week**. Run `date`. LAST_SUN = most recent Sunday; the four
weekly buckets = the 4 completed weeks ending LAST_SUN. Weekly Meta pull: one call, `time_increment:"7"`,
`time_range:{since:LAST_SUN-27d, until:LAST_SUN}` → 4 rows oldest→newest, label "Mon D – D".
30d = `date_preset:"last_30d"`; prior-30d = the 30 days before that (for the verdict's MoM facts).

## 1. Roster
The runner lists every account: `id, name, Meta act (numeric), type (pipeline|ads), GHL location, GHL
pipeline id`. One account is **campaign-scoped** — for it, add `level:"campaign"` and
`filtering:[{"field":"campaign.id","operator":"IN","value":["<CAMPAIGN_ID from runner>"]}]` to EVERY Meta
call, and never report the whole account. If a campaign has <2 completed weeks of delivery, mark it
`newCampaign:true` (see Appendix).

## 2. Meta pulls per account — `mcp__Meta_Ads__ads_get_ad_entities` (+ insight tools)
Load via ToolSearch. For each account (`level:"ad_account"`, or campaign-scoped as above):
1. Weekly — `time_range:{since,until}`, `time_increment:"7"`, fields `["amount_spent","impressions","clicks","ctr","cpc","cpm","reach","frequency","lead","cost_per_lead"]` → 4 rows.
2. 30d — `date_preset:"last_30d"`; 3. Prior-30d — `time_range` of the previous 30 days (same fields).
4. Creatives — `level:"ad"`, `time_range` last ~30d, `sort:"amount_spent_descending"`, `limit:12`, fields incl `effective_status`.
5. `ads_get_opportunity_score`, `ads_insights_anomaly_signal`, `ads_insights_auction_ranking_benchmarks`(last_7d), `ads_insights_industry_benchmark`(last_30d, CPR), `ads_get_errors`([act]).
Parse strings: `"$1,234.56 USD"`→1234.56, `"1.30%"`→1.30, `"Not available"`→null. For the CPR benchmark, "below benchmark" = cheaper than peers = GOOD.

## 3. GHL (pipeline clients only) — `mcp__GHL_MCP__execute_operation`
- `get-pipelines` for the location to confirm the pipeline id.
- `search-opportunity`, params EXACTLY `{"query":{"pipelineId":"<id>","date":"<45d ago mm-dd-yyyy>","endDate":"<today mm-dd-yyyy>","status":"all","limit":100,"order":"added_desc"}}`. Page 2–3 if `meta.total>100`. Large → save to file, parse with python.
- **RETRY:** on HTTP 422 `"property 0..N should not exist"`, RETRY the same call up to 4× (flaky; usually succeeds). If it still fails, or returns only ~20 location-wide records, STOP and set that client's `funnel` to the pending shape (Appendix). NEVER let GHL abort the run.
- If it works: matured-cohort funnel = opps created ~3–4 wks ago bucketed by current stage, mapped to Leads→Booked→Showed→Sold **using the per-pipeline stage mapping the runner provides**. Join creatives via `attributions[].utmAdId` for cost-per-sold. Emit numeric `funnel:{leads,booked,showed,sold,bp,sp,cp,note}`.

## 4. data.json schema
`{generatedUtc, reportingWeek, clients:[...]}`. Each client: identity (`id,name,act:"act_<num>",dot(ok|warn|bad|off),status,type,chips,sub,leadsWk`); pipeline clients add `ghlLoc,ghlPipe,funnel`(numeric or pending); **`weekly`**: 4 × `{wk,spend,leads,cpl,cpm,ctr,freq}` raw (null for N/A); `lowvol:true` if <~8 leads/wk; `creatives:{cols,rows}`; narrative `verdict:{tone,html}`, `wins:[{t,b,s}]`, `problems:[{tone,t,b,fix,s}]`. `newCampaign:true` clients give `kpis`(v+`prior:null`)+`launchNote` instead of `weekly`.

## 5. Narrative (the point of the report)
Verdict = one honest decision-sentence, not a restatement of tiles; set `tone`+`dot` to match. wins/problems must say what you couldn't read off the numbers; every problem names a specific entity + a concrete **fix**. Cost metrics: down=good. Never call a trend on 1–3 leads (that's `lowvol`). Be willing to be unflattering about our own work.

## 6. Build → publish → notify
1. Write `data.json`; run `node build.mjs`. Fix JSON + rerun if it errors.
2. Publish `report.html` with the Artifact tool: `file_path:"report.html"`, `url:"<REPORT_URL from runner>"`, `title:"Posted — Monday Ads Review"`, favicon a chart-decreasing emoji. Capture PAGE_URL.
3. Slack — load `mcp__Slack__slack_send_message`, post to `<SLACK_CHANNEL from runner>`, message starting with `<!channel>`: `<!channel> ✅ Weekly Ads Review — week of <reportingWeek>. <one line, e.g. "1 needs work (X), 3 to watch, rest healthy">. Report: PAGE_URL`
4. Fire a PushNotification (short summary + same one-liner).
5. Print a run summary: accounts pulled cleanly, GHL funnels that went pending, PAGE_URL, Slack result.

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
- newCampaign: OMIT "weekly"; add "newCampaign":true,"launchNote":"...", and "kpis":[{"l":"Spend","fmt":"money0","v":448,"prior":null},{"l":"Leads","fmt":"int","v":5,"prior":null},{"l":"Cost / lead","fmt":"money2","v":89.62,"prior":null},{"l":"CPM","fmt":"money2","v":82.19,"prior":null},{"l":"Link CTR","fmt":"pct2","v":2.18,"prior":null},{"l":"Frequency","fmt":"dec2","v":1.84,"prior":null}].
