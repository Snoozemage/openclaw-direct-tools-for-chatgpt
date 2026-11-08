// Narrow compatibility path for extension relays missing browser-root Storage.*.
// Called only inside the native-policy-approved Browser executor, after -32601.
export function isMissingCookieCommand(args, error) {
  return args.action === "cookies"
    && /Protocol error \(Storage\.(?:getCookies|setCookies)\): ['"]?Storage\.[a-zA-Z]+['"]? wasn't found/.test(error?.message ?? "");
}

export function cookieCommand(args) {
  switch (args.operation ?? "get") {
    case "get": return { method: "Storage.getCookies", params: {} };
    case "set": return { method: "Storage.setCookies", params: { cookies: [args.cookie] } };
    case "setMany": return { method: "Storage.setCookies", params: { cookies: args.cookies } };
    case "clear": throw new Error("Cookie clear is unavailable through this compatibility route.");
    default: throw new Error("Unsupported cookie operation");
  }
}

function nativeValue(result) {
  if (!result.ok) throw new Error(result.error?.message ?? "Native Browser request failed");
  if (result.output?.details?.tabs || result.output?.details?.driver) return result.output.details;
  const text=result.output?.content?.find(item=>item.type==="text")?.text ?? "";
  const start=text.indexOf("\n---\n"),end=text.lastIndexOf("\n<<<END_EXTERNAL");
  return JSON.parse(start>=0&&end>start?text.slice(start+5,end):text);
}

export function resolveCookieTarget(tabs, reference) {
  if (typeof reference !== "string" || !reference.trim()) throw new Error("Cookie compatibility requires an explicit tabId or targetId.");
  const exact=tabs.filter(tab=>[tab.targetId,tab.tabId,tab.label,tab.suggestedTargetId].includes(reference));
  const matches=exact.length?exact:tabs.filter(tab=>tab.targetId?.startsWith(reference));
  if(matches.length!==1)throw new Error("Cookie target must identify exactly one accessible Chrome tab.");
  return matches[0].targetId;
}

let functions;
let queue = Promise.resolve();
export function runCookieCompatibility(args, dependencies) {
  const result=queue.catch(()=>{}).then(()=>run(args,dependencies));
  queue=result.catch(()=>{});
  return result;
}
async function run(args, { loadExport, invokeTool, signal }) {
  if (args.target === "node" || args.node) throw new Error("Cookie compatibility is available only for the local Chrome extension route.");
  signal?.throwIfAborted();
  const route={profile:"chrome",target:"host"};
  const status=nativeValue(await invokeTool("browser",{...route,action:"status"},undefined,10000));
  if(status.driver!=="extension" || !status.running)throw new Error("Local Chrome extension is not connected.");
  const endpoint=new URL(status.cdpUrl);
  if(endpoint.protocol!=="http:" || endpoint.hostname!=="127.0.0.1" || !endpoint.port)throw new Error("Cookie compatibility requires the configured loopback extension endpoint.");
  const inventory=nativeValue(await invokeTool("browser",{...route,action:"tabs"},undefined,10000));
  const targetId=resolveCookieTarget(inventory.tabs ?? [],args.targetId);
  functions ??= Promise.all([
    loadExport("owner-client-","RelayOwnerClient"),
    loadExport("relay-auth-","readExtensionRelayToken"),
    loadExport("relay-access-","registerBorrowedRelayCdpAccess"),
    loadExport("pw-tools-core.interactions.navigation-","getPageForTargetId"),
    loadExport("pw-tools-core.interactions.navigation-","closePlaywrightBrowserConnection"),
  ]).catch(error=>{functions=undefined;throw error;});
  const [Owner,readToken,register,getPage,closeConnection]=await functions;
  const token=readToken();
  if(!token)throw new Error("Native relay credentials are unavailable.");
  let owner,unregister,reference,session;
  try {
    owner=await Owner.connect({port:Number(endpoint.port),profile:"chrome",token,signal:signal ?? AbortSignal.timeout(15000)});
    unregister=register(status.cdpUrl,{client:owner,port:Number(endpoint.port)});
    reference=await owner.capture(targetId);
    const page=await getPage({cdpUrl:status.cdpUrl,targetId,relayReference:reference});
    signal?.throwIfAborted();
    session=await page.context().newCDPSession(page);
    const command=cookieCommand(args);
    const pageUrl=new URL(page.url());
    if(!["http:","https:"].includes(pageUrl.protocol))throw new Error("Cookie compatibility requires an HTTP(S) tab.");
    const readUrl=new URL(args.url ?? pageUrl.href);
    if(readUrl.origin!==pageUrl.origin)throw new Error("Cookie URL must use the bound tab's origin.");
    if(command.method==="Storage.getCookies"){
      command.method="Network.getCookies";command.params={urls:[readUrl.href]};
    } else for(const cookie of command.params.cookies){
      if(cookie.url && new URL(cookie.url).origin!==pageUrl.origin)throw new Error("Cookie writes must use the bound tab's origin.");
      if(cookie.domain && cookie.domain.replace(/^\./,"")!==pageUrl.hostname)throw new Error("Cookie domain must match the bound tab's host.");
    }
    const result=await session.send(command.method,command.params);
    if(args.filter && result.cookies)result.cookies=result.cookies.filter(cookie=>cookie.name.includes(args.filter));
    signal?.throwIfAborted();
    return {
      ok:true,targetId,url:page.url(),transport:"extension-tab-session",
      ...(command.method==="Network.getCookies"?{cookies:result.cookies}:{}),
      ...(args.operation==="setMany"?{added:args.cookies.length}:{}),
    };
  } finally {
    await session?.detach().catch(()=>{});
    await closeConnection({cdpUrl:status.cdpUrl}).catch(()=>{});
    await reference?.release?.().catch(()=>{});
    await owner?.close().catch(()=>{});
    unregister?.();
  }
}
