// A Web Worker stand-in for Stockfish.js or a native UCI reference executable.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class StockfishCliWorker {
  constructor(path) {
    const isJavaScript = path.endsWith(".js");
    this.process = spawn(isJavaScript ? process.execPath : path, isJavaScript ? [path] : [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.searches = [];
    this.reference = false;
    this.pendingBarrier = null;
    this.closed = false;
    let stderr = "";
    this.process.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4000); });
    this.process.on("error", (error) => this.fail(error));
    this.process.stdin.on("error", (error) => this.fail(error));
    this.process.on("close", (code, signal) => {
      this.fail(new Error(`Stockfish exited (${code ?? signal})${stderr ? `\n${stderr}` : ""}`));
    });
    createInterface({ input: this.process.stdout }).on("line", (data) => {
      if (data === "readyok") this.pendingBarrier?.resolve();
      const nodes = data.match(/\bnodes (\d+)/)?.[1];
      const search = this.searches.at(-1);
      if (nodes && search) search.nodes = Math.max(search.nodes, Number(nodes));
      this.onmessage?.({ data });
    });
  }

  fail(error) {
    if (this.closed) return;
    this.pendingBarrier?.reject(error);
    this.onerror?.(error);
  }

  postMessage(command) {
    if (command.startsWith("go ")) {
      if (this.reference) command = command.replace(/\s+nodes \d+\b/, "");
      this.searches.push({ command, nodes: 0 });
    }
    this.process.stdin.write(command + "\n");
  }

  async clearHash() {
    let timer;
    try {
      await new Promise((resolve, reject) => {
        this.pendingBarrier = { resolve, reject };
        timer = setTimeout(() => reject(new Error("Stockfish hash reset timed out")), 30_000);
        this.postMessage("ucinewgame");
        this.postMessage("isready");
      });
    } finally {
      clearTimeout(timer);
      this.pendingBarrier = null;
    }
  }

  terminate() {
    this.closed = true;
    this.pendingBarrier?.reject(new Error("Stockfish terminated"));
    this.process.kill();
  }
}
