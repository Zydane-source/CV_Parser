/**
 * Runs the Next.js dev server and the background worker together.
 *   npm run dev:all
 *
 * Forgetting the worker is the most common reason CVs sit in "Pending", so the
 * default development entry point starts both and prefixes their output.
 */
import { spawn } from "node:child_process";
import process from "node:process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const procs = [
  { name: "web   ", color: "[36m", args: ["run", "dev"] },
  { name: "worker", color: "[35m", args: ["run", "worker"] },
];

const children = [];
let shuttingDown = false;

for (const p of procs) {
  const child = spawn(npm, p.args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  children.push(child);

  const prefix = `${p.color}[${p.name}][0m `;
  const pipe = (stream, out) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) out.write(prefix + line + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on("exit", (code) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    shutdown(code ?? 1);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (!c.killed) c.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 500);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
