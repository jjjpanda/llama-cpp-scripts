#!/usr/bin/env node
import { readFileSync } from "node:fs";

const envIdx = process.argv.indexOf("--env");
const suffix = envIdx !== -1 ? process.argv.splice(envIdx, 2)[1] : (process.argv.splice(2, 1)[0] ?? "");
const envFile = suffix ? `.env.${suffix}` : ".env";
try { process.loadEnvFile(envFile); } catch {
  if (!suffix) try { process.loadEnvFile(".env.main"); } catch {
    console.error("Usage: npm run models -- <suffix>  (loads .env.<suffix>)");
    process.exit(1);
  }
  else { console.error(`Cannot load ${envFile}`); process.exit(1); }
}

const preset = process.env.LLAMA_MODELS_PRESET;
const port = process.env.LLAMA_PORT ?? "8080";

if (!preset) {
  console.error("Missing LLAMA_MODELS_PRESET. Copy .env.example to .env and fill in paths.");
  process.exit(1);
}

const text = readFileSync(preset, "utf8");
for (const match of text.matchAll(/^\[(.+)\]$/gm)) {
  if (match[1] === "*") continue;
  console.log(`:${port}  ${match[1]}`);
}
