#!/usr/bin/env node
import { spawn } from "node:child_process";

const envIdx = process.argv.indexOf("--env");
const suffix = envIdx !== -1 ? process.argv.splice(envIdx, 2)[1] : (process.argv.splice(2, 1)[0] ?? "");
const envFile = suffix ? `.env.${suffix}` : ".env";
try { process.loadEnvFile(envFile); } catch {
  if (!suffix) try { process.loadEnvFile(".env.main"); } catch {
    console.error("Usage: npm run embed -- <suffix>  (loads .env.<suffix>)");
    process.exit(1);
  }
  else { console.error(`Cannot load ${envFile}`); process.exit(1); }
}

const exe = process.env.LLAMA_SERVER_EXE;
const model = process.env.LLAMA_EMBED_MODEL;
const port = process.argv[2] ?? process.env.LLAMA_EMBED_PORT_DEFAULT ?? "8081";
const host = process.env.LLAMA_EMBED_HOST ?? "127.0.0.1";
const ngl = process.env.LLAMA_EMBED_NGL ?? "99";

if (!exe || !model) {
  console.error("Missing LLAMA_SERVER_EXE or LLAMA_EMBED_MODEL. Copy .env.example to .env and fill in paths.");
  process.exit(1);
}

const args = ["--model", model, "--embedding", "--pooling", "mean", "--embd-normalize", "2", "--ctx-size", "4096", "--ubatch-size", "4096", "--port", port, "--host", host, "-ngl", ngl];

const child = spawn(exe, args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
