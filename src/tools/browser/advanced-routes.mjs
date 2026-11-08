// Extra operations supported by OpenClaw's Browser control API, beyond its agent schema.
export const ADVANCED_BROWSER_ACTIONS = Object.freeze([
  "highlight", "trace", "responsebody", "cookies", "storage", "set", "permissions", "dialogs",
]);
const pick = (args, keys) => Object.fromEntries(keys.filter(key => args[key] !== undefined).map(key => [key, args[key]]));
const requireChoice = (value, choices, name) => {
  if (!choices.includes(value)) throw new Error(name + " must be " + choices.join("|"));
  return value;
};

export function buildAdvancedBrowserRequest(args) {
  if (!ADVANCED_BROWSER_ACTIONS.includes(args.action)) throw new Error("Unsupported advanced browser action");
  if (args.dashboard !== undefined) throw new Error("Advanced operations do not support dashboard bindings; specify a personal Chrome tab instead.");
  if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || args.timeoutMs <= 0 || args.timeoutMs > 110000)) throw new Error("timeoutMs must be a positive integer at most 110000");
  // The personal Chrome route is deliberately pinned, just like ordinary browser calls.
  const query = { profile: "chrome" };
  const body = pick(args, ["targetId", "timeoutMs"]);
  let method = "POST";
  let path;
  switch (args.action) {
    case "highlight":
      if (typeof args.ref !== "string" || !args.ref.trim()) throw new Error("highlight requires ref from a fresh snapshot");
      path = "/highlight"; body.ref = args.ref; break;
    case "trace":
      path = "/trace/" + requireChoice(args.operation, ["start", "stop"], "operation");
      Object.assign(body, pick(args, args.operation === "start" ? ["screenshots", "snapshots", "sources"] : ["path"])); break;
    case "responsebody":
      if (typeof args.url !== "string" || !args.url.trim()) throw new Error("responsebody requires url or URL glob");
      path = "/response/body"; Object.assign(body, pick(args, ["url", "maxChars"])); break;
    case "dialogs":
      path = "/dialogs"; method = "GET"; break;
    case "cookies": {
      const operation = requireChoice(args.operation ?? "get", ["get", "set", "setMany", "clear"], "operation");
      path = "/cookies" + ({get:"", set:"/set", setMany:"/set-many", clear:"/clear"})[operation];
      if (operation === "get") method = "GET";
      if (operation === "set") {
        if (!args.cookie || typeof args.cookie !== "object" || Array.isArray(args.cookie)) throw new Error("cookies set requires cookie");
        body.cookie = args.cookie;
      }
      if (operation === "setMany") {
        if (!Array.isArray(args.cookies) || !args.cookies.length) throw new Error("cookies setMany requires cookies");
        body.cookies = args.cookies;
      }
      break;
    }
    case "storage": {
      const kind = requireChoice(args.storageKind, ["local", "session"], "storageKind");
      const operation = requireChoice(args.operation ?? "get", ["get", "set", "clear"], "operation");
      path = "/storage/" + kind + (operation === "get" ? "" : "/" + operation);
      if (operation === "get") { method = "GET"; Object.assign(body, pick(args, ["key"])); }
      if (operation === "set") {
        if (typeof args.key !== "string" || !args.key.trim() || typeof args.value !== "string") throw new Error("storage set requires nonblank key and string value");
        Object.assign(body, pick(args, ["key", "value"]));
      }
      break;
    }
    case "set": {
      const setting = requireChoice(args.setting, ["offline", "headers", "credentials", "geolocation", "media", "timezone", "locale", "device", "viewport"], "setting");
      const fields = {
        offline:["offline"], headers:["headers"], credentials:["username", "password", "clear"],
        geolocation:["latitude", "longitude", "accuracy", "origin", "clear"], media:["colorScheme"],
        timezone:["timezoneId"], locale:["locale"], device:["device"], viewport:["width", "height"],
      };
      Object.assign(body, pick(args, fields[setting]));
      path = "/set/" + setting;
      if (setting === "device") { body.name = body.device; delete body.device; }
      if (setting === "viewport") { path = "/act"; body.kind = "resize"; }
      break;
    }
    case "permissions":
      path = "/permissions/grant"; Object.assign(body, pick(args, ["origin", "permissions", "optionalPermissions"])); break;
  }
  if (method === "GET") for (const [key, value] of Object.entries(body)) query[key] = String(value);
  return {
    method, path, query, ...(method === "POST" ? { body } : {}),
    ...(args.target || args.action === "cookies" ? { target: requireChoice(args.target ?? "host", ["host", "node"], "target") } : {}),
    ...(args.node ? { node: args.node } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs + 5000 } : {}),
  };
}
