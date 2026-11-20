import process from "node:process";
import { bridgeEnvironment, readLinuxConfig } from "./core.mjs";

const config = await readLinuxConfig();
Object.assign(process.env, bridgeEnvironment(config));
await import("../../src/server.mjs");
