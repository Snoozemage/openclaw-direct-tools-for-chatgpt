const $=id=>document.getElementById(id);
let events=[],sessions=[],selectedEvent=null,selectedSession="all",source=null,reconnectPending=false,followLatest=true;
let blockValues=Object.create(null),blockModes=Object.create(null),blockDepths=Object.create(null),diffModes=Object.create(null),manualDiffModes=Object.create(null);
function fmtTime(v){try{return v?new Date(v).toLocaleTimeString():"-"}catch{return "-"}}
function pretty(v){return typeof v==="string"?v:JSON.stringify(v,null,2)}
function rawValue(v){return v==null?"(empty)":pretty(v)}
function structuredValue(v){
  if(v&&typeof v==="object")return v;
  if(typeof v==="string"){try{const parsed=JSON.parse(v);if(parsed!==null&&typeof parsed==="object")return parsed}catch{}}
  return null;
}
function unifiedDiffText(value,depth=0){
  if(depth>8||value==null)return null;
  if(typeof value==="string"){
    if(value.length>250000)return null;
    const gitIndex=value.search(/^diff --git /m);
    const fileHeader=value.match(/^--- .+\r?\n\+\+\+ .+/m);
    const start=gitIndex>=0?gitIndex:(fileHeader?.index??-1);
    if(start<0)return null;
    const candidate=value.slice(start).replace(/\r?\n\s*\(Command exited with (?:code|signal)[^)]+\)\s*$/,"").trimEnd();
    return ((/^diff --git /m.test(candidate)||/^--- .+\r?\n\+\+\+ .+/m.test(candidate))&&/^@@ [-+]/m.test(candidate))?candidate:null;
  }
  if(Array.isArray(value)){
    for(const item of value){const diff=unifiedDiffText(item,depth+1);if(diff)return diff}
    return null;
  }
  if(typeof value==="object"){
    for(const key of ["patch","diff","output","result","content"]){
      if(key in value){const diff=unifiedDiffText(value[key],depth+1);if(diff)return diff}
    }
    for(const item of Object.values(value)){const diff=unifiedDiffText(item,depth+1);if(diff)return diff}
  }
  return null;
}
const FILE_MUTATION_TOOLS=new Set(["openclaw_edit","openclaw_write","openclaw_apply_patch"]);
function structuredPatchDiffText(value,depth=0){
  if(depth>8||value==null)return null;
  if(Array.isArray(value)){
    for(const item of value){const diff=structuredPatchDiffText(item,depth+1);if(diff)return diff}
    return null;
  }
  if(typeof value!=="object")return null;
  for(const key of ["patch","diff"]){
    if(key in value){const diff=unifiedDiffText(value[key],depth+1);if(diff)return diff}
  }
  for(const item of Object.values(value)){
    if(item&&typeof item==="object"){const diff=structuredPatchDiffText(item,depth+1);if(diff)return diff}
  }
  return null;
}
function outputDiffText(value,tool){
  return FILE_MUTATION_TOOLS.has(tool)?unifiedDiffText(value):structuredPatchDiffText(value);
}
function isUnifiedDiff(value){return unifiedDiffText(value)!==null;}
function payloadMode(key,value,structured=structuredValue(value),diff=key==="output"?outputDiffText(value,events.find(x=>x.id===selectedEvent)?.tool)!==null:isUnifiedDiff(value)){
  if(diff)return diffMode(key);
  if(structured!==null)return blockModes[key]==="raw"?"raw":"tree";
  return "raw";
}
function diffMode(key){return diffModes[key]==="line-by-line"?"line-by-line":"side-by-side"}
function syncDiffHorizontalScroll(body){
  const panes=[...body.querySelectorAll(".d2h-file-side-diff")];
  if(panes.length<2)return;
  let syncing=false;
  const maxScroll= pane=>Math.max(0,pane.scrollWidth-pane.clientWidth);
  panes.forEach(pane=>pane.addEventListener("scroll",()=>{
    if(syncing)return;
    syncing=true;
    const max=maxScroll(pane);
    const progress=max?pane.scrollLeft/max:0;
    for(const other of panes){
      if(other===pane)continue;
      const target=Math.round(progress*maxScroll(other));
      if(Math.abs(other.scrollLeft-target)>1)other.scrollLeft=target;
    }
    syncing=false;
  },{passive:true}));
}
function statusLabel(s){return s==="success"?"Success":s==="error"?"Error":s==="running"?"Running":"Queued"}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function copyIcon(){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>'}
function checkIcon(){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>'}
function block(label,key){
  const value=blockValues[key],structured=structuredValue(value),tool=events.find(x=>x.id===selectedEvent)?.tool;
  const autoDiffText=key==="output"?outputDiffText(value,tool):null;
  const rawDiffText=key==="output"&&autoDiffText===null?unifiedDiffText(value):null;
  const manualDiff=rawDiffText!==null&&manualDiffModes[selectedEvent]===true;
  const diff=autoDiffText!==null||manualDiff,mode=payloadMode(key,value,structured,diff);
  const viewButton=structured!==null&&!diff?'<button class="action" type="button" data-view-block="'+key+'">'+(mode==="raw"?"Tree view":"Raw text")+'</button>':"";
  const depthButton=structured!==null&&!diff&&mode!=="raw"?'<button class="action" type="button" data-depth-block="'+key+'">'+((blockDepths[key]||1)>1?"Collapse":"Expand deeper")+'</button>':"";
  const diffButton=diff?'<button class="action" type="button" data-diff-mode="'+key+'">'+(mode==="side-by-side"?"Inline":"Side by side")+'</button>':"";
  const manualDiffButton=manualDiff?'<button class="action" type="button" data-raw-output="'+key+'">Raw output</button>':rawDiffText!==null?'<button class="action" type="button" data-open-diff="'+key+'">View diff</button>':"";
  return '<div class="section"><div class="block-head"><div class="label">'+esc(label)+'</div><div class="block-actions">'+viewButton+depthButton+diffButton+manualDiffButton+'</div></div><div class="payload-body" id="payload-'+key+'"></div></div>';
}
function renderBlock(key){
  const body=$("payload-"+key);if(!body)return;
  const value=blockValues[key],structured=structuredValue(value),tool=events.find(x=>x.id===selectedEvent)?.tool,autoDiffText=key==="output"?outputDiffText(value,tool):null,rawDiffText=key==="output"&&autoDiffText===null?unifiedDiffText(value):null,diffText=autoDiffText??(rawDiffText!==null&&manualDiffModes[selectedEvent]===true?rawDiffText:null),diff=diffText!==null;
  const mode=payloadMode(key,value,structured,diff);
  body.replaceChildren();
  if(diff&&window.Diff2Html&&typeof window.Diff2Html.html==="function"){
    body.innerHTML=window.Diff2Html.html(diffText,{drawFileList:false,matching:"lines",outputFormat:mode,colorScheme:"dark"});
    if(mode==="side-by-side")syncDiffHorizontalScroll(body);
    return;
  }
  if(structured!==null&&mode!=="raw"&&typeof window.JSONFormatter==="function"){
    const formatter=new window.JSONFormatter(structured,blockDepths[key]||1,{theme:"dark",hoverPreviewEnabled:true,hoverPreviewArrayCount:10,hoverPreviewFieldCount:4,animateOpen:false,maxArrayItems:40,exposePath:true});
    body.appendChild(formatter.render());
    return;
  }
  const pre=document.createElement("pre");pre.textContent=rawValue(value);body.appendChild(pre);
}
async function copyWithFeedback(button,text){
  const previousTitle=button.title;
  try{
    await copyText(text);
    button.innerHTML=checkIcon();button.title="Copied";button.disabled=true;
    window.setTimeout(()=>{if(!button.isConnected)return;button.innerHTML=copyIcon();button.title=previousTitle;button.disabled=false},900);
  }catch(error){$("connection").textContent="Could not copy: "+error.message}
}
function currentStatus(session){return Date.now()-Number(session.lastSeenAt)<30000?"active":"inactive"}
function upsertSession(session){if(!session||!session.id)return;const index=sessions.findIndex(item=>item.id===session.id);if(index<0)sessions.push(session);else sessions[index]={...sessions[index],...session};sessions.sort((a,b)=>Number(b.lastSeenAt)-Number(a.lastSeenAt));renderSessions()}
function renderSessions(){
  const chatButtons='<button class="session-card '+(selectedSession==="all"?"selected":"")+'" data-session="all"><div class="session-head"><span class="session-name">All sessions</span><span class="badge">'+sessions.length+'</span></div><div class="session-task">View tool calls from every chat</div></button>';
  const cards=sessions.map(s=>{
    const status=currentStatus(s),init=s.initialized?'<span class="badge success">Initialized</span>':'<span class="badge needs-init">Needs start_here</span>';
    return '<div class="session-card '+(selectedSession===s.id?"selected":"")+'"><button type="button" class="session-open" data-session="'+esc(s.id)+'" aria-label="View '+esc(s.id)+'"><div class="session-head"><span class="session-name">'+esc(s.id)+'</span><span class="badge '+status+'">'+status+'</span></div><div class="session-task">'+esc(s.task||"ChatGPT conversation")+'</div><div class="session-meta">'+init+'<span>'+esc(s.lastTool||"No tool call yet")+'</span></div><div class="session-meta">Last activity '+esc(fmtTime(s.lastSeenAt))+'</div></button><button type="button" class="icon-action session-copy" data-copy-session="'+esc(s.id)+'" title="Copy session and its tool calls as JSON" aria-label="Copy session '+esc(s.id)+'">'+copyIcon()+'</button><button type="button" class="session-remove" data-remove-session="'+esc(s.id)+'" title="Remove session" aria-label="Remove '+esc(s.id)+' from monitor"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg></button></div>';
  }).join("");
  const hasUnscoped=events.some(e=>!e.sessionId);
  const localButton=hasUnscoped?'<button class="session-card '+(selectedSession==="unscoped"?"selected":"")+'" data-session="unscoped"><div class="session-head"><span class="session-name">Unscoped / local</span></div><div class="session-task">Requests without a chat session ID</div></button>':"";
  $("sessions").innerHTML=chatButtons+(cards||'<div class="empty">No identified ChatGPT sessions yet.</div>')+localButton;
  document.querySelectorAll("[data-session]").forEach(b=>b.onclick=()=>{selectedSession=b.dataset.session;selectedEvent=null;render()});
  document.querySelectorAll("[data-remove-session]").forEach(b=>b.onclick=()=>void removeSession(b.dataset.removeSession,b));
  document.querySelectorAll("[data-copy-session]").forEach(button=>button.onclick=()=>{
    const session=sessions.find(item=>item.id===button.dataset.copySession);
    if(!session)return;
    const sessionEvents=events.filter(event=>event.sessionId===session.id).sort((a,b)=>a.id-b.id);
    void copyWithFeedback(button,JSON.stringify({copiedAt:new Date().toISOString(),session,eventCount:sessionEvents.length,events:sessionEvents},null,2));
  });
}
async function removeSession(sessionId,button){
  if(!sessionId)return;
  button.disabled=true;
  try{
    const response=await fetch("/api/sessions/"+encodeURIComponent(sessionId),{method:"DELETE"});
    if(!response.ok)throw new Error("HTTP "+response.status);
    sessions=sessions.filter(s=>s.id!==sessionId);
    if(selectedSession===sessionId){selectedSession="all";selectedEvent=null}
    render();
    $("connection").textContent="Session and its tool-call logs removed";
  }catch(error){
    $("connection").textContent="Could not remove session: "+error.message;
    button.disabled=false;
  }
}
function scopedEvents(){return events.filter(e=>selectedSession==="all"||(selectedSession==="unscoped"?!e.sessionId:e.sessionId===selectedSession))}
function matchingEvents(){
  const query=$("callSearch").value.trim().toLowerCase();
  return scopedEvents().filter(e=>{
    if(!query)return true;
    const searchable=[e.tool,e.command,e.method,e.summary,e.sessionLabel,e.arguments,e.output,e.error,e.diagnostics];
    return JSON.stringify(searchable).toLowerCase().includes(query);
  });
}
function updateFollowButton(){
  const button=$("followLatest");
  button.setAttribute("aria-pressed",String(followLatest));
  button.textContent=followLatest?"Following latest":"Follow latest";
  button.title=followLatest?"Automatically showing new tool calls. Select an older call to pause.":"Resume showing new tool calls automatically";
}
function render(){
  renderSessions();
  const scoped=scopedEvents();
  const filtered=matchingEvents().filter(e=>$("filter").value==="all"||e.status===$("filter").value);
  const list=[...filtered].sort((a,b)=>b.id-a.id);
  const previousEvent=selectedEvent;
  if(followLatest||selectedEvent==null||!list.some(e=>e.id===selectedEvent))selectedEvent=list[0]?.id??null;
  updateFollowButton();
  $("calls").innerHTML=list.length?list.map(e=>'<div class="call '+(e.id===selectedEvent?"selected":"")+'"><button type="button" class="call-open" data-id="'+e.id+'" aria-label="Inspect '+esc(e.tool||"tool call")+' #'+e.id+'"><div class="calltop"><span class="toolname">'+esc(e.tool||"Unknown tool")+'</span><span class="badge '+esc(e.status)+'">'+statusLabel(e.status)+'</span></div><div class="subline">'+esc(e.command||e.method||e.summary||"No command detail")+'</div><div class="meta">'+esc(e.sessionLabel||"Unscoped / local")+' · '+esc(fmtTime(e.startedAt))+' · '+(e.durationMs==null?"in progress":e.durationMs+" ms")+' · #'+e.id+'</div></button><button type="button" class="icon-action call-copy" data-copy-call="'+e.id+'" title="Copy tool call as JSON" aria-label="Copy tool call #'+e.id+'">'+copyIcon()+'</button></div>').join(""):'<div class="empty">No matching tool calls.</div>';
  $("running").textContent=String(scoped.filter(e=>e.status==="running").length);
  $("completed").textContent=String(scoped.filter(e=>e.status==="success").length);
  $("errors").textContent=String(scoped.filter(e=>e.status==="error").length);
  document.querySelectorAll(".call-open").forEach(b=>b.onclick=()=>{
    const id=Number(b.dataset.id);
    if(id!==list[0]?.id)followLatest=false;
    selectedEvent=id;
    render();
  });
  document.querySelectorAll("[data-copy-call]").forEach(button=>button.onclick=()=>{
    const event=events.find(item=>item.id===Number(button.dataset.copyCall));
    if(event)void copyWithFeedback(button,JSON.stringify(event,null,2));
  });
  renderDetail();
  if(followLatest&&selectedEvent!==previousEvent){
    const main=document.querySelector("main");
    if(main)main.scrollTop=0;
  }
}
function renderDetail(){
  const e=events.find(x=>x.id===selectedEvent);
  if(!e){$("detail").innerHTML='<div class="empty">Select a tool call to inspect its arguments and output.</div>';return}
  const output=e.error==null?e.output:{error:e.error,...(e.diagnostics?{diagnostics:e.diagnostics}:{})};
  const init=e.sessionInitialized===true?"Initialized":e.sessionInitialized===false?"Not initialized":"No session gate";
  blockValues={operation:e.command||e.method||"(no explicit command; inspect arguments)",arguments:e.arguments,output};
  $("detail").innerHTML='<div class="detailhead"><div><h2>'+esc(e.tool)+'</h2><p>Call #'+e.id+' · '+esc(e.sessionLabel||"Unscoped / local")+' · '+esc(init)+' · started '+esc(fmtTime(e.startedAt))+' · '+(e.durationMs==null?"running":e.durationMs+" ms")+'</p></div><span class="badge '+esc(e.status)+'">'+statusLabel(e.status)+'</span></div>'+block("Command / operation","operation")+block("Arguments","arguments")+block("Output","output");
  ["operation","arguments","output"].forEach(renderBlock);
  document.querySelectorAll("[data-view-block]").forEach(button=>button.onclick=()=>{
    const key=button.dataset.viewBlock;
    blockModes[key]=payloadMode(key,blockValues[key])==="raw"?"tree":"raw";
    renderDetail();
  });
  document.querySelectorAll("[data-depth-block]").forEach(button=>button.onclick=()=>{
    const key=button.dataset.depthBlock;
    blockDepths[key]=(blockDepths[key]||1)>1?1:4;
    renderDetail();
  });
  document.querySelectorAll("[data-open-diff]").forEach(button=>button.onclick=()=>{manualDiffModes[selectedEvent]=true;renderDetail()});
  document.querySelectorAll("[data-raw-output]").forEach(button=>button.onclick=()=>{manualDiffModes[selectedEvent]=false;renderDetail()});
  document.querySelectorAll("[data-diff-mode]").forEach(button=>button.onclick=()=>{
    const key=button.dataset.diffMode;
    diffModes[key]=diffMode(key)==="side-by-side"?"line-by-line":"side-by-side";
    renderDetail();
  });
}
function apply(e){
  if(!e)return;
  if(e.type==="session"){upsertSession(e.session);return}
  if(e.type==="session_removed"){
    sessions=sessions.filter(s=>s.id!==e.sessionId);
    events=events.filter(event=>event.sessionId!==e.sessionId);
    if(selectedSession===e.sessionId){selectedSession="all";selectedEvent=null}
    render();
    return;
  }
  if(e.type==="clear"){events=[];sessions=[];selectedSession="all";selectedEvent=null;render();return}
  if(!e.id)return;
  const i=events.findIndex(x=>x.id===e.id);if(i<0)events.push(e);else events[i]={...events[i],...e};
  events.sort((a,b)=>a.id-b.id);if(events.length>200)events=events.slice(-200);
  render();
}
async function load(){
  try{
    const results=await Promise.all([fetch("/api/events",{cache:"no-store"}),fetch("/api/sessions",{cache:"no-store"})]);
    if(!results[0].ok||!results[1].ok)throw new Error("HTTP "+(!results[0].ok?results[0].status:results[1].status));
    const eventData=await results[0].json(),sessionData=await results[1].json();
    events=eventData.events||[];sessions=sessionData.sessions||[];
    $("dot").classList.add("live");$("connection").textContent="Bridge connected";render();connectEvents();
  }catch(e){$("dot").classList.remove("live");$("connection").textContent="Bridge offline"}
}
function connectEvents(){
  if(source)source.close();source=new EventSource("/events");
  source.onopen=()=>{if(reconnectPending){window.location.reload();return}$("dot").classList.add("live");$("connection").textContent="Live · bridge connected"};
  source.onmessage=e=>{try{apply(JSON.parse(e.data))}catch{}};
  source.onerror=()=>{reconnectPending=true;$("dot").classList.remove("live");$("connection").textContent="Reconnecting…"};
}
async function copyText(text){
  if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);return}
  const field=document.createElement("textarea");field.value=text;field.setAttribute("readonly","");field.style.position="fixed";field.style.left="-9999px";document.body.appendChild(field);field.select();const copied=document.execCommand("copy");field.remove();if(!copied)throw new Error("Clipboard access was blocked by the browser");
}
async function clearHistory(){
  const button=$("clear");button.disabled=true;
  try{const r=await fetch("/api/events/clear",{method:"POST"});if(!r.ok)throw new Error("HTTP "+r.status);const d=await r.json();events=[];sessions=[];selectedSession="all";selectedEvent=null;render();$("connection").textContent="Cleared "+(d.clearedCount||0)+" tool calls and "+(d.clearedSessionCount||0)+" sessions"}catch(e){$("connection").textContent="Could not clear monitor: "+e.message}finally{button.disabled=false}
}
async function restartBridge(){
  const button=$("restart");button.disabled=true;
  $("connection").textContent="Requesting bridge restart…";
  try{
    const response=await fetch("/api/restart",{method:"POST"});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||("HTTP "+response.status));
    const previousPid=data.previousPid==null?null:String(data.previousPid);
    if(source){source.close();source=null}
    $("dot").classList.remove("live");
    $("connection").textContent="Restart scheduled · waiting for bridge to return…";
    const deadline=Date.now()+60000;
    let observedOffline=false;
    let lastHealthError="";
    while(Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,800));
      try{
        const healthResponse=await fetch("/healthz",{cache:"no-store"});
        if(!healthResponse.ok){observedOffline=true;lastHealthError="HTTP "+healthResponse.status;continue}
        const health=await healthResponse.json();
        if(!health.ok||health.server!=="openclaw-chatgpt-bridge")continue;
        const currentPid=health.pid==null?null:String(health.pid);
        if((previousPid!==null&&currentPid!==null&&currentPid!==previousPid)
          ||(observedOffline&&currentPid!==previousPid)){
          window.location.reload();
          return;
        }
        if(currentPid===null)lastHealthError="Health endpoint did not return a PID";
      }catch(error){observedOffline=true;lastHealthError=error.message}
    }
    $("connection").textContent="Restart timed out · "+(lastHealthError||"check logs and verify the bridge PID");
    button.disabled=false;
  }catch(error){
    $("connection").textContent="Could not restart bridge: "+error.message;
    button.disabled=false;
    void load();
  }
}
$("filter").onchange=render;
$("followLatest").onclick=()=>{followLatest=!followLatest;render()};
$("callSearch").addEventListener("input",render);
$("callSearch").addEventListener("keydown",event=>{
  if(event.key==="Escape"&&$("callSearch").value){$("callSearch").value="";render()}
});
$("refresh").onclick=load;$("clear").onclick=clearHistory;$("restart").onclick=restartBridge;
document.addEventListener("keydown",event=>{
  const active=document.activeElement;
  const isTyping=active&&["INPUT","TEXTAREA","SELECT"].includes(active.tagName);
  if(event.key==="/"&&!isTyping&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();$("callSearch").focus()}
});
window.setInterval(renderSessions,5000);
load();
