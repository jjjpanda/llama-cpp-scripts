#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { gguf } from "@huggingface/gguf";

const suffixes = [];
let _i;
while ((_i = process.argv.indexOf("--env")) !== -1)
  suffixes.push(process.argv.splice(_i, 2)[1]);
if (!suffixes.length)
  suffixes.push(process.argv.splice(2, 1)[0] ?? "");

const envPath = (s) => s ? `.env.${s}` : ".env";

if (suffixes.length > 1) {
  const parsePort = (f) => {
    try {
      for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
        const m = line.match(/^LLAMA_PORT\s*=\s*(.+)/);
        if (m) return m[1].trim();
      }
    } catch {}
    return null;
  };
  const ports = suffixes.map(s => parsePort(envPath(s)) ?? "8080");
  const seen = new Map();
  for (let j = 0; j < ports.length; j++) {
    if (seen.has(ports[j])) {
      console.error(`Port collision: "${suffixes[j]}" and "${seen.get(ports[j])}" both use port ${ports[j]}`);
      process.exit(1);
    }
    seen.set(ports[j], suffixes[j]);
  }
  const self = fileURLToPath(import.meta.url);
  const children = suffixes.map(s =>
    spawn(process.execPath, [self, "--env", s], { stdio: "inherit" })
  );
  const codes = await Promise.all(children.map(c => new Promise(r => c.on("exit", r))));
  process.exit(codes.find(c => c !== 0) ?? 0);
}

const envFile = envPath(suffixes[0]);
try { process.loadEnvFile(envFile); } catch {
  if (!suffixes[0]) try { process.loadEnvFile(".env.main"); } catch {
    console.error("Usage: npm run chat -- <suffix>  (loads .env.<suffix>)");
    process.exit(1);
  }
  else { console.error(`Cannot load ${envFile}`); process.exit(1); }
}

const exe = process.env.LLAMA_SERVER_EXE;
const preset = process.env.LLAMA_MODELS_PRESET;
const systemPrompts = process.env.LLAMA_SYSTEM_PROMPTS;
const sectionPrefix = process.env.LLAMA_SECTION_PREFIX ?? "";
const port = process.argv[2] ?? process.env.LLAMA_PORT;
const RETRY_INTERVAL_MS = Number(process.env.LLAMA_PROMPT_RETRY_MS) || 1_800_000;

if (!exe || !preset) {
  console.error("Missing LLAMA_SERVER_EXE or LLAMA_MODELS_PRESET. Copy .env.example to .env and fill in paths.");
  process.exit(1);
}

const isUrl = (entry) => /^https?:\/\//i.test(entry);

async function readPrompt(entry) {
  try {
    if (!isUrl(entry)) return readFileSync(entry, "utf8");
    const res = await fetch(entry);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } catch {
    return null;
  }
}

async function readDefaultTemplate() {
  const star = readFileSync(preset, "utf8").split(/^\[/m).find((s) => s.startsWith("*]"));
  const model = star?.match(/^model\s*=\s*(.+)$/m)?.[1].trim();
  if (!model) throw new Error("no model in [*] section");
  const { metadata } = await gguf(model, { allowLocalFile: true });
  const template = metadata["tokenizer.chat_template"];
  if (!template) throw new Error(`no chat template in ${model}`);
  return template;
}

const promptPrefix = (prompt) => `{%- set default_system_prompt = ${JSON.stringify(prompt.trim())} -%}
{%- if messages[0]['role'] not in ['system', 'developer'] -%}
    {%- set messages = [{'role': 'system', 'content': default_system_prompt}] + messages -%}
{%- endif -%}
`;

function findDuplicateNames(entries) {
  const counts = new Map();
  for (const e of entries) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([name]) => name);
}

const tag = suffixes[0] ? `-${suffixes[0]}` : "";

function renderPreset(entries, template) {
  const sections = entries
    .filter((e) => e.text)
    .map((e) => {
      const path = join(tmpdir(), `llama-sys${tag}-${e.name}.jinja`);
      writeFileSync(path, promptPrefix(e.text) + template);
      return `[${sectionPrefix}${e.name}]\nchat-template-file = ${path}\n`;
    });

  const base = readFileSync(preset, "utf8");
  const rendered = sections.length ? `${base.trimEnd()}\n\n${sections.join("\n")}` : base;

  const presetPath = join(tmpdir(), `llama-models-preset${tag}.ini`);
  writeFileSync(presetPath, rendered);
  return presetPath;
}

let child;
let restarting = false;

function startServer(presetPath) {
  const args = ["--models-preset", presetPath];
  if (port) args.push("--port", port);
  child = spawn(exe, args, { stdio: "inherit" });
  child.on("exit", (code) => {
    if (restarting) {
      restarting = false;
      return;
    }
    process.exit(code ?? 0);
  });
}

let entries = [];
let presetPath = preset;
let template;

if (systemPrompts) {
  try {
    template = await readDefaultTemplate();
  } catch (err) {
    console.error(`Cannot read chat template of the [*] model: ${err.message}`);
    process.exit(1);
  }

  entries = await Promise.all(
    systemPrompts.split(",").map((p) => p.trim()).filter(Boolean).map(async (entry) => ({
      entry,
      name: basename(isUrl(entry) ? new URL(entry).pathname : entry, extname(entry)),
      text: await readPrompt(entry),
    }))
  );

  for (const e of entries) {
    if (!e.text) console.error(`Skipping ${e.entry}: not available yet, will retry in background`);
  }

  const duplicates = findDuplicateNames(entries);
  if (duplicates.length) {
    console.error(`Duplicate system prompt name(s): ${duplicates.join(", ")}. Rename the files so each has a unique name.`);
    process.exit(1);
  }

  presetPath = renderPreset(entries, template);
}

startServer(presetPath);

if (entries.some((e) => !e.text)) {
  const timer = setInterval(async () => {
    let changed = false;
    for (const e of entries) {
      if (e.text) continue;
      const text = await readPrompt(e.entry);
      if (text) {
        console.error(`${e.entry} is now available, restarting llama-server`);
        e.text = text;
        changed = true;
      }
    }

    if (changed) {
      presetPath = renderPreset(entries, template);
      restarting = true;
      child.kill();
      startServer(presetPath);
    }

    if (entries.every((e) => e.text)) clearInterval(timer);
  }, RETRY_INTERVAL_MS);
}
