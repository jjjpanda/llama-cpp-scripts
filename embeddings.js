#!/usr/bin/env node
import { spawn } from "node:child_process";

try {
  process.loadEnvFile();
} catch {}

const exe = process.env.LLAMA_SERVER_EXE;
const model = process.env.LLAMA_EMBED_MODEL;
const port = process.env.LLAMA_EMBED_PORT ?? "8081";
const host = process.env.LLAMA_EMBED_HOST ?? "127.0.0.1";
const ngl = process.env.LLAMA_EMBED_NGL ?? "99";

if (!exe || !model) {
  console.error("Missing LLAMA_SERVER_EXE or LLAMA_EMBED_MODEL. Copy .env.example to .env and fill in paths.");
  process.exit(1);
}

const args = ["--model", model, "--embedding", "--port", port, "--host", host, "-ngl", ngl];

const child = spawn(exe, args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
