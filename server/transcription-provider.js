const groqProvider = require("./providers/groq");

async function transcribeAudio(file) {
  const provider = (process.env.STT_PROVIDER || "groq").toLowerCase();
  if (provider === "groq") return groqProvider.transcribe(file);
  throw new Error(`Unsupported STT_PROVIDER: ${provider}`);
}

module.exports = { transcribeAudio };
