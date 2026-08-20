#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, extname } from "node:path";

try {
  process.loadEnvFile();
} catch {}

const exe = process.env.LLAMA_SERVER_EXE;
const preset = process.env.LLAMA_MODELS_PRESET;
const jinjaFiles = process.env.LLAMA_JINJA_FILES;
const sectionPrefix = process.env.LLAMA_SECTION_PREFIX ?? "";
const port = process.argv[2];
const RETRY_INTERVAL_MS = Number(process.env.LLAMA_JINJA_RETRY_MS) || 1_800_000;

if (!exe || !preset) {
  console.error("Missing LLAMA_SERVER_EXE or LLAMA_MODELS_PRESET. Copy .env.example to .env and fill in paths.");
  process.exit(1);
}

async function resolveJinjaPath(entry, index) {
  if (!/^https?:\/\//i.test(entry)) {
    try {
      readFileSync(entry, "utf8");
      return entry;
    } catch {
      return null;
    }
  }

  try {
    const res = await fetch(entry);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();

    const urlName = basename(new URL(entry).pathname);
    const localPath = join(tmpdir(), urlName || `llama-jinja-${index}.jinja`);
    writeFileSync(localPath, text);
    return localPath;
  } catch {
    return null;
  }
}

function findDuplicateNames(entries) {
  const counts = new Map();
  for (const e of entries) {
    if (!e.path) continue;
    const name = basename(e.path, extname(e.path));
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([name]) => name);
}

function renderPreset(entries) {
  const sections = entries
    .filter((e) => e.path)
    .map((e) => {
      const name = basename(e.path, extname(e.path));
      return `[${sectionPrefix}${name}]\nchat-template-file = ${e.path}\n`;
    });

  const base = readFileSync(preset, "utf8");
  const rendered = sections.length ? `${base.trimEnd()}\n\n${sections.join("\n")}` : base;

  const presetPath = join(tmpdir(), "llama-models-preset.ini");
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

if (jinjaFiles) {
  const rawEntries = jinjaFiles.split(",").map((p) => p.trim()).filter(Boolean);
  entries = await Promise.all(
    rawEntries.map(async (entry, index) => ({ entry, index, path: await resolveJinjaPath(entry, index) }))
  );

  for (const e of entries) {
    if (!e.path) console.error(`Skipping ${e.entry}: not available yet, will retry in background`);
  }

  const duplicates = findDuplicateNames(entries);
  if (duplicates.length) {
    console.error(`Duplicate jinja file name(s): ${duplicates.join(", ")}. Rename the files so each has a unique name.`);
    process.exit(1);
  }

  presetPath = renderPreset(entries);
}

startServer(presetPath);

if (entries.some((e) => !e.path)) {
  const timer = setInterval(async () => {
    let changed = false;
    for (const e of entries) {
      if (e.path) continue;
      const path = await resolveJinjaPath(e.entry, e.index);
      if (path) {
        console.error(`${e.entry} is now available, restarting llama-server`);
        e.path = path;
        changed = true;
      }
    }

    if (changed) {
      const duplicates = findDuplicateNames(entries);
      if (duplicates.length) {
        console.error(`Duplicate jinja file name(s): ${duplicates.join(", ")}. Rename the files so each has a unique name. Skipping restart.`);
      } else {
        presetPath = renderPreset(entries);
        restarting = true;
        child.kill();
        startServer(presetPath);
      }
    }

    if (entries.every((e) => e.path)) clearInterval(timer);
  }, RETRY_INTERVAL_MS);
}
