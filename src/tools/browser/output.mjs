// Keep large Browser responses valid JSON; never expose a cut cookie value as
// a text preview. Callers can narrow cookie reads by name or response bodies by size.
export function boundBrowserResult(details, maxChars=12000) {
  const json=JSON.stringify(details,(_key,value)=>typeof value==="string"?value.replace(/(^|\n)([^\S\n]*)(MEDIA:)/gi,"$1$2[neutralized] $3"):value,2);
  if(json.length<=maxChars)return {json,truncated:false};
  return {json:JSON.stringify({
    ok:details.ok??true,targetId:details.targetId,truncated:true,
    ...(Array.isArray(details.cookies)?{cookieCount:details.cookies.length}:{}),
    message:"Result exceeds the output budget. Narrow the cookie name filter, URL, or maxChars and retry.",
  },null,2),truncated:true};
}
