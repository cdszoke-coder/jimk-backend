'use strict';

/**
 * src/services/whisperTranscribe.js
 *
 * Speech-to-text for testimonies with WORD-LEVEL timestamps.
 * Uses OpenAI-compatible transcription APIs (OpenAI, Groq, etc.) via the
 * audio.transcriptions endpoint.
 *
 * Key robustness behavior:
 * - If the source is a VIDEO container (mov/mp4/webm/mpeg/...) or an
 *   unsupported extension, extract/downmix the AUDIO track to a temporary mp3
 *   before uploading to Whisper. This avoids provider 400s like
 *   "file must be one of..." for .mov uploads and keeps payload size smaller.
 * - If a supported audio file is still too large, it is re-encoded to compact
 *   mono mp3 first.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); }
catch (_) { /* optional; only needed for normalization */ }

const API_KEY = process.env.WHISPER_API_KEY || '';
const ENDPOINT = process.env.WHISPER_ENDPOINT || 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = process.env.WHISPER_MODEL || 'whisper-1';

const NATIVE_AUDIO_EXTS = new Set(['.flac', '.mp3', '.mpga', '.m4a', '.ogg', '.opus', '.wav']);
const PROVIDER_ALLOWED_EXTS = new Set(['.flac', '.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.ogg', '.opus', '.wav', '.webm']);

function isAvailable() {
  return !!API_KEY;
}

function extOf(filePath) {
  return path.extname(String(filePath || '')).toLowerCase();
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg-static is not installed on the server.'));
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += String(d); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(-1200)}`));
    });
  });
}

async function normalizeForWhisper(inputPath) {
  const ext = extOf(inputPath);
  const stat = fs.statSync(inputPath);

  // Keep direct path only for already-supported AUDIO files comfortably under cap.
  if (NATIVE_AUDIO_EXTS.has(ext) && stat.size <= 24 * 1024 * 1024) {
    return { uploadPath: inputPath, cleanup: () => {} };
  }

  // For video containers (.mov/.mp4/.webm/...) and oversized audio, extract audio.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimk_whisper_'));
  const outPath = path.join(tmpDir, 'whisper-input.mp3');

  // 64 kbps mono 16k is plenty for speech transcription and keeps files small.
  // -vn strips video if present.
  await runFfmpeg([
    '-y',
    '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-b:a', '64k',
    outPath
  ]);

  const outStat = fs.statSync(outPath);
  if (outStat.size > 25 * 1024 * 1024) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    throw new Error(`Normalized audio is ${Math.round(outStat.size / 1048576)}MB — provider cap is 25MB. Split or compress first.`);
  }

  return {
    uploadPath: outPath,
    cleanup: () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  };
}

/**
 * Transcribe an audio/video file with word-level timestamps.
 * @param {string} audioPath absolute path on disk
 * @returns {Promise<{text:string, words:Array, language:string}>}
 */
async function transcribeWithWordTimestamps(audioPath) {
  if (!API_KEY) throw new Error('WHISPER_API_KEY is not set');
  if (!audioPath || !fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const { uploadPath, cleanup } = await normalizeForWhisper(audioPath);
  try {
    const uploadStat = fs.statSync(uploadPath);
    if (uploadStat.size > 25 * 1024 * 1024) {
      throw new Error(`Audio file is ${Math.round(uploadStat.size / 1048576)}MB — provider cap is 25MB. Split or compress first.`);
    }

    const uploadExt = extOf(uploadPath);
    if (!PROVIDER_ALLOWED_EXTS.has(uploadExt)) {
      throw new Error(`Prepared file type ${uploadExt || '(none)'} is not accepted by the provider.`);
    }

    const fileBuffer = fs.readFileSync(uploadPath);
    const fileName = path.basename(uploadPath);

    const form = new FormData();
    form.append('file', new Blob([fileBuffer]), fileName);
    form.append('model', MODEL);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}` },
      body: form
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Whisper HTTP ${res.status}: ${(data && data.error && data.error.message) || 'unknown'}`);
    }

    const words = Array.isArray(data.words)
      ? data.words
          .filter(w => w && typeof w.start === 'number' && typeof w.end === 'number')
          .map(w => ({ start: Number(w.start), end: Number(w.end), text: String(w.word || '').trim() }))
          .filter(w => w.text)
      : [];

    return {
      text: String(data.text || '').trim(),
      words,
      language: String(data.language || 'en')
    };
  } finally {
    cleanup();
  }
}

function buildKaraokeAss(words) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Line,Inter,34,&H88FFFFFF,&H88FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0.5,0,1,2,1,2,120,120,190,1
Style: Word,&H00FFFFFF

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = [];
  let current = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    current.push(w);
    const next = words[i + 1];
    const endsSentence = /[.!?]$/.test(w.text);
    const longPause = next ? (next.start - w.end) > 0.9 : false;
    if (current.length >= 5 || endsSentence || longPause) {
      lines.push(current);
      current = [];
    }
  }
  if (current.length) lines.push(current);

  const fmt = (t) => {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = (t % 60).toFixed(2).padStart(5, '0');
    return `${h}:${String(m).padStart(2, '0')}:${s}`;
  };

  const events = lines.map(line => {
    const start = line[0].start;
    const end = line[line.length - 1].end + 0.15;
    const tagged = line.map(w => {
      const cs = Math.max(1, Math.round((w.end - w.start) * 100));
      return `{\\kf${cs}\\1c&H000B86B8&}${assEsc(w.text)}`;
    }).join(' ');
    return `Dialogue: 0,${fmt(start)},${fmt(end)},Line,,0,0,0,,${tagged}`;
  }).join('\n');

  return header + events + '\n';
}

function assEsc(v) {
  return String(v).replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim();
}

module.exports = {
  isAvailable,
  transcribeWithWordTimestamps,
  buildKaraokeAss,
  normalizeForWhisper
};
