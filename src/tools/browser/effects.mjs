// A browser-local indicator. All installation runs through the ordinary native
// evaluate action, so browser.evaluateEnabled and native policy remain decisive.
function installFeedback(options, element) {
  const key = Symbol.for("openclaw.browser.feedback.v1");
  let state = window[key];
  if (options.finish && !state?.enabled && !options.activate) return { enabled: false };
  if (options.enabled === false) {
    state?.dispose?.();
    window[key] = { enabled: false };
    return { enabled: false };
  }
  if (options.deactivate) { state?.dispose?.(); window[key] = null; return { enabled: false }; }
  if (state?.enabled === false && !options.force) return { enabled: false };
  if (state?.enabled && !state.host.isConnected) { state.dispose(); state = null; }
  if (!state?.enabled) {
    const host = document.createElement("div");
    host.setAttribute("data-openclaw-browser-feedback", "");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;contain:strict!important;";
    const root = host.attachShadow({mode:"closed"});
    const style = document.createElement("style");
    style.textContent = `
      :host, :host * { pointer-events:none!important; box-sizing:border-box; }
      .layer { position:fixed;inset:0; }
      .border { position:absolute;inset:3px;border:3px solid #6ee7b7;border-radius:10px;box-shadow:0 0 18px 8px #10b98199,0 0 50px 20px #10b98155,inset 0 0 24px 9px #10b98166,inset 0 0 60px 24px #10b98133;opacity:0;transition:opacity 3300ms linear; }
      .cursor { position:absolute;left:0;top:0;transition:transform 180ms ease-out;filter:drop-shadow(0 0 5px #10b981); }
      svg { width:25px;height:30px;display:block; }
      .label { position:absolute;left:23px;top:20px;white-space:nowrap;padding:4px 7px;border-radius:6px;background:#064e3b;color:#fff;font:12px/16px system-ui;box-shadow:0 1px 6px #0004; }
      .outline { position:absolute;border:2px solid #10b981;border-radius:5px;box-shadow:0 0 7px #10b98166;opacity:0;transition:opacity 180ms; }
      .ring { position:absolute;width:14px;height:14px;margin:-7px;border:2px solid #6ee7b7;border-radius:50%;opacity:0; }
      @keyframes ripple { from {transform:scale(.6);opacity:1} to {transform:scale(3.2);opacity:0} }
      .trail { position:absolute;height:2px;background:linear-gradient(90deg,transparent,#10b98199);transform-origin:0 50%;border-radius:2px; }
      @media (prefers-reduced-motion:reduce) { .cursor,.border,.outline {transition:none} .trail {display:none} }
    `;
    root.append(style);
    const create = (parent, tag, className) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      parent.append(node);
      return node;
    };
    const layer = create(root, "div", "layer");
    const border = create(layer, "div", "border");
    const trail = create(layer, "div", "trail");
    const outline = create(layer, "div", "outline");
    const ring = create(layer, "div", "ring");
    const cursor = create(layer, "div", "cursor");
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("viewBox", "0 0 25 30");
    const pointer = document.createElementNS(svgNs, "path");
    for (const [name, value] of Object.entries({
      d: "M2 2 L21 17 L12 18 L8 27 Z",
      fill: "#10b981", stroke: "white",
      "stroke-width": "1.5", "stroke-linejoin": "round",
    })) pointer.setAttribute(name, value);
    svg.append(pointer);
    cursor.append(svg);
    const label = create(cursor, "span", "label");
    label.textContent = "AI";
    (document.documentElement || document.body).append(host);
    let fadeTimer, trailTimer, ringAnimation, idleTimer;
    const hideActionFeedback = () => {
      border.style.transition="opacity 3300ms linear";
      border.style.opacity="0"; outline.style.opacity="0"; label.textContent="AI";
    };
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    state = {
      enabled:true, host, until:0, position:null, visible:false,
      activate() {
        this.visible = document.visibilityState === "visible";
        host.style.display = this.visible ? "block" : "none";
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => this.dispose(), 5 * 60 * 1000);
      },
      show(x,y,kind,target) {
        x=Math.max(14,Math.min(Math.max(14,innerWidth-30),x)); y=Math.max(18,Math.min(Math.max(18,innerHeight-46),y));
        const previous=this.position; this.position={x,y};
        if (previous && !reduced) {
          const dx=x-previous.x, dy=y-previous.y;
          Object.assign(trail.style,{left:previous.x+"px",top:previous.y+"px",width:Math.hypot(dx,dy)+"px",transform:"rotate("+Math.atan2(dy,dx)+"rad)",opacity:"1"});
          clearTimeout(trailTimer); trailTimer=setTimeout(()=>{trail.style.opacity="0"},230);
        }
        cursor.style.transform="translate("+x+"px,"+y+"px)";
        label.textContent=kind === "ready" ? "AI" : "AI · "+kind;
        label.style.left=x>innerWidth-150 ? "-130px" : "23px";
        label.style.top=y>innerHeight-65 ? "-24px" : "20px";
        if (kind !== "ready" && target instanceof Element && !host.contains(target)) {
          const r=target.getBoundingClientRect();
          Object.assign(outline.style,{display:"block",left:r.x+"px",top:r.y+"px",width:r.width+"px",height:r.height+"px",opacity:"1"});
        } else { outline.style.display="none"; outline.style.opacity="0"; }
        if (/click|press/.test(kind)) {
          ringAnimation?.cancel(); Object.assign(ring.style,{left:x+"px",top:y+"px"});
          if (!reduced) ringAnimation=ring.animate([{transform:"scale(.6)",opacity:1},{transform:"scale(3.2)",opacity:0}],{duration:500});
        }
        if (kind !== "ready") {
          border.style.transition="none";
          border.style.opacity="1";
          clearTimeout(fadeTimer);
          fadeTimer=setTimeout(hideActionFeedback,30000);
        }
      },
      finish() {
        this.until=0;
        clearTimeout(fadeTimer);
        hideActionFeedback();
        border.style.transition="none";
        ringAnimation?.cancel();
        trail.style.opacity="0";
      },
      dispose() {
        clearTimeout(fadeTimer); clearTimeout(trailTimer); clearTimeout(idleTimer); ringAnimation?.cancel();
        for (const [name, listener] of listeners) document.removeEventListener(name,listener,true);
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pagehide", onPageHide);
        host.remove(); this.enabled=false; this.visible=false;
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
        const keepPosition=name==="scroll" && state.position;
        const x=keepPosition ? state.position.x : hasPoint ? event.clientX : r ? r.x+r.width/2 : state.position?.x ?? 60;
        const y=keepPosition ? state.position.y : hasPoint ? event.clientY : r ? r.y+r.height/2 : state.position?.y ?? 100;
        state.show(x,y,({pointerdown:"click",click:"click",focusin:"focus",input:"type",keydown:"key",scroll:"scroll"})[name],target);
      };
      document.addEventListener(name,listener,true); return [name,listener];
    });
    const onVisibility = () => { state.visible = document.visibilityState === "visible"; host.style.display = state.visible ? "block" : "none"; };
    const onPageHide = () => state.dispose();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window[key]=state;
  }
  state.activate();
  if (options.finish) {
    if (!state.position && options.activate) state.show(options.x ?? 60,options.y ?? 100,"ready",null);
    state.finish(); return {enabled:true,position:state.position,visible:state.visible};
  }
  state.until=options.kind === "ready" ? 0 : Date.now()+Math.min(120000,Math.max(1000,options.timeoutMs ?? 20000));
  let target=element instanceof Element ? element : null;
  if (!target && options.selector) target=document.querySelector(options.selector);
  target ??= document.activeElement;
  const rect=target?.getBoundingClientRect?.();
  const x=Number.isFinite(options.x) ? options.x : options.kind === "ready" && state.position ? state.position.x : rect?.width ? rect.x+rect.width/2 : 60;
  const y=Number.isFinite(options.y) ? options.y : options.kind === "ready" && state.position ? state.position.y : rect?.height ? rect.y+rect.height/2 : 100;
  state.show(x,y,options.kind ?? "ready",target);
  return {enabled:true, position:state.position, visible:state.visible, reducedMotion:matchMedia("(prefers-reduced-motion: reduce)").matches,
    ...(options.kind === "click" ? (() => {
      const link = target?.closest?.("a[href]");
      return {pageUrl:location.href,linkUrl:link?.href ?? null,
        linkRawHref:link?.getAttribute("href") ?? null,
        linkTarget:link?.getAttribute("target") ?? null,
        linkDownload:link?.hasAttribute("download") ?? false,
        linkHandler:!!link?.onclick || link?.hasAttribute("onclick") || false};
    })() : {})};
}

function schedulePlainFragmentClick(element, selector) {
  const target = element instanceof Element ? element : selector ? document.querySelector(selector) : null;
  const link = target?.closest?.("a[href]");
  if (!link?.isConnected || link.hasAttribute("target") || link.hasAttribute("download")
    || link.hasAttribute("onclick") || typeof link.onclick === "function") return {scheduled:false};
  const raw = link.getAttribute("href");
  if (typeof raw !== "string" || raw.length < 2 || !raw.startsWith("#")
    || raw.startsWith("#!")) return {scheduled:false};
  const before=location.href, destination=link.href;
  try {
    const source=new URL(before), to=new URL(destination);
    if (source.origin !== to.origin || source.pathname !== to.pathname
      || source.search !== to.search || source.hash === to.hash || !to.hash)
      return {scheduled:false};
  } catch { return {scheduled:false}; }
  setTimeout(() => {
    if (!link.isConnected || link.href !== destination
      || link.getAttribute("href") !== raw || location.href !== before) return;
    window[Symbol.for("openclaw.browser.feedback.v1")]?.finish?.();
    link.click();
  },125);
  return {scheduled:true,pageUrl:before,linkUrl:destination,linkRawHref:raw};
}

export function browserAutoFragmentFeedbackFunction(options, selector) {
  return "(el) => {const feedback=(" + installFeedback.toString() + ")("
    + JSON.stringify(options) + ",el);const click=("
    + schedulePlainFragmentClick.toString() + ")(el," + JSON.stringify(selector ?? null)
    + ");return {...feedback,...click};}";
}

export function browserFragmentClickFunction(selector, expectedUrl, expectedRawHref, pageUrl) {
  const target = selector ? "document.querySelector(" + JSON.stringify(selector) + ")" : "null";
  return "(el) => {const candidate=el instanceof Element?el:" + target + ";"
    + "const a=candidate?.closest?.('a[href]');"
    + "if(!a || !a.isConnected || a.href!==" + JSON.stringify(expectedUrl)
    + " || a.getAttribute('href')!==" + JSON.stringify(expectedRawHref)
    + " || location.href!==" + JSON.stringify(pageUrl)
    + ")return {scheduled:false};"
    + "setTimeout(()=>{if(a.isConnected && location.href==="
    + JSON.stringify(pageUrl) + ")a.click()},125);"
    + "return {scheduled:true,href:a.href};}";
}

export function browserFeedbackFunction(options = {}) {
  return "(el) => (" + installFeedback.toString() + ")(" + JSON.stringify(options) + ", el)";
}

export function browserLinkContextFunction(selector) {
  return "(el) => {const target = el instanceof Element ? el : "
    + (selector ? "document.querySelector(" + JSON.stringify(selector) + ")" : "null")
    + ";const link=target?.closest?.('a[href]');return {pageUrl:location.href,"
    + "linkUrl:link?.href??null,linkRawHref:link?.getAttribute('href')??null,"
    + "linkTarget:link?.getAttribute('target')??null,linkDownload:link?.hasAttribute('download')??false,"
    + "linkHandler:!!link?.onclick||link?.hasAttribute('onclick')||false};}";
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
