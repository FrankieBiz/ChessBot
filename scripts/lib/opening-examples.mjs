import { scanArchive } from "./opening-archive.mjs";

const playedGames = ([, whiteWins, draws, blackWins]) => whiteWins + draws + blackWins;
const positionGames = (choices) => choices.reduce((sum, choice) => sum + playedGames(choice), 0);

/** Keep one actual, short continuation for a bounded set of high-support choices. */
export async function sampleOpeningExamples(explorer, archive, limits) {
  const ranked = [...explorer].sort(([a, aChoices], [b, bChoices]) =>
    positionGames(bChoices) - positionGames(aChoices) || (a < b ? -1 : 1));
  const targets = new Map(ranked.slice(0, limits.maxPositions).map(([fen, choices]) => [fen,
    new Map(choices.slice(0, limits.maxChoices)
      .filter((choice) => playedGames(choice) >= limits.minGames)
      .map((choice) => [choice[0], choice])),
  ]));
  let added = 0;
  await scanArchive(archive, (moves, _result, headers) => {
    const gameId = headers.Site?.match(/^https:\/\/lichess\.org\/(?:game\/)?([A-Za-z0-9]{8})$/)?.[1];
    if (!gameId) return;
    for (const [index, { before, uci }] of moves.entries()) {
      const target = targets.get(before)?.get(uci);
      if (!target) continue;
      const line = moves.slice(index, index + limits.plies);
      if (line.length < limits.plies || line.some(({ repeated }) => repeated)) continue;
      const typicalReplies = line.slice(1, 3).every(({ before, uci }) =>
        explorer.get(before)?.some(([move]) => move === uci));
      if (!typicalReplies) continue;
      target.push([gameId, ...line.map(({ uci }) => uci)]);
      targets.get(before).delete(uci);
      added++;
    }
  });
  return added;
}
