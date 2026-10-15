// SVG line and bar charts for the match observatory. Series with opponent:true draw in the dashed --chart-jev
// style and the rest in solid --chart-human (orchestrator decision D8); every label is ink.
export const number=n=>Number.isFinite(n)?Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(n):'—';
export const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
const svgNS='http://www.w3.org/2000/svg';
function svgNode(tag,attributes={},text){const e=document.createElementNS(svgNS,tag);for(const [k,v]of Object.entries(attributes))e.setAttribute(k,v);if(text!==undefined)e.textContent=text;return e;}
export function chart(target,series,label,bars=false){
  target.replaceChildren();const values=series.flatMap(s=>s.values).filter(Number.isFinite);
  if(!values.length){const empty=document.createElement('div');empty.className='empty-chart';empty.textContent='Metrics appear as the game progresses.';target.append(empty);return;}
  const svg=svgNode('svg',{viewBox:`0 0 500 ${series.length>1?192:180}`,role:'img','aria-label':label});svg.append(svgNode('title',{},label));
  let min=Math.min(0,...values),max=Math.max(1,...values);if(min===max)max=min+1;
  // The y-axis labels are right-aligned against the plot (text-anchor end), with room for '-1,025' or '1,231.9'.
  const left=72,width=500-left-13,height=125,top=12,y=v=>top+height-(v-min)/(max-min)*height;
  for(let i=0;i<4;i++){const value=min+(max-min)*i/3;svg.append(svgNode('line',{x1:left,x2:left+width,y1:y(value),y2:y(value),class:'grid-line'}),svgNode('text',{x:left-6,y:y(value)+5,'text-anchor':'end'},number(value)));}
  for(const [s,entry]of series.entries()){
    const n=entry.values.length,x=i=>left+(n>1?i/(n-1):.5)*width;
    if(bars){const step=width/Math.max(1,n);entry.values.forEach((v,i)=>{const bar=svgNode('rect',{x:left+i*step+2,y:y(v),width:Math.max(1,step-4),height:Math.max(1,y(0)-y(v)),class:`bar${entry.opponent?' secondary':''}`});bar.append(svgNode('title',{},`${entry.name} ${i+1}: ${number(v)}`));svg.append(bar);});}
    else{const p=entry.values.map((v,i)=>`${i?'L':'M'}${x(i)},${y(v)}`).join(' ');svg.append(svgNode('path',{d:p,class:`chart-line${entry.opponent?' secondary':''}`}));if(n===1)svg.append(svgNode('circle',{cx:x(0),cy:y(entry.values[0]),r:3,class:`bar${entry.opponent?' secondary':''}`}));}
    // Legend: a swatch drawn like its series (solid, dashed or a bar) so colour is not the only cue; the label is ink.
    // One legend row per series: chart text is 15 user units (readable at about 9px when the chart is 300px wide).
    const lx=left,ly=156+s*18;svg.append(bars?svgNode('rect',{x:lx,y:ly-10,width:12,height:10,class:`bar legend-swatch${entry.opponent?' secondary':''}`}):svgNode('line',{x1:lx,x2:lx+22,y1:ly-4,y2:ly-4,class:`chart-line legend-swatch${entry.opponent?' secondary':''}`}),svgNode('text',{x:lx+(bars?18:28),y:ly},`${entry.name} · ${plural(entry.values.length,'observation')}`));
  }target.append(svg);
}
