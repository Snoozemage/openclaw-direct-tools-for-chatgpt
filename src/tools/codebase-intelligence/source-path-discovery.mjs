/**
 * Generic, lexical business-query navigation across indexed file paths.
 * Matching a source path is a navigation hint, never evidence of feature
 * equivalence, execution, or cross-repository communication.
 */
const FILLER = new Set(["theo","cua","cho","ve","voi","trong","tren","va","nhung","cac","mot","nhieu","duoc","can","muon","toi","minh","he","thong","chuc","nang"]);
const GENERIC_PREFIXES = [
  ["quan","ly"],["tra","cuu"],["tim","kiem"],["cho","toi","xem"],
];
function words(value) {
  return String(value??"")
    .replace(/([a-z0-9])([A-Z])/gu,"$1 $2")
    .normalize("NFD").replace(/[\u0300-\u036f]/gu,"")
    .replace(/[đĐ]/gu,"d").toLocaleLowerCase("vi")
    .match(/[a-z0-9]+/gu)?.map(word=>
      word.length>4&&/s$/u.test(word)&&!/(ss|us|is)$/u.test(word)?word.slice(0,-1):word)??[];
}
function significantQueryTerms(query){
  const raw=words(query);
  const prefix=GENERIC_PREFIXES.find(p=>p.every((token,i)=>raw[i]===token));
  const tokens=(prefix?raw.slice(prefix.length):raw).filter(x=>!FILLER.has(x));
  return tokens.slice(0,16);
}
function longestSpan(needle,haystack){
  let match={length:0,start:0};
  for(let i=0;i<needle.length;i++){
    for(let j=0;j<haystack.length;j++){
      let run=0;
      while(i+run<needle.length&&j+run<haystack.length&&
        needle[i+run]===haystack[j+run])run++;
      if(run>match.length)match={length:run,start:i};
    }
  }
  return match;
}
function roleRank(p) {
  if(/\/(?:app|pages)\/.*\/page\.tsx?$/u.test(p))
    return /\/\[[^/]+\]\/page\.tsx?$/u.test(p)?1:0;
  if(/\/features\/[^/]+\/(?:list|main)-view-page\.tsx?$/u.test(p))return 2;
  if(/\/features\/[^/]+\/detail-view-page\.tsx?$/u.test(p))return 3;
  if(/\/views\/.*\/index\.blade\.php$/u.test(p))return 3;
  if(/\/services\//u.test(p))return 4;
  if(/\/(?:api\/controllers|http\/controllers)\//u.test(p))return 4;
  if(/\/(?:mocks|migrations|seeders|tests|__tests__)\//u.test(p))return 9;
  if(/\/features\/[^/]+\/components\//u.test(p))return 8;
  if(/\/views\//u.test(p))return 5;
  if(/\/(?:queries|commands)\//u.test(p))return 5;
  if(/\/features\//u.test(p))return 6;
  return 7;
}
export function rankUnmappedSourcePaths(query,files,{repoIds=[],languages=[],limit=60}={}) {
  const terms=significantQueryTerms(query);
  if(terms.length<2)return [];
  const result=[];
  for(const file of files) {
    if((repoIds.length&&!repoIds.includes(file.repoId))||
       (languages.length&&!languages.includes(file.language)))continue;
    const p=file.relativePath.replaceAll("\\","/");
    const segments=p.split("/").map(words);
    let best={length:0,start:0};
    for(const segment of segments){
      const match=longestSpan(terms,segment);
      if(match.length>best.length)best=match;
    }
    const longest=best.length,coverage=longest/terms.length;
    // Two contiguous words and at least half of the meaningful query are
    // necessary. A generic word hit (e.g. "assessment") cannot assert topic.
    if(longest<2||coverage<0.5)continue;
    const role=roleRank(p.toLocaleLowerCase("vi"));
    result.push({...file,role,coverage,longest,
      matchedTerms:terms.slice(best.start,best.start+longest).join(" "),
      rank:longest*100+coverage*30-role*5});
  }
  return result.sort((a,b)=>b.rank-a.rank||a.relativePath.localeCompare(b.relativePath))
    .slice(0,limit);
}
