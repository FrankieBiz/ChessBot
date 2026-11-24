# Contributing to ChessBot

Thanks for helping improve ChessBot. This guide covers setup, testing, and what a pull request needs.

## Ways to help

- **Report a bug.** Open a [bug report](https://github.com/FrankieBiz/ChessBot/issues/new?template=bug_report.yml). A PGN or Chess.com game link that shows the problem is the most useful thing you can include.
- **Suggest a feature.** Open a [feature request](https://github.com/FrankieBiz/ChessBot/issues/new?template=feature_request.yml) and describe the problem it solves.
- **Send a pull request.** For anything larger than a small fix, open an issue first so we can agree on the approach.

## Development setup

You need:

- [Node.js](https://nodejs.org/) 24 or later
- The `zip` command, for packaging
- Python 3 with NumPy, SciPy, and `zstd`, only if you work on the research scripts

```bash
git clone https://github.com/FrankieBiz/ChessBot.git
cd ChessBot
npm ci
npm test
npm run build
```

Load `dist/chrome` as an unpacked extension in Chrome, or `dist/firefox/manifest.json` as a temporary add-on in Firefox. Rebuild after each change, then reload the extension.

## Code guidelines

- **Keep logic in pure modules.** Grading, tactics, drills, and the models are plain functions with no DOM or browser APIs, so they can be tested in Node.js. `review.js` should stay a thin layer that wires them to the page.
- **Add tests with the change.** Tests live in `tests/` and use the built-in `node:test` runner. `npm test` must pass before you open a pull request.
- **Share feature code between the browser and the scripts.** The training scripts import the same feature functions the extension uses. If you change a model's features, retrain it so the shipped coefficients still match.
- **Use the existing tools.** ChessBot has no framework or bundler. Use ES modules, match the surrounding style, and avoid new dependencies unless they are clearly worth it.
- **Mind both browsers.** Chrome and Firefox share the source code, with separate manifests in `browsers/`. Test in both when you touch extension APIs.

## Engine and model changes need evidence

Changes to grading thresholds, search depth, or any model must show they help on data that wasn't used to make them.

1. Fit or tune on one sample. Report results on a separate held-out sample.
2. Save the benchmark output in `research/`, with the source hashes the scripts record.
3. Update [docs/benchmarks.md](docs/benchmarks.md) with the result and the command that reproduces it, including results that didn't improve.

The existing sections in `docs/benchmarks.md` show the expected format.

## Versions and releases

- The version lives in `package.json`. The build stamps it into both browser manifests and the zip names.
- Record user-facing changes under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
- A release bumps the version, moves the changelog entries under the new version, and tags the commit `vX.Y.Z`. The GitHub release attaches the Chrome and Firefox zips from `npm run build`.

## Commit messages

Use short, imperative subjects with a [Conventional Commits](https://www.conventionalcommits.org/) prefix such as `feat:`, `fix:`, `docs:`, `test:`, or `chore:`. For example, `fix: keep promotion choice in drills`.

## License

ChessBot is licensed under GPL-3.0-or-later. By contributing, you agree that your contributions are licensed the same way.
