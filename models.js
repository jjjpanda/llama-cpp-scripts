#!/usr/bin/env node
import { readFileSync } from "node:fs";

try {
  process.loadEnvFile();
} catch {}

const preset = process.env.LLAMA_MODELS_PRESET;

if (!preset) {
  console.error("Missing LLAMA_MODELS_PRESET. Copy .env.example to .env and fill in paths.");
  process.exit(1);
}

const text = readFileSync(preset, "utf8");
for (const match of text.matchAll(/^\[(.+)\]$/gm)) {
  if (match[1] === "*") continue;
  console.log(match[1]);
}
