const { spawn } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const ffmpegPath = require("ffmpeg-static");

const AUDIO_FILTERS = [
  "highpass=f=80",
  "lowpass=f=8000",
  "afftdn",
  "loudnorm=I=-18:TP=-2:LRA=11",
  "aformat=sample_fmts=s16:sample_rates=16000:channel_layouts=mono"
].join(",");

function extensionFor(file) {
  const mime = String(file?.mimetype || "").split(";")[0].toLowerCase();
  if (mime.includes("ogg")) return ".ogg";
  if (mime.includes("wav")) return ".wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return ".mp3";
  if (mime.includes("mp4") || mime.includes("x-m4a")) return ".m4a";
  return ".webm";
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function preprocessAudio(file) {
  if (!ffmpegPath) throw new Error("ffmpeg-static did not provide an executable path.");

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-pos-audio-"));
  const inputPath = path.join(tempDir, `input${extensionFor(file)}`);
  const outputPath = path.join(tempDir, "cleaned.wav");

  try {
    await fs.writeFile(inputPath, file.buffer);
    await runFfmpeg([
      "-hide_banner",
      "-loglevel", "warning",
      "-y",
      "-i", inputPath,
      "-vn",
      "-af", AUDIO_FILTERS,
      "-acodec", "pcm_s16le",
      outputPath
    ]);

    const buffer = await fs.readFile(outputPath);
    if (!buffer.length) throw new Error("ffmpeg produced an empty cleaned audio file.");
    return {
      ...file,
      buffer,
      size: buffer.length,
      mimetype: "audio/wav",
      originalname: "voice-order-cleaned.wav",
      preprocessing: "cleaned"
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { preprocessAudio };
