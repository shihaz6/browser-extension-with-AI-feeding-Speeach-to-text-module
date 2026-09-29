const TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const TRANSCRIPTION_PROMPT = process.env.GROQ_TRANSCRIPTION_PROMPT || "Pharmacy point-of-sale order transcription. The speaker names products, medicine strengths, variants, pack sizes, and quantities. Preserve the spoken product wording and all numbers carefully. The first number in an order item is usually the quantity; later numbers may be part of the product name or strength. Transcribe unfamiliar product names phonetically without replacing them with a more familiar name.";

async function transcribe(file) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    const error = new Error("GROQ_API_KEY is missing. Add it to server/.env and restart the backend.");
    error.statusCode = 503;
    throw error;
  }

  const form = new FormData();
  const audio = new Blob([file.buffer], { type: file.mimetype || "audio/webm" });
  const model = process.env.GROQ_TRANSCRIBE_MODEL || "whisper-large-v3";
  const language = "en";
  const temperature = 0;
  const prompt = TRANSCRIPTION_PROMPT;
  const promptTokensEstimate = prompt.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)?.length || 0;
  if (prompt.length > 800 || promptTokensEstimate > 180) {
    const error = new Error("GROQ_TRANSCRIPTION_PROMPT is too long; shorten it to stay safely below Groq's 224-token prompt limit.");
    error.statusCode = 400;
    throw error;
  }

  form.append("file", audio, file.originalname || "voice-order.webm");
  form.append("model", model);
  form.append("language", language);
  form.append("temperature", String(temperature));
  form.append("prompt", prompt);
  form.append("response_format", "json");
  console.info("[VoicePOS Server] Model:", model);
  console.info("[VoicePOS Server] Language:", language);

  let response;
  try {
    response = await fetch(TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(120000)
    });
  } catch (cause) {
    const error = new Error(`Groq transcription request failed: ${cause.message || "network error"}`);
    error.statusCode = 502;
    throw error;
  }

  const responseText = await response.text();
  let result;
  try { result = JSON.parse(responseText); }
  catch { result = null; }

  if (response.status === 429) {
    const error = new Error("Groq rate limit reached. Wait briefly and try recording again.");
    error.statusCode = 429;
    throw error;
  }
  if (!response.ok) {
    const providerMessage = result?.error?.message || `Groq returned HTTP ${response.status}`;
    const error = new Error(`Groq transcription failed: ${providerMessage}`);
    error.statusCode = 502;
    throw error;
  }
  if (typeof result?.text !== "string") {
    const error = new Error("Groq transcription failed: response did not contain transcript text.");
    error.statusCode = 502;
    throw error;
  }
  console.info("[VoicePOS Server] Transcript:", result.text);
  return result.text;
}

module.exports = { transcribe };
