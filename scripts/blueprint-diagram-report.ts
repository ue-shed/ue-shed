export interface BlueprintDiagramExample {
	id: string;
	label: string;
	direct: { svg: string; width: number; height: number };
	pele: { svg: string; width: number; height: number };
	overview: { svg: string; width: number; height: number };
	text: string;
	mermaid: string;
	counts: { nodes: number; pins: number; links: number };
}

/** Standalone research artifact; this does not style or mount the maintained Blueprint viewer. */
export function blueprintDiagramReport(
	examples: readonly BlueprintDiagramExample[],
	caption = "Actual saved BP_ReviewFixture graphs. Saved positions are retained; reference cards can overlap. Specialized Unreal node geometry and automatic layout remain unfinished."
): string {
	const data = JSON.stringify(examples).replace(/</gu, "\\u003c");
	const safeCaption = caption.replace(/[&<>]/gu, (value) =>
		value === "&" ? "&amp;" : value === "<" ? "&lt;" : "&gt;"
	);
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Saved Blueprint diagram experiment</title>
<style>
*{box-sizing:border-box}body{margin:0;font:14px/1.5 var(--font-sans,system-ui);color:var(--foreground,#e3e5ec)}
.controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 12px}
button,select{font:inherit;border:1px solid var(--border,#525d70);border-radius:7px;background:var(--card,#20242c);color:inherit;padding:7px 10px}
button{cursor:pointer}button[aria-pressed="true"]{background:var(--accent-surface,#263f60);border-color:var(--accent,#70a5ec)}
.controls label{max-width:100%;display:flex;align-items:center;gap:6px}.controls select{min-width:0;max-width:100%}
button:focus-visible,select:focus-visible,summary:focus-visible,input:focus-visible{outline:2px solid var(--ring,#70a5ec);outline-offset:3px}
.stage{height:340px;overflow:auto;border:1px solid var(--border,#525d70);border-radius:var(--radius,10px);background:var(--card,#181d25);cursor:grab;--bp-card:var(--card,#20242c);--bp-fg:var(--foreground,#e3e5ec);--bp-exec:var(--foreground,#dddfe7);--bp-border:var(--border,#626c80)}
.stage.dragging{cursor:grabbing}.stage svg{display:block;width:100%;height:auto;max-width:none}
.tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px;color:var(--muted-foreground,#a9b0be);font-size:12px}
.tools label{display:flex;gap:6px;align-items:center}.tools input{max-width:110px}
.copy{margin:12px 0 8px}.note{color:var(--muted-foreground,#a9b0be);font-size:12px;margin:8px 0 12px}
summary{cursor:pointer;color:var(--muted-foreground,#a9b0be);font-size:12px}pre{font:11px/1.6 var(--font-mono,monospace);background:var(--code-background,#181d25);color:var(--code-foreground,#ddd);padding:16px;border-radius:var(--radius,10px);overflow:auto;max-height:260px;margin:8px 0}
#counts{font-variant-numeric:tabular-nums}
</style></head><body>
<div class="controls"><label>Source <select id="engine" aria-label="Source graph"></select></label></div>
<div class="controls" role="group" aria-label="Renderer">
<button data-mode="direct" aria-pressed="true">Direct SVG</button>
<button data-mode="pele" aria-pressed="false">Pele + Blueprint adapter</button>
<button data-mode="overview" aria-pressed="false">Stock Pele / Mermaid</button>
</div>
<div id="stage" class="stage" tabindex="0" role="region" aria-label="Saved Blueprint diagram, drag or scroll to explore"><div id="drawing"></div></div>
<div class="tools"><label>Zoom <input id="zoom" type="range" min="1" max="140" value="75" step="1"><output id="zoomValue">75%</output></label><button id="fit">Fit</button><span>Drag or scroll to explore</span><span id="counts"></span></div>
<p class="copy" id="description"></p>
<p class="note">${safeCaption}</p>
<details><summary id="syntaxTitle">Inspect the exported text</summary><pre id="syntax"></pre></details>
<p class="note">Pele 1.6.0 · one runtime detector patch · the Blueprint parser and pin renderer belong to this experiment. The custom text retains native metadata in JSON tails to test fidelity; it is not a finished authoring language.</p>
<script>
const examples=${data};
const engine=document.getElementById('engine'),stage=document.getElementById('stage'),drawing=document.getElementById('drawing'),zoom=document.getElementById('zoom');
let mode='direct';
examples.forEach((example,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=example.label;engine.append(option)});
function render(){
 const example=examples[Number(engine.value)],result=example[mode],scale=Number(zoom.value)/100;
 drawing.innerHTML=result.svg;drawing.style.width=result.width*scale+'px';
 document.getElementById('zoomValue').textContent=zoom.value+'%';
 document.getElementById('syntax').textContent=mode==='overview'?example.mermaid:example.text;
 document.getElementById('description').textContent=mode==='overview'
  ?'Unmodified Pele renders a standard Mermaid overview. Pin names are edge labels; its layout chooses where wires meet nodes.'
  :mode==='pele'
  ?'The disposable Pele fork recognizes blueprint v1 and calls our parser and SVG renderer. The output is identical to Direct SVG.'
  :'The headless Blueprint helpers supply saved node positions, pin anchors, and wire paths. This SVG is generated directly, without Pele.';
 const svg=drawing.querySelector('svg');
 document.getElementById('counts').textContent=mode==='overview'?'Node-level overview':svg.querySelectorAll('[data-node-id]').length+' nodes · '+svg.querySelectorAll('[data-pin-id]').length+' pins · '+svg.querySelectorAll('[data-from]').length+' wires';
 document.querySelectorAll('[data-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.mode===mode)));
}
document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>{mode=button.dataset.mode;render()}));
engine.addEventListener('change',render);zoom.addEventListener('input',render);
document.getElementById('fit').addEventListener('click',()=>{const result=examples[Number(engine.value)][mode];zoom.value=String(Math.max(1,Math.min(140,Math.floor(Math.min(stage.clientWidth/result.width,stage.clientHeight/result.height)*100))));render();stage.scrollTo(0,0)});
let dragging;
stage.addEventListener('pointerdown',event=>{if(event.button!==0)return;dragging={x:event.clientX,y:event.clientY,left:stage.scrollLeft,top:stage.scrollTop};stage.setPointerCapture(event.pointerId);stage.classList.add('dragging')});
stage.addEventListener('pointermove',event=>{if(dragging){stage.scrollLeft=dragging.left+dragging.x-event.clientX;stage.scrollTop=dragging.top+dragging.y-event.clientY}});
function stop(){dragging=undefined;stage.classList.remove('dragging')}
stage.addEventListener('pointerup',stop);stage.addEventListener('pointercancel',stop);
for(let index=0;index<examples.length;index++){
 engine.value=String(index);
 for(const candidate of ['direct','pele','overview']){
  mode=candidate;render();
  if(!drawing.querySelector('svg'))throw new Error('Missing SVG');
  if(candidate!=='overview'&&drawing.querySelectorAll('[data-pin-id]').length!==examples[index].counts.pins)throw new Error('Source pin count changed');
  if(document.querySelectorAll('[aria-pressed="true"]').length!==1)throw new Error('Renderer selection mismatch');
 }
}
engine.value='0';mode='direct';render();
console.log('Checked '+examples.length+' source graphs × 3 renderer modes; SVG and pin counts passed.');
</script></body></html>`;
}
