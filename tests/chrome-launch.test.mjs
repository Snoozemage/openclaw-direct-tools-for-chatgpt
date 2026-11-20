import test from "node:test";
import assert from "node:assert/strict";
import { chromeLaunchCandidates } from "../src/tools/browser/chrome-launch.mjs";

test("Chrome launch candidates cover standard Windows install locations", () => {
  assert.deepEqual(chromeLaunchCandidates({
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
  }, "win32"), [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
  ]);
});

test("Chrome launch candidates omit unavailable environment paths", () => {
  assert.deepEqual(chromeLaunchCandidates({}, "win32"), []);
});
