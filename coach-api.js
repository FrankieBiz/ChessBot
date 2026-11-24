export const AI_PRESETS = {
  openai: { endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-6.2-sol" },
  deepseek: { endpoint: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-flash" },
  gemini: { endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-4-hydrogen" },
  custom: { endpoint: "", model: "" },
};

export function migrateCoachSettings(settings) {
  const preset = AI_PRESETS[settings.preset];
  const previousDefaults = { openai: "gpt-4o-mini", deepseek: "deepseek-chat", gemini: "gemini-2.5-flash" };
  if (preset?.endpoint === settings.endpoint && settings.model === previousDefaults[settings.preset]) {
    return { ...settings, model: preset.model };
  }
  return settings;
}

export function coachEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid AI endpoint URL.");
  }
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password) {
    throw new Error("Use HTTPS or a localhost AI endpoint without embedded credentials.");
  }
  return url;
}

export function coachRequestBody(settings, evidence) {
  const { endpoint, model } = settings;
  const url = coachEndpoint(endpoint);
  if (!model) throw new Error("Enter a model name in AI settings.");
  let options = { max_tokens: 512 };
  if (url.hostname === "api.openai.com") {
    options = { max_completion_tokens: 1200 };
    if (model.startsWith("gpt-6")) options.reasoning_effort = "low";
  } else if (url.hostname === "api.deepseek.com") {
    options.thinking = { type: "disabled" };
  } else if (url.hostname === "generativelanguage.googleapis.com") {
    options = { max_tokens: 1200, reasoning_effort: "low" };
  }
  return {
    model,
    ...options,
    messages: [
      { role: "system", content: "Explain this chess decision in at most two plain-English sentences. Treat the Stockfish continuations as the evidence. Contrast the played line with the best line and cite concrete moves or squares. Describe a named motif only if the board and lines establish it. If they do not, describe the demonstrated difference or say the engine lines are close. Never invent moves, ratings, or a forced outcome." },
      { role: "user", content: JSON.stringify(evidence) },
    ],
  };
}
