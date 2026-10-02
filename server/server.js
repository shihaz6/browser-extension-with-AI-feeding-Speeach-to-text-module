require("dotenv").config();

const cors = require("cors");
const express = require("express");
const multer = require("multer");
const { preprocessAudio } = require("./audio-preprocessor");
const { transcribeAudio } = require("./transcription-provider");
const { evaluateRerank } = require("./rerank-service");

const app = express();
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "localhost";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    const baseMimeType = (file.mimetype || "").split(";")[0].trim();
    const supported = /^(audio\/(webm|ogg|wav|mpeg|mp4|mp3|x-m4a)|video\/webm|application\/octet-stream)$/i.test(baseMimeType);
    callback(supported ? null : new Error(`Unsupported audio content type: ${file.mimetype || "unknown"}`), supported);
  }
});

// Development-only CORS: reflect the requesting origin so the POS page and
// extension content script can call the loopback backend during local testing.
app.use(cors({ origin: true, methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json({ limit: "128kb" }));

app.get("/health", (_request, response) => response.json({ ok: true }));

function audioDiagnostics(originalFile, audioFile, preprocessStatus) {
  return {
    status: preprocessStatus,
    profile: audioFile.preprocessingProfile || "none",
    originalBytes: originalFile.size || originalFile.buffer?.length || 0,
    processedBytes: audioFile.size || audioFile.buffer?.length || 0,
    originalMimeType: originalFile.mimetype || "unknown",
    processedMimeType: audioFile.mimetype || "unknown"
  };
}

app.post("/transcribe", upload.single("audio"), async (request, response) => {
  if (!request.file || request.file.size === 0) {
    return response.status(400).json({ error: "Upload a non-empty audio file in multipart field 'audio'." });
  }

  try {
    let audioFile = request.file;
    let audioPreprocess = "original";
    try {
      audioFile = await preprocessAudio(request.file);
      audioPreprocess = audioFile.preprocessing || "cleaned";
      console.info("[VoicePOS server] Audio preprocessing:", audioDiagnostics(request.file, audioFile, audioPreprocess));
    } catch (preprocessError) {
      audioPreprocess = "fallback_original";
      console.warn("[VoicePOS server] Audio preprocessing failed; using original audio:", {
        ...audioDiagnostics(request.file, request.file, audioPreprocess),
        error: preprocessError.message
      });
    }

    const text = await transcribeAudio(audioFile);
    return response.json({ text, audioPreprocess, audioDiagnostics: audioDiagnostics(request.file, audioFile, audioPreprocess) });
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 502;
    console.error("[VoicePOS server] Transcription failed:", error.message);
    return response.status(status).json({ error: error.message || "Transcription failed." });
  }
});

app.post("/rerank", async (request, response) => {
  const result = await evaluateRerank(request.body);
  console.info("[VoicePOS Server] Rerank outcome:", result);
  return response.json(result);
});

app.use((error, _request, response, _next) => {
  const status = error instanceof multer.MulterError ? 400 : (error.statusCode || 400);
  response.status(status).json({ error: error.message || "Request failed." });
});

app.listen(port, host, () => {
  console.log(`[VoicePOS server] Listening at http://${host}:${port}`);
});
