// judge.html (DESIGN §5.4): one self-contained page for judging on an iPhone. No external
// requests. Ratings persist in localStorage; "Export" downloads results.json, "Copy" puts it on
// the clipboard, and "Save to Mac" POSTs it back when the page is served by `bamboo-eval serve`.
import type { PageData } from "./blind";

/** JSON safe inside a <script> element. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</gu, "\\u003c");

const CSS = `
:root{--bg:#f6f5f1;--card:#fff;--ink:#1d1d1b;--muted:#6b6a65;--line:#e2e0d8;--accent:#2f7d4f;--accent-ink:#fff;--chip:#efede6}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1f1f1d;--ink:#ecebe6;--muted:#a3a29b;--line:#34332f;--accent:#58b07c;--accent-ink:#0d1a12;--chip:#2a2a27}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;-webkit-text-size-adjust:100%}
header{background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px}
header h1{font-size:17px;margin:0}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px}
.progress{color:var(--muted);font-size:14px;margin-right:auto}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:8px 12px;min-height:40px}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
main{max-width:720px;margin:0 auto;padding:12px 16px 80px}
details.guide{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin-bottom:14px;font-size:15px}
details.guide summary{font-weight:600}
section.q{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin:0 0 18px}
.qhead{color:var(--muted);font-size:13px;text-transform:uppercase;letter-spacing:.04em}
.question{font-weight:600;white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0 12px}
.answer{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}
.answer h3{margin:0 0 6px;font-size:15px}
.text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:16px;line-height:1.6}
.rate{display:grid;grid-template-columns:96px 1fr;gap:6px 8px;align-items:center;margin-top:10px;font-size:14px;color:var(--muted)}
.scale{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}
.scale button{padding:6px 0;min-height:40px;background:var(--chip);border-color:transparent}
.scale button[aria-pressed=true]{background:var(--accent);color:var(--accent-ink)}
.prefer{margin-top:10px;width:100%}
.prefer[aria-pressed=true]{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.done .qhead::after{content:" ✓";color:var(--accent)}
#status{font-size:13px;color:var(--muted);width:100%}
textarea{width:100%;height:120px;font:12px ui-monospace,monospace;margin-top:6px}
`;

const SCRIPT = `
(function(){
var DATA=JSON.parse(document.getElementById("data").textContent);
var KEY="bamboo-tutor-eval:"+DATA.run_id;
var state={questions:{}};
try{var saved=localStorage.getItem(KEY);if(saved)state=JSON.parse(saved)||state;}catch(e){}
if(!state.questions)state.questions={};
function save(){try{localStorage.setItem(KEY,JSON.stringify(state));}catch(e){}}
function q(id){return state.questions[id]||(state.questions[id]={ratings:{},preferred:null});}
function el(tag,attrs,kids){var n=document.createElement(tag);for(var k in attrs||{}){if(k==="text")n.textContent=attrs[k];else n.setAttribute(k,attrs[k]);}(kids||[]).forEach(function(c){n.appendChild(c);});return n;}
var main=document.getElementById("questions");
var total=DATA.questions.length;
function complete(item){var s=state.questions[item.id];if(!s||!s.preferred)return false;return item.answers.every(function(a){var r=s.ratings[a.label];return r&&r.accuracy&&r.naturalness;});}
function refresh(){var n=0;DATA.questions.forEach(function(item){var ok=complete(item);if(ok)n++;var sec=document.getElementById(item.id);if(sec)sec.classList.toggle("done",ok);});document.getElementById("progress").textContent=n+" of "+total+" questions fully rated";}
function scale(item,label,field){var box=el("div",{class:"scale",role:"group"});for(var v=1;v<=5;v++){(function(v){var b=el("button",{type:"button","aria-pressed":"false","aria-label":field+" "+v,text:String(v)});var r=(state.questions[item.id]||{ratings:{}}).ratings[label];if(r&&r[field]===v)b.setAttribute("aria-pressed","true");b.addEventListener("click",function(){var s=q(item.id);var cur=s.ratings[label]||(s.ratings[label]={});cur[field]=cur[field]===v?null:v;Array.prototype.forEach.call(box.children,function(c,i){c.setAttribute("aria-pressed",String(cur[field]===i+1));});save();refresh();});box.appendChild(b);})(v);}return box;}
DATA.questions.forEach(function(item,qi){
  var sec=el("section",{class:"q",id:item.id});
  sec.appendChild(el("div",{class:"qhead",text:"Question "+(qi+1)+" of "+total}));
  sec.appendChild(el("div",{class:"question",text:item.question}));
  var prefButtons=[];
  item.answers.forEach(function(a){
    var box=el("div",{class:"answer"});
    box.appendChild(el("h3",{text:"Answer "+a.label}));
    box.appendChild(el("div",{class:"text",lang:"zh-CN",text:a.text}));
    var rate=el("div",{class:"rate"});
    rate.appendChild(el("span",{text:"Accuracy"}));rate.appendChild(scale(item,a.label,"accuracy"));
    rate.appendChild(el("span",{text:"Natural"}));rate.appendChild(scale(item,a.label,"naturalness"));
    box.appendChild(rate);
    var p=el("button",{type:"button",class:"prefer","aria-pressed":String((state.questions[item.id]||{}).preferred===a.label),text:"Prefer "+a.label});
    p.addEventListener("click",function(){var s=q(item.id);s.preferred=s.preferred===a.label?null:a.label;prefButtons.forEach(function(x){x.b.setAttribute("aria-pressed",String(s.preferred===x.label));});save();refresh();});
    prefButtons.push({b:p,label:a.label});
    box.appendChild(p);
    sec.appendChild(box);
  });
  main.appendChild(sec);
});
function exported(){return JSON.stringify({run_id:DATA.run_id,exported_at:new Date().toISOString(),questions:state.questions},null,2);}
var status=document.getElementById("status");
document.getElementById("export").addEventListener("click",function(){var blob=new Blob([exported()],{type:"application/json"});var url=URL.createObjectURL(blob);var a=el("a",{href:url,download:"results-"+DATA.run_id+".json"});document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url);},5000);status.textContent="Downloaded results-"+DATA.run_id+".json";});
document.getElementById("copy").addEventListener("click",function(){var text=exported();function fallback(){var t=document.getElementById("fallback");t.hidden=false;t.value=text;t.select();status.textContent="Select all and copy the text below.";}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){status.textContent="Copied the results JSON.";},fallback);}else fallback();});
var saveBtn=document.getElementById("save");
if(location.protocol==="http:"||location.protocol==="https:"){saveBtn.hidden=false;saveBtn.addEventListener("click",function(){fetch("results",{method:"POST",headers:{"content-type":"application/json"},body:exported()}).then(function(r){status.textContent=r.ok?"Saved on the Mac.":"Save failed ("+r.status+"); use Export.";},function(){status.textContent="Couldn't reach the Mac; use Export.";});});}
refresh();
})();
`;

export function renderJudgeHtml(page: PageData): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Tutor answers, blind</title>
<style>${CSS}</style>
</head>
<body>
<header>
<h1>Tutor answers, blind</h1>
<div class="bar">
<span class="progress" id="progress"></span>
<button type="button" id="save" class="primary" hidden>Save to Mac</button>
<button type="button" id="export" class="primary">Export</button>
<button type="button" id="copy">Copy</button>
<div id="status" role="status"></div>
</div>
<textarea id="fallback" hidden readonly></textarea>
</header>
<main>
<details class="guide">
<summary>How to rate</summary>
<p>Each question shows the answers in random order. Rate every answer 1–5 on both scales, then
tap <b>Prefer</b> on the one you'd rather have had. Tap a number again to clear it.</p>
<p><b>Accuracy</b>: is the Mandarin correct (hanzi, pinyin, meaning), and does the breakdown
explain it right? 5 = no mistakes; 3 = a mistake that would confuse you; 1 = wrong.</p>
<p><b>Natural</b>: would a native speaker actually say this to the yuesao, the nanny or your
toddler? 5 = exactly what they'd say; 3 = understandable but stiff; 1 = nobody says that.</p>
<p>Ratings stay on this phone until you clear Safari's data. When you're done, tap
<b>Export</b> (or <b>Save to Mac</b>) and send the file back.</p>
</details>
<div id="questions"></div>
</main>
<script id="data" type="application/json">${scriptJson(page)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
