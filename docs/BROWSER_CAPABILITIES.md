# Browser capabilities

Use `openclaw_browser` to control personal Chrome tabs through the OpenClaw extension. This guide covers the additional actions and visual feedback provided by the bridge.

## Actions

Observe the page first, then use its current element references. Supply `tabId` or `targetId` to identify the intended tab; cookie compatibility operations require one explicitly.

| Action | Use | Key arguments |
| --- | --- | --- |
| `highlight` | Mark an element | `ref` |
| `trace` | Start or stop a trace | `operation=start\|stop`; optional `screenshots`, `snapshots`, `sources`; `path` on stop |
| `responsebody` | Wait for a matching network response and read its body | `url` (exact or glob), `maxChars`, `timeoutMs` |
| `dialogs` | Inspect pending dialogs | `tabId` |
| `cookies` | Read or write cookies; clear where supported | `operation=get\|set\|setMany\|clear`, `cookie` or `cookies` |
| `storage` | Read, write or clear page storage | `storageKind=local\|session`, `operation=get\|set\|clear`, `key`, `value` |
| `set` | Change environment settings | `setting=offline\|headers\|credentials\|geolocation\|media\|timezone\|locale\|device\|viewport` and the corresponding values |
| `permissions` | Grant explicitly requested permissions | `origin`, `permissions`, optional `optionalPermissions` |
| `effects` | Enable or hide visual feedback | `enabled=true\|false` |

Cookie and storage operations default to `get`. Clear them only when requested: doing so can affect signed-in pages. Restore temporary environment settings after testing. A trace can include other tabs in the same browser context.

## Visual feedback

Browser input can show a purple AI cursor, element outline, click ring, short movement trail and border inside the page. These effects are added by this bridge, work inside the web page, and do not move the operating-system cursor.

To hide them for the current document:

```json
{"action":"effects","tabId":"t1","enabled":false}
```

Use `enabled=true` to restore them. Navigation creates a fresh document. Set `visualFeedback=false` on an input call to skip feedback setup for that call.

Effects require page evaluation to be enabled in OpenClaw. Restricted Chrome pages, navigation and some frames can prevent them from appearing; unavailable feedback does not block the input action. Reduced-motion preferences limit animation. The indicator can also react to user input during an automation call, so it does not prove who performed an action or whether it succeeded.

## Compatibility and limits

- **Cookies:** On the verified OpenClaw 2026.10.10-beta.3 and Store extension 2.3.0 setup, the bridge handles missing cookie commands through a compatible local tab connection, including HttpOnly cookies. Supply an explicit tab. Reads are limited to its HTTP(S) URL; optional `url` must have the same origin and `filter` narrows cookie names. Writes must match that origin/host. Clearing all cookies is unavailable through this compatibility path. A remote-node request never switches to the local browser.
- **Large results:** Oversized responses return a size notice instead of partial JSON. Narrow the cookie-name filter or reduce `maxChars` for response bodies.
- **Response bodies:** `responsebody` waits for a future response. Start it before triggering the request; it cannot retrieve an already-finished response.
- **Availability:** OpenClaw's Browser plugin, permissions and tool policy must allow the operation. Authentication and access errors remain errors.
- **Scope:** Live screencasting and browser-profile management are not provided by these added actions. CUA browser tools are separate.

The Store extension and installed OpenClaw files do not need local modifications for these features.
