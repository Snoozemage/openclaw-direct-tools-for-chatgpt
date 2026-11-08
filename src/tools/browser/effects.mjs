// A browser-local indicator. All installation runs through the ordinary native
// evaluate action, so browser.evaluateEnabled and native policy remain decisive.
function installFeedback(options, element) {
  const key = Symbol.for("openclaw.browser.feedback.v1");
  let state = window[key];
  if (options.finish && !state?.enabled) return { enabled: false };
  if (options.enabled === false) {
    state?.dispose?.();
    window[key] = { enabled: false };
    return { enabled: false };
  }
  if (state?.enabled === false && !options.force) return { enabled: false };
  if (state?.enabled && !state.host.isConnected) { state.dispose(); state = null; }
  if (!state?.enabled) {
    const host = document.createElement("div");
    host.setAttribute("data-openclaw-browser-feedback", "");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;contain:strict!important;";
    const root = host.attachShadow({mode:"closed"});
    root.innerHTML = `<style>
      :host, :host * { pointer-events:none!important; box-sizing:border-box; }
      .layer { position:fixed;inset:0;opacity:0;transition:opacity 180ms; }
      .border { position:absolute;inset:2px;border:2px solid #a78bfa;border-radius:8px;box-shadow:inset 0 0 12px #a78bfa66; }
      .cursor { position:absolute;left:0;top:0;transition:transform 180ms ease-out;filter:drop-shadow(0 0 5px #a78bfa); }
      svg { width:25px;height:30px;display:block; }
      .label { position:absolute;left:23px;top:20px;white-space:nowrap;padding:4px 7px;border-radius:6px;background:#30254e;color:#fff;font:12px/16px system-ui;box-shadow:0 1px 6px #0004; }
      .outline { position:absolute;border:2px solid #a78bfa;border-radius:5px;box-shadow:0 0 7px #a78bfa66; }
      .ring { position:absolute;width:14px;height:14px;margin:-7px;border:2px solid #c4b5fd;border-radius:50%;opacity:0; }
      @keyframes ripple { from {transform:scale(.6);opacity:1} to {transform:scale(3.2);opacity:0} }
      .trail { position:absolute;height:2px;background:linear-gradient(90deg,transparent,#a78bfa99);transform-origin:0 50%;border-radius:2px; }
      @media (prefers-reduced-motion:reduce) { .layer,.cursor {transition:none} .trail {display:none} }
    </style><div class="layer"><div class="border"></div><div class="trail"></div><div class="outline"></div><div class="ring"></div><div class="cursor"><svg viewBox="0 0 25 30"><path d="M2 2 L21 17 L12 18 L8 27 Z" fill="#a78bfa" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg><span class="label">AI</span></div></div>`;
    (document.documentElement || document.body).append(host);
    const layer=root.querySelector(".layer"), cursor=root.querySelector(".cursor"), label=root.querySelector(".label");
    const outline=root.querySelector(".outline"), ring=root.querySelector(".ring"), trail=root.querySelector(".trail");
    let fadeTimer, trailTimer, ringAnimation;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    state = {
      enabled:true, host, until:0, position:null,
      show(x,y,kind,target) {
        x=Math.max(1,Math.min(innerWidth-26,x)); y=Math.max(1,Math.min(innerHeight-32,y));
        const previous=this.position; this.position={x,y};
        if (previous && !reduced) {
          const dx=x-previous.x, dy=y-previous.y;
          Object.assign(trail.style,{left:previous.x+"px",top:previous.y+"px",width:Math.hypot(dx,dy)+"px",transform:"rotate("+Math.atan2(dy,dx)+"rad)",opacity:"1"});
          clearTimeout(trailTimer); trailTimer=setTimeout(()=>{trail.style.opacity="0"},230);
        }
        cursor.style.transform="translate("+x+"px,"+y+"px)";
        label.textContent="AI · "+kind;
        label.style.left=x>innerWidth-150 ? "-130px" : "23px";
        label.style.top=y>innerHeight-65 ? "-24px" : "20px";
        if (target instanceof Element && !host.contains(target)) {
          const r=target.getBoundingClientRect();
          Object.assign(outline.style,{display:"block",left:r.x+"px",top:r.y+"px",width:r.width+"px",height:r.height+"px"});
        } else outline.style.display="none";
        if (/click|press/.test(kind)) {
          ringAnimation?.cancel(); Object.assign(ring.style,{left:x+"px",top:y+"px"});
          if (!reduced) ringAnimation=ring.animate([{transform:"scale(.6)",opacity:1},{transform:"scale(3.2)",opacity:0}],{duration:500});
        }
        layer.style.opacity="1";
        clearTimeout(fadeTimer); fadeTimer=setTimeout(()=>{layer.style.opacity="0"},1400);
      },
      finish() { this.until=0; clearTimeout(fadeTimer); fadeTimer=setTimeout(()=>{layer.style.opacity="0"},1100); },
      dispose() {
        clearTimeout(fadeTimer); clearTimeout(trailTimer); ringAnimation?.cancel();
        for (const [name, listener] of listeners) document.removeEventListener(name,listener,true);
        host.remove(); this.enabled=false;
      },
    };
    // Capture only discrete action events while an automation call is in flight;
    // never follow the user's mouse movements or change the system pointer.
    const listeners = ["pointerdown","click","focusin","input","keydown","scroll"].map(name=>{
      const listener=event=>{
        if (Date.now()>state.until || !event.isTrusted) return;
        const target=event.target instanceof Element ? event.target : document.activeElement;
        const r=target?.getBoundingClientRect?.();
        const hasPoint=name==="pointerdown" || name==="click";
        const x=hasPoint ? event.clientX : r ? r.x+r.width/2 : state.position?.x ?? 30;
        const y=hasPoint ? event.clientY : r ? r.y+r.height/2 : state.position?.y ?? 30;
        state.show(x,y,({pointerdown:"click",click:"click",focusin:"focus",input:"type",keydown:"key",scroll:"scroll"})[name],target);
      };
      document.addEventListener(name,listener,true); return [name,listener];
    });
    window[key]=state;
  }
  if (options.finish) { state.finish(); return {enabled:true}; }
  state.until=Date.now()+Math.min(120000,Math.max(1000,options.timeoutMs ?? 20000));
  let target=element instanceof Element ? element : null;
  if (!target && options.selector) target=document.querySelector(options.selector);
  target ??= document.activeElement;
  const rect=target?.getBoundingClientRect?.();
  const x=Number.isFinite(options.x) ? options.x : rect?.width ? rect.x+rect.width/2 : 30;
  const y=Number.isFinite(options.y) ? options.y : rect?.height ? rect.y+rect.height/2 : 30;
  state.show(x,y,options.kind ?? "ready",target);
  return {enabled:true, position:state.position, reducedMotion:matchMedia("(prefers-reduced-motion: reduce)").matches};
}

export function browserFeedbackFunction(options = {}) {
  return "(el) => (" + installFeedback.toString() + ")(" + JSON.stringify(options) + ", el)";
}

export function feedbackOptions(args) {
  const step = args.kind === "batch" ? args.actions?.[0] ?? {} : args;
  return {
    ref: step.ref ?? step.startRef ?? step.fields?.[0]?.ref,
    options: {
      kind: step.kind ?? "ready", x: step.x, y: step.y,
      selector: step.selector ?? step.startSelector,
      timeoutMs: args.timeoutMs,
    },
  };
}

export function shouldShowBrowserFeedback(args) {
  return args.action === "act" && args.visualFeedback !== false
    && !["evaluate", "wait", "close", "resize"].includes(args.kind);
}
