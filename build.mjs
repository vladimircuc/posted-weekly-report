// build.mjs — deterministic report generator.
// Reads data.json (raw weekly numbers + agent-written analysis), computes every
// delta / trend / week-over-week figure, injects into template.html, writes report.html.
// NO arithmetic is left to the LLM — the cloud agent only gathers raw data + writes prose.
import { readFileSync, writeFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('./data.json', import.meta.url)));
const tpl  = readFileSync(new URL('./template.html', import.meta.url), 'utf8');

// metric config — KPI + trend order (Spend, Leads, Cost/lead, CPM, CTR, Freq)
const KT = [
  {l:'Spend',       key:'spend', kf:'money0', tf:'money0', dir:'neutral', color:'y',   type:'line'},
  {l:'Leads',       key:'leads', kf:'int',    tf:'int',    dir:'up',      color:'ink', type:'bar'},
  {l:'Cost / lead', key:'cpl',   kf:'money2', tf:'money0', dir:'down',    color:'y',   type:'line'},
  {l:'CPM',         key:'cpm',   kf:'money2', tf:'money0', dir:'down',    color:'y',   type:'line'},
  {l:'Link CTR',    key:'ctr',   kf:'pct2',   tf:'pct2',   dir:'up',      color:'ink', type:'line'},
  {l:'Frequency',   key:'freq',  kf:'dec2',   tf:'dec2',   dir:'down',    color:'ink', type:'line'}
];
// week-over-week column order (Spend, Leads, CPM, CTR, Freq, Cost/lead)
const WOW = [
  {l:'Spend',       key:'spend', f:'money0', dir:'up'},
  {l:'Leads',       key:'leads', f:'int',    dir:'up'},
  {l:'CPM',         key:'cpm',   f:'money2', dir:'down'},
  {l:'Link CTR',    key:'ctr',   f:'pct2',   dir:'up'},
  {l:'Freq',        key:'freq',  f:'dec2',   dir:'down'},
  {l:'Cost / lead', key:'cpl',   f:'money2', dir:'down'}
];
const fmt = {
  money0:v=>v==null?'—':'$'+Math.round(v).toLocaleString('en-US'),
  money2:v=>v==null?'—':'$'+Number(v).toFixed(2),
  int:v=>v==null?'—':String(Math.round(v)),
  pct2:v=>v==null?'—':Number(v).toFixed(2)+'%',
  dec2:v=>v==null?'—':Number(v).toFixed(2)
};
const d1=(v,p)=> (v==null||p==null||p===0)?null : Math.round(((v-p)/p)*1000)/10; // one-decimal %
const di=(v,p)=> (v==null||p==null||p===0)?null : Math.round(((v-p)/p)*100);      // integer %
const shortWk = wk => wk.split(/[–-]/)[0].trim();

function build(c){
  const o = {id:c.id,name:c.name,act:c.act,dot:c.dot,status:c.status||'active',type:c.type,
    chips:c.chips,sub:c.sub,verdict:c.verdict,wins:c.wins,problems:c.problems,
    leadsWk:c.leadsWk,creatives:c.creatives};
  if(c.ghlLoc) o.ghlLoc=c.ghlLoc;
  if(c.ghlPipe) o.ghlPipe=c.ghlPipe;
  if(c.funnel) o.funnel=c.funnel;
  if(c.newCampaign){ o.newCampaign=true; o.launchNote=c.launchNote; o.kpis=c.kpis; return o; }

  const W=c.weekly, last=W[W.length-1], prev=W[W.length-2];
  o.weeks = W.map(w=>shortWk(w.wk));
  o.kpis = KT.map(m=>{
    const k={l:m.l,fmt:m.kf,v:last[m.key],prior:prev[m.key],d:d1(last[m.key],prev[m.key]),dir:m.dir};
    if(c.lowvol && (m.key==='leads'||m.key==='cpl')) k.lowvol=true;
    return k;
  });
  o.trends = KT.map(m=>{
    const t={name:m.l,unit:'/wk',type:m.type,color:m.color,fmt:m.tf,
      data:W.map(w=>w[m.key]==null?null:w[m.key]),d:d1(last[m.key],prev[m.key]),dir:m.dir};
    if(c.lowvol && (m.key==='leads'||m.key==='cpl')) t.lown=true;
    return t;
  });
  o.wow = { cols: WOW.map(m=>[m.l,m.dir]),
    rows: W.map((w,i)=>{
      // null the deltas across a relaunch / near-zero week (e.g. spend jumps >6x)
      const relaunch = i>0 && W[i-1].spend!=null && w.spend!=null && w.spend>0 && (W[i-1].spend/w.spend) < 0.15;
      return { w:w.wk, c: WOW.map(m=>[ fmt[m.f](w[m.key]), (i===0||relaunch)?null:di(w[m.key],W[i-1][m.key]) ]) };
    }) };
  return o;
}

const clients = data.clients.map(build);
const out = tpl.replace('__CLIENTS_DATA__', JSON.stringify(clients));
writeFileSync(new URL('./report.html', import.meta.url), out);
console.log('report.html written —', out.length, 'chars,', clients.length, 'clients, generated', data.generatedUtc);
