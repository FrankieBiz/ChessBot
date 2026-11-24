# Security policy

## Supported versions

Security fixes go into the latest release.

| Version | Supported |
| --- | --- |
| 3.4.x | Yes |
| Earlier | No |

## Reporting a vulnerability

Please don't report security problems in public issues. Use GitHub's private reporting instead:

1. Open the repository's [Security tab](https://github.com/FrankieBiz/ChessBot/security).
2. Select **Report a vulnerability**.
3. Describe the problem, the affected version and browser, and how to reproduce it.

You should get a reply within seven days. Once a fix is released, the report can be published with credit to you, if you'd like.

## Scope

Reports are especially welcome about:

- API keys for AI providers, which are stored in extension storage and should only ever be sent to the provider the user chose
- Content injected into Chess.com pages
- Parsing of PGNs and Chess.com game data
- Host permissions requested at runtime

Problems in Stockfish, chess.js, or cm-chessboard themselves should go to those projects. Tell us too if ChessBot ships an affected version.
