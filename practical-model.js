import { CALIBRATION } from "./calibration-data.js";
import { MISSED_MATE_PRIORITY } from "./tactics.js";

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function parseClockSeconds(comment) {
  const match = comment?.match(/\[%clk\s+(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)\]/);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) ? seconds : null;
}

export function parseTimeControl(value) {
  const match = typeof value === "string" && value.trim().match(/^(\d+)(?:\+(\d+))?$/);
  if (!match) return null;
  const base = Number(match[1]);
  const increment = Number(match[2] ?? 0);
  if (base < 60 || increment > 30 || base + 40 * increment >= 1500) return null;
  return { base, increment };
}

export function practicalImpact(best, played, context, mover) {
  if (!context || context.ply < 8 || context.ply > 120) return null;
  if (best?.type !== "cp" || played?.type !== "cp" ||
      !Number.isFinite(best.value) || !Number.isFinite(played.value)) return null;

  const { ply, timeControl, whiteSeconds, blackSeconds } = context;
  const phase = (ply - 40) / 40;
  const hasClocks = timeControl && Number.isFinite(whiteSeconds) && Number.isFinite(blackSeconds);
  const [intercept, phaseWeight = 0] = CALIBRATION.fallback;
  let logSlope = intercept + phase * phaseWeight;
  let offset = 0;
  if (hasClocks) {
    const { base, increment } = timeControl;
    const white = clamp(whiteSeconds, 0, 3600) + increment + 5;
    const black = clamp(blackSeconds, 0, 3600) + increment + 5;
    const speed = Math.log2((base + 40 * increment) / 300);
    const pressure = clamp(Math.log2(Math.min(white, black) / 60), -3, 3);
    const advantage = clamp(Math.log2(white / black), -3, 3);
    const [clockIntercept, clockPhase, speedWeight, pressureWeight, advantageWeight] = CALIBRATION.clock;
    logSlope = clockIntercept + clockPhase * phase + speedWeight * speed + pressureWeight * pressure;
    offset = advantageWeight * advantage;
  }

  const slope = Math.exp(logSlope);
  // Both candidate evaluations use the same recorded time context.
  const scoreWhite = (cp) => 100 / (1 + Math.exp(-(slope * clamp(cp / 100, -10, 10) + offset)));
  const sign = mover === "w" ? 1 : -1;
  const loss = Math.max(0, sign * (scoreWhite(best.value) - scoreWhite(played.value)));
  return { loss, model: hasClocks ? "clock" : "position" };
}

export function trainingPriority(review) {
  const loss = Math.max(review.winLoss, review.practicalImpact?.loss ?? 0);
  return review.missedMate?.drill ? Math.max(loss, MISSED_MATE_PRIORITY) : loss;
}
