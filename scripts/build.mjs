import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const at = (...parts) => join(root, ...parts);
const browsers = ["chrome", "firefox"];
const { version } = JSON.parse(await readFile(at("package.json"), "utf8"));
const chessModule = at("node_modules", "chess.js", "dist", "esm", "chess.js");
const engineBase = "stockfish-19-single";

async function copyChess(vendor) {
  await mkdir(join(vendor, "chess.js"), { recursive: true });
  await cp(chessModule, join(vendor, "chess.js", "chess.js"));
}

if (process.argv[2] === "--test") {
  await copyChess(at("vendor"));
} else {
  const files = ["analysis.js", "background.js", "board-setup.js", "calibration-data.js", "coach-api.js", "coach.js", "content.css", "content.js", "decision-quality.js", "deck.js", "difficulty-data.js", "difficulty-model.js", "drills.js", "engine.js", "human-move-data.js", "human-move-model.js", "icons", "practical-model.js", "review.css", "review.html", "review.js", "tactics.js", "training-store.js", "variation.js", "weakness.js"];
  await Promise.all(browsers.map(async (browser) => {
    const stage = at("dist", browser);
    const vendor = join(stage, "vendor");
    const engineDir = join(vendor, "stockfish");
    await mkdir(engineDir, { recursive: true });
    await Promise.all([
      ...files.map((name) => cp(at(name), join(stage, name), { recursive: true })),
      copyChess(vendor),
      cp(at("node_modules", "cm-chessboard", "src"), join(vendor, "cm-chessboard", "src"), { recursive: true }),
      cp(at("node_modules", "cm-chessboard", "assets"), join(vendor, "cm-chessboard", "assets"), { recursive: true }),
      cp(at("LICENSE"), join(stage, "LICENSE")),
      cp(at("node_modules", "chess.js", "LICENSE"), join(vendor, "chess.js", "LICENSE")),
      cp(at("node_modules", "cm-chessboard", "LICENSE"), join(vendor, "cm-chessboard", "LICENSE")),
      cp(at("node_modules", "stockfish", "Copying.txt"), join(engineDir, "COPYING.txt")),
      ...["js", "wasm"].map((ext) => cp(at("node_modules", "stockfish", "bin", `${engineBase}.${ext}`), join(engineDir, `${engineBase}.${ext}`))),
      writeFile(join(engineDir, "engine-config.js"), `export const STOCKFISH_WORKER_PATH = "./vendor/stockfish/${engineBase}.js";\n`),
      writeFile(join(engineDir, "SOURCE.txt"), "Stockfish.js 19.0.1 corresponding source and build scripts\nhttps://github.com/nmrugg/stockfish.js/tree/v19.0.1\n"),
    ]);
    if (browser === "firefox") {
      await cp(at("browsers", browser, "background.js"), join(stage, "background.js"));
    }
    const manifest = JSON.parse(await readFile(at("browsers", browser, "manifest.json"), "utf8"));
    manifest.version = version;
    await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const archive = at("dist", `chessbot-${browser}-v${version}.zip`);
    execFileSync("zip", ["-q", "-r", "-FS", archive, "."], { cwd: stage });
    console.log(`Built dist/${basename(archive)}`);
  }));
}
