'use strict';

/**
 * src/services/whisperTranscribe.js
 *
 * Speech-to-text for audio testimonies with WORD-LEVEL timestamps.
 * Uses OpenAI Whisper (whisper-1) via the audio.transcriptions endpoint.
 *
 * Env:
 *   WHISPER_API_KEY   OpenAI API key (sk-...). If unset, transcription is
 *                     skipped gracefully and the video renders without
 *                     karaoke subtitles.
 *
 * Returns: { text, words: [{start, end, text}] , language }
 *   start/end are seconds (float). text is the trimmed word.
 *
 * No external HTTP library — uses global fetch (Node 18+).
 */

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.WHISPER_API_KEY || '';
const ENDPOINT = process.env.WHISPER_ENDPOINT || 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = process.env.WHISPER_MODEL || 'whisper-1';

function isAvailable() {
  return !!API_KEY;
}

/**
 * Transcribe an audio file with word-level timestamps.
 * @param {string} audioPath  absolute path on disk
 * @returns {Promise<{text:string, words:Array, language:string}>}
 */
async function transcribeWithWordTimestamps(audioPath) {
  if (!API_KEY) throw new Error('WHISPER_API_KEY is not set');
  if (!audioPath || !fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  // Whisper hard limit is 25 MB. Testimony audio should be well under; guard anyway.
  const stat = fs.statSync(audioPath);
  if (stat.size > 25 * 1024 * 1024) {
    throw new Error(`Audio file is ${Math.round(stat.size/1048576)}MB — Whisper cap is 25MB. Split or compress first.`);
  }

  const fileBuffer = fs.readFileSync(audioPath);
  const fileName = path.basename(audioPath);

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
}

/**
 * Build a karaoke-style ASS subtitle file from word timestamps.
 *
 * Layout: 3–4 words per line (or a pause > 0.9s forces a break), centered near
 * the lower third. Per-word highlighting uses the ASS \kf tag so the current
 * word pops gold (#b8860b) while past words are white and upcoming words are
 * dimmed — the lyric-video feel.
 *
 * ASS colors are BGR (&HAABBGGRR):
 *   gold #b8860b  -> &H000B86B8
 *   white         -> &H00FFFFFF
 *   dim white     -> &H88FFFFFF (semi-transparent)
 */
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

  // Group words into lines: break on sentence punctuation, long pause, or 5 words.
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
    const end = line[line.length - 1].end + 0.15; // tiny tail so last word doesn't flicker out
    // Karaoke tags: \kf<cs> = fill word over <cs> centiseconds
    const tagged = line.map(w => {
      const cs = Math.max(1, Math.round((w.end - w.start) * 100));
      return `{\\kf${cs}\\1c&H000B86B8&}${assEsc(w.text)}`;
    }).join(' ');
    return `Dialogue: 0,${fmt(start)},${fmt(end)},Line,,0,0,0,,${tagged}`;
  }).join('\n');

  return header + events + '\n';
}

function assEsc(v) {
  // ASS escapes: braces are control chars; commas are fine; newlines disallowed.
  return String(v).replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim();
}

module.exports = {
  isAvailable,
  transcribeWithWordTimestamps,
  buildKaraokeAss
};
