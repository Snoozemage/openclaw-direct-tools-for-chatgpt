import test from "node:test";
import assert from "node:assert/strict";
import { handleBrowserTool } from "../src/tools/browser/handler.mjs";

for (const visualFeedback of [false, true]) test(`click recovery with visual feedback ${visualFeedback} does not replay navigation`, async () => {
  const before = "https://www.youtube.com/results?search_query=Laufey";
  const link = "https://www.youtube.com/watch?v=lSD_L-xic9o&list=RDlSD_L-xic9o&pp=tracking";
  const destination = "https://www.youtube.com/watch?v=lSD_L-xic9o&list=RDlSD_L-xic9o&start_radio=1";
  const requests = [];
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      const { tool, args } = JSON.parse(options.body);
      assert.equal(tool, "browser");
      requests.push(args);
      let output;
      if (args.action === "act" && args.kind === "evaluate") {
        output = {details: {targetId:"t-test",result:{enabled:true,pageUrl:before,linkUrl:link}}};
      } else if (args.action === "act" && args.kind === "click") {
        output = {content:[{type:"text",text:JSON.stringify({
          type:"tool_error",message:'Element "e94" is not interactable (not visible)',
        })}]};
      } else if (args.action === "tabs") {
        output = {details: {targetId:"t-test",tabs:[
          {tabId:"t-other",url:link}, // Must not accept a different tab.
          {tabId:"t-test",url:destination},
        ]}};
      } else {
        assert.fail("Unexpected action: " + JSON.stringify(args));
      }
      return new Response(JSON.stringify({ok:true,result:output}),{
        status:200,headers:{"content-type":"application/json"},
      });
    };
    const result = await handleBrowserTool("openclaw_browser",{
      action:"act",kind:"click",tabId:"t-test",ref:"e94",visualFeedback,
    });
    assert.equal(result.isError,undefined);
    assert.equal(result.diagnostics.stage,"click_navigation_reconciled");
    assert.equal(result.diagnostics.verification,"same_tab_destination");
    const details = JSON.parse(result.content[0].text);
    assert.equal(details.outcome,"navigation_confirmed");
    assert.equal(details.url,destination);
    assert.equal(requests.filter(req => req.kind === "click").length,1);
    assert.equal(requests.filter(req => req.action === "tabs").length,1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const mode of ["visible", "hidden", "batch"]) {
  test(`plain in-page hash click routes once without native click (${mode})`, async () => {
    const before="https://en.wikipedia.org/wiki/Transformer_(deep_learning)#History";
    const destination="https://en.wikipedia.org/wiki/Transformer_(deep_learning)#Applications";
    const context={enabled:true,pageUrl:before,linkUrl:destination,
      linkRawHref:"#Applications",linkTarget:null,linkDownload:false,linkHandler:false};
    const requests=[];
    const originalFetch=globalThis.fetch;
    try {
      globalThis.fetch=async (_url, options)=>{
        const {tool,args}=JSON.parse(options.body);
        assert.equal(tool,"browser");
        requests.push(args);
        let output;
        if(args.action==="act" && args.kind==="evaluate"){
          output=args.fn?.includes("return {...feedback,...click};")
            ? {details:{targetId:"t-fragment",url:destination,result:{...context,scheduled:true}}}
            : args.fn?.includes("return {scheduled:true,href:a.href}")
              ? {details:{targetId:"LONG-CANONICAL-ID",url:destination,result:{scheduled:true,href:destination}}}
              : {details:{targetId:"t-fragment",result:context}};
        } else if(args.action==="act" && args.kind==="batch"){
          output={content:[{type:"text",text:JSON.stringify({ok:true,results:[{ok:true},{ok:true}]})}]};
        } else if(args.action==="navigate"){
          assert.equal(args.targetId,"t-fragment");
          assert.equal(args.targetUrl,destination);
          output={details:{targetId:"LONG-CANONICAL-ID",url:destination}};
        } else if(args.action==="tabs"){
          output={details:{tabs:[{tabId:"t-fragment",url:destination}]}};
        } else {
          assert.fail("Unexpected action "+JSON.stringify(args));
        }
        return new Response(JSON.stringify({ok:true,result:output}),{
          status:200,headers:{"content-type":"application/json"},
        });
      };
      const params=mode==="batch"
        ? {action:"act",kind:"batch",tabId:"t-fragment",actions:[
          {kind:"hover",ref:"e25"},{kind:"scrollIntoView",ref:"e25"},{kind:"click",ref:"e25"},
        ]}
        : {action:"act",kind:"click",tabId:"t-fragment",ref:"e25",
          visualFeedback:mode==="visible"};
      const result=await handleBrowserTool("openclaw_browser",params);
      assert.equal(result.isError,undefined);
      assert.equal(result.diagnostics.stage,"fragment_navigation");
      const payload=JSON.parse(result.content[0].text);
      assert.equal(payload.url,destination);
      if (mode==="batch") {
        assert.equal(payload.results.length,3);
        assert.deepEqual(payload.results.map(step=>step.ok),[true,true,true]);
        assert.equal(payload.results[2].outcome,"fragment_navigation_confirmed");
      }
      assert.equal(requests.filter(x=>x.action==="navigate").length,0);
      assert.equal(requests.filter(x=>x.fn?.includes("return {...feedback,...click};")).length,
        mode==="hidden" ? 0 : 1);
      assert.equal(requests.filter(x=>x.fn?.includes("return {scheduled:true,href:a.href}")).length,
        mode==="hidden" ? 1 : 0);
      assert.equal(requests.filter(x=>x.kind==="click").length,0);
      if(mode==="batch") {
        assert.equal(requests.filter(x=>x.kind==="batch").length,1);
        assert.equal(result.diagnostics.batchPrefixActions,2);
      }
    } finally {globalThis.fetch=originalFetch;}
  });
}

for (const navigated of [true, false]) {
  test(`HTTP 500 click error verifies destination without replay (navigated=${navigated})`, async () => {
    const originalFetch=globalThis.fetch, calls=[];
    const before="https://www.youtube.com/results?search_query=Laufey";
    const href="https://www.youtube.com/watch?v=lSD_L-xic9o";
    try {
      globalThis.fetch=async (_url,options)=>{
        const {args}=JSON.parse(options.body);
        calls.push(args);
        if(args.kind==="evaluate") return new Response(JSON.stringify({ok:true,result:{
          details:{targetId:"t-http-error",result:{pageUrl:before,linkUrl:href}},
        }}),{status:200,headers:{"content-type":"application/json"}});
        if(args.kind==="click") return new Response(JSON.stringify({
          ok:false,error:{type:"tool_error",message:"tool execution failed"},
        }),{status:500,headers:{"content-type":"application/json"}});
        if(args.action==="tabs") return new Response(JSON.stringify({ok:true,result:{
          details:{targetId:"t-http-error",tabs:[{tabId:"t-http-error",url:navigated?href:before}]},
        }}),{status:200,headers:{"content-type":"application/json"}});
        throw Error("Unexpected "+JSON.stringify(args));
      };
      const output=await handleBrowserTool("openclaw_browser",{
        action:"act",kind:"click",tabId:"t-http-error",ref:"e10",visualFeedback:false,
      });
      assert.equal(output.isError,navigated?undefined:true);
      if(navigated)assert.equal(JSON.parse(output.content[0].text).outcome,"navigation_confirmed");
      assert.equal(calls.filter(x=>x.kind==="click").length,1);
      assert.equal(calls.filter(x=>x.action==="tabs").length,1);
    } finally {globalThis.fetch=originalFetch;}
  });
}


for (const explicitTimeout of [undefined, 30_000]) {
  test(`link click uses a bounded default without overriding explicit timeout (${explicitTimeout ?? "default"})`, async () => {
    const previousFetch = globalThis.fetch;
    const previousTimeout = AbortSignal.timeout;
    const before = "https://www.youtube.com/results?search_query=seasons";
    const destination = "https://www.youtube.com/watch?v=M7R7-qnTsFw&list=RDM7R7-qnTsFw&start_radio=1";
    const requests = [];
    const deadlines = [];
    try {
      AbortSignal.timeout = (milliseconds) => {
        deadlines.push(milliseconds);
        return previousTimeout(milliseconds);
      };
      globalThis.fetch = async (_url, options) => {
        const { args } = JSON.parse(options.body);
        requests.push(args);
        let output;
        if (args.kind === "evaluate") {
          output = { details: { targetId: "t-music", result: {
            pageUrl: before, linkUrl: destination, linkTarget: null, linkDownload: false,
          } } };
        } else if (args.kind === "click") {
          output = { content: [{ type: "text", text: JSON.stringify({
            type: "tool_error", message: "Native click timed out after navigation",
          }) }] };
        } else if (args.action === "tabs") {
          output = { details: { targetId: "t-music", tabs: [{ tabId: "t-music", url: destination }] } };
        } else {
          assert.fail("Unexpected browser action: " + JSON.stringify(args));
        }
        return new Response(JSON.stringify({ ok: true, result: output }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      };
      const result = await handleBrowserTool("openclaw_browser", {
        action: "act", kind: "click", tabId: "t-music", ref: "e471",
        visualFeedback: false, ...(explicitTimeout === undefined ? {} : { timeoutMs: explicitTimeout }),
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.diagnostics.stage, "click_navigation_reconciled");
      assert.equal(JSON.parse(result.content[0].text).url, destination);
      assert.equal(requests.filter(request => request.kind === "click").length, 1);
      assert.equal(requests.filter(request => request.action === "tabs").length, 1);
      assert.equal(requests.find(request => request.kind === "click").timeoutMs,
        explicitTimeout ?? 10_000);
      assert.equal(deadlines[1], explicitTimeout === undefined ? 15_000 : 120_000);
    } finally {
      globalThis.fetch = previousFetch;
      AbortSignal.timeout = previousTimeout;
    }
  });
}


for (const visualFeedback of [false, true]) test(`detects same-tab destination while the native click is still pending (feedback=${visualFeedback})`, async () => {
  const previousFetch = globalThis.fetch;
  const before = "https://www.youtube.com/results?search_query=wave+to+earth";
  const destination = "https://www.youtube.com/watch?v=M7R7-qnTsFw&list=RDM7R7-qnTsFw&start_radio=1";
  const requests = [];
  let finishNativeClick;
  let nativeClickFinished = false;
  let tabsCalls = 0;
  try {
    globalThis.fetch = async (_url, options) => {
      const { args } = JSON.parse(options.body);
      requests.push(args);
      if (args.kind === "evaluate") {
        const finishing = args.fn?.includes('"finish":true');
        return new Response(JSON.stringify({ ok: true, result: { details: {
          targetId: "t-early", result: finishing
            ? { enabled: true, visible: false }
            : { enabled: true, pageUrl: before, linkUrl: destination },
        } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (args.kind === "click") {
        return new Promise(resolve => {
          finishNativeClick = () => {
            nativeClickFinished = true;
            resolve(new Response(JSON.stringify({ ok: false, error: {
              type: "tool_error", message: "Native click completed after page navigation",
            } }), { status: 500, headers: { "content-type": "application/json" } }));
          };
        });
      }
      if (args.action === "tabs") {
        tabsCalls++;
        const current = tabsCalls < 2 ? before : destination;
        return new Response(JSON.stringify({ ok: true, result: { details: {
          targetId: "t-early", tabs: [
            { tabId: "t-other", url: destination },
            { tabId: "t-early", url: current },
          ],
        } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      assert.fail("Unexpected action: " + JSON.stringify(args));
    };
    const outcome = await Promise.race([
      handleBrowserTool("openclaw_browser", {
        action: "act", kind: "click", tabId: "t-early", ref: "e471",
        visualFeedback,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Navigation watch was too slow")), 2_000)),
    ]);
    assert.equal(outcome.isError, undefined);
    assert.equal(outcome.diagnostics.stage, "click_navigation_observed");
    assert.equal(JSON.parse(outcome.content[0].text).url, destination);
    assert.equal(nativeClickFinished, false);
    assert.equal(requests.filter(request => request.kind === "click").length, 1);
    assert.equal(tabsCalls, 2);
    const cleanup = requests.filter(request =>
      request.kind === "evaluate" && request.fn?.includes('"finish":true'));
    assert.equal(cleanup.length, visualFeedback ? 1 : 0);
    if (visualFeedback) {
      assert.equal(cleanup[0].targetId, "t-early");
      assert.equal(cleanup[0].fn.includes('"activate":true'), false,
        "cleanup must not create a fresh overlay after a full-page navigation");
    }
  } finally {
    finishNativeClick?.();
    globalThis.fetch = previousFetch;
  }
});

test("clicks without a known navigation target retain the native timeout", async () => {
  const previousFetch = globalThis.fetch;
  const before = "https://example.com";
  const requests = [];
  try {
    globalThis.fetch = async (_url, options) => {
      const { args } = JSON.parse(options.body);
      requests.push(args);
      const output = args.kind === "evaluate"
        ? { details: { targetId: "t-button", result: { pageUrl: before, linkUrl: null } } }
        : { content: [{ type: "text", text: '{"ok":true}' }] };
      return new Response(JSON.stringify({ ok: true, result: output }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const result = await handleBrowserTool("openclaw_browser", {
      action: "act", kind: "click", tabId: "t-button", ref: "e1", visualFeedback: false,
    });
    assert.equal(result.isError, undefined);
    assert.equal(requests.find(request => request.kind === "click").timeoutMs, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("normal links keep native click rather than URL substitution", async () => {
  const originalFetch=globalThis.fetch, requests=[];
  try {
    globalThis.fetch=async (_url, options)=>{
      const {tool,args}=JSON.parse(options.body);
      assert.equal(tool,"browser");requests.push(args);
      let output;
      if(args.kind==="evaluate") output={details:{targetId:"t-normal",result:{
        enabled:true,pageUrl:"https://example.com",linkUrl:"https://example.com/next",
        linkRawHref:"/next",linkTarget:null,linkDownload:false,linkHandler:false,
      }}};
      else if(args.kind==="click") output={content:[{type:"text",text:'{"ok":true}'}]};
      else assert.fail("Unexpected "+JSON.stringify(args));
      return new Response(JSON.stringify({ok:true,result:output}),
        {status:200,headers:{"content-type":"application/json"}});
    };
    const result=await handleBrowserTool("openclaw_browser",
      {action:"act",kind:"click",tabId:"t-normal",ref:"e4",visualFeedback:false});
    assert.equal(result.isError,undefined);
    assert.equal(requests.filter(x=>x.action==="navigate").length,0);
    assert.equal(requests.filter(x=>x.kind==="click").length,1);
  } finally {globalThis.fetch=originalFetch;}
});

test("repeated same-document read calls reuse the active AI cursor without another native evaluate", async () => {
  const originalFetch=globalThis.fetch, calls=[];
  const urls={"t-cache":"https://example.com/a","t-other":"https://example.com/b"};
  try {
    globalThis.fetch=async (_url,options)=>{
      const {args}=JSON.parse(options.body);
      calls.push(args);
      const targetId=args.targetId;
      const url=urls[targetId] ?? "https://example.com/a";
      const output=args.kind==="evaluate"
        ? {details:{targetId,url,result:{enabled:true}}}
        : {details:{targetId,url}};
      return new Response(JSON.stringify({ok:true,result:output}),
        {status:200,headers:{"content-type":"application/json"}});
    };
    const run=async(action,tabId="t-cache")=>handleBrowserTool("openclaw_browser",{action,tabId});
    const evalCount=()=>calls.filter(x=>x.kind==="evaluate").length;
    await run("focus");
    const first=evalCount();
    assert.ok(first >= 1,"focus installs cursor (and may deactivate the previous tab)");
    for(const action of ["snapshot","text","screenshot","snapshot"])await run(action);
    assert.equal(evalCount(),first,"same-tab reads reuse existing cursor");

    urls["t-cache"]="https://example.com/another-page";
    await run("snapshot");
    assert.equal(evalCount(),first+1,"a changed page always refreshes cursor");

    await run("focus","t-other");
    assert.equal(evalCount(),first+3,"different tab activates cursor and deactivates previous one");
    await run("snapshot","t-other");
    assert.equal(evalCount(),first+3,"new tab reuses fresh cursor");
    await run("snapshot","t-cache");
    assert.equal(evalCount(),first+5,"revisiting old tab reactivates and deactivates previous one");
  } finally {globalThis.fetch=originalFetch;}
});
