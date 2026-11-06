/** Standalone, offline view of the recorded measurements; no new timing or inferred samples. */
import { readFile, writeFile } from "node:fs/promises";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("visualize.ts EVIDENCE_JSON OUTPUT_HTML");
const evidence = JSON.parse(await readFile(input, "utf8"));
const data = JSON.stringify(evidence.measurements.summary).replaceAll("<", "\\u003c");
await writeFile(
	output,
	`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Complete retained Game Text: Bun SQLite and Rust</title>
<style>
:root{font-family:var(--font-sans,system-ui);color:var(--foreground);font-size:14px}
html,body{margin:0}*{box-sizing:border-box}p{line-height:1.5;margin:0 0 14px}
.controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
select{font:inherit;color:var(--foreground);background:var(--secondary);border:1px solid var(--border);border-radius:var(--radius,6px);padding:6px}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px}.key{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}
.rust{background:var(--chart-1)}.bun{background:var(--chart-2)}svg{display:block;width:100%;height:365px;overflow:visible}
svg text{font-family:var(--font-sans,system-ui);fill:var(--foreground);font-size:12px}.axis{fill:var(--muted-foreground)}
.note{font-size:12px;color:var(--muted-foreground)}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:12px}
td,th{text-align:right;padding:8px 4px;border-bottom:1px solid var(--border)}td:first-child,th:first-child{text-align:left;overflow-wrap:anywhere}
summary{cursor:pointer;margin:14px 0}button{font:inherit}details{margin-top:12px}
</style></head><body>
<p><strong>583,507 localization lines · 583,798 units · 10 cultures.</strong> Complete response payloads from the shipping Rust host and direct Bun SQLite. Lower latency is better.</p>
<div class="controls"><label>Show <select id="group"><option value="representative">Representative operations</option><option value="rows">Pages and continuation</option><option value="search">Search, facets and groups</option><option value="bulk">Bulk reads and aggregate</option></select></label></div>
<div class="legend"><span><i class="key rust"></i>Rust public host</span><span><i class="key bun"></i>Bun SQLite</span><span>Median milliseconds · logarithmic axis</span></div>
<svg id="plot" viewBox="0 0 720 365" role="img" aria-label="Query latency comparison"></svg>
<p class="note">${evidence.measurements.methodology.independentProcessesPerLane * evidence.measurements.methodology.repetitions} timed observations per operation and path: ${evidence.measurements.methodology.independentProcessesPerLane} fresh processes × ${evidence.measurements.methodology.repetitions} repetitions, after one checked warmup per case. Whiskers show the observed minimum and maximum. OS caches were not flushed. Each timed answer matched its native expected hash.</p>
<p class="note">These are complete application paths. Rust includes its current TypeScript response decoding; Bun hydrates sealed relational records. Common native preparation is outside the comparison. The SQLite pilot covers retained reads, with product capabilities still missing.</p>
<details><summary>All ${evidence.measurements.summary.length / 2} measured operations and ranges</summary><table><thead><tr><th>Operation</th><th>Rust ms<br>median [min–max]</th><th>Bun ms<br>median [min–max]</th></tr></thead><tbody id="all"></tbody></table></details>
<script>
const data=${data};
const names=[...new Set(data.map(x=>x.name))];
const representative=['source/rows/first50','target/rows/first50','target/search/first50','target/rows/first5000','target/search/selective-text','target/all-fields-picked-1000','target/identity-source','aggregate/culture+state'];
const labels={'source/rows/first50':'Source page · 50','target/rows/first50':'Target page · 50','target/search/first50':'Target page + facets · 50','target/rows/first5000':'Target page · 5,000','target/search/selective-text':'Selective target search','target/all-fields-picked-1000':'All fields · 1,000 lines','target/identity-source':'Identity/source · all lines','aggregate/culture+state':'Culture × state aggregate'};
const fmt=n=>n<1?n.toFixed(2):n<100?n.toFixed(1):Math.round(n).toLocaleString();
const svg=document.getElementById('plot'),ns='http://www.w3.org/2000/svg';
function add(tag,attrs,text){const el=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);if(text!==undefined)el.textContent=text;svg.append(el);return el}
function draw(){
 const group=document.getElementById('group').value;
 const shown=names.filter(n=>group==='representative'?representative.includes(n):group==='rows'?n.includes('/rows/'):group==='search'?n.includes('/search/')||n.includes('/group/')||n.includes('/culture/')||n.includes('/translations/'):n.startsWith('aggregate/')||n.includes('fields')||n.includes('identity-source'));
 const rows=shown.map(n=>({name:n,rust:data.find(x=>x.name===n&&x.lane==='rust'),bun:data.find(x=>x.name===n&&x.lane==='bun')}));
 const values=rows.flatMap(r=>[r.rust.minMs,r.rust.maxMs,r.bun.minMs,r.bun.maxMs]);
 const lo=Math.floor(Math.log10(Math.max(.001,Math.min(...values)))),hi=Math.ceil(Math.log10(Math.max(...values)));
 const width=svg.clientWidth;svg.setAttribute('viewBox','0 0 '+width+' 365');
 const left=Math.min(240,width*.48),right=width-24,top=20,step=310/rows.length,x=n=>left+(Math.log10(Math.max(.001,n))-lo)/(hi-lo||1)*(right-left);
 svg.replaceChildren();
 for(let p=lo;p<=hi;p++){const at=x(10**p);add('line',{x1:at,x2:at,y1:8,y2:330,stroke:'var(--border)'});add('text',{x:at,y:353,'text-anchor':'middle',class:'axis'},fmt(10**p));}
 rows.forEach((r,i)=>{const y=top+i*step+step/2,label=labels[r.name]||r.name.replace('source/','S · ').replace('target/','T · '),limit=Math.floor((left-12)/6);add('text',{x:0,y:y+4},label.length>limit?label.slice(0,limit-1)+'…':label);
 for(const [lane,dy,color] of [['rust',-4,'var(--chart-1)'],['bun',4,'var(--chart-2)']]){const d=r[lane];add('line',{x1:x(d.minMs),x2:x(d.maxMs),y1:y+dy,y2:y+dy,stroke:color,'stroke-width':2});const dot=add('circle',{cx:x(d.medianMs),cy:y+dy,r:4,fill:color});const title=document.createElementNS(ns,'title');title.textContent=lane+': '+fmt(d.medianMs)+' ms ['+fmt(d.minMs)+'–'+fmt(d.maxMs)+'], n='+d.n;dot.append(title);}
 });
}
for(const name of names){const tr=document.createElement('tr');for(const text of [name,...['rust','bun'].map(l=>{const d=data.find(x=>x.name===name&&x.lane===l);return fmt(d.medianMs)+' ['+fmt(d.minMs)+'–'+fmt(d.maxMs)+']';})]){const td=document.createElement('td');td.textContent=text;tr.append(td)}document.getElementById('all').append(tr)}
document.getElementById('group').addEventListener('change',draw);draw();
window.addEventListener('resize',draw);
</script></body></html>`
);
