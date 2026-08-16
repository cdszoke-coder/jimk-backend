'use strict';

/**
 * src/services/audioToVideo.js  (v2 — karaoke + music bed)
 *
 * Renders an MP4 from an audio testimony:
 *   - 1280x720
 *   - Gradient background: #2a1140 -> #5a2a82 (JIMK palette)
 *   - Centered crown-of-thorns JIMK logo with subtle pulse (100% <-> 105% every 3s)
 *   - "SHARED TESTIMONY" caption in gold (#b8860b)
 *   - Submitter's display name in white
 *   - Optional location subtitle
 *   - KARAOKE SUBTITLES: word-by-word highlight synced to the voice
 *     (ASS file built from Whisper word timestamps; burned in by ffmpeg)
 *   - MUSIC BED: bundled royalty-free piano loop (assets/jimk-piano-bed.mp3)
 *     mixed ~-18 dB under the voice, looped to match audio duration
 *
 * The final video length matches the input audio (no hard trim).
 *
 * Dependencies:
 *   - ffmpeg-static (bundled Node binary)
 *   - sharp (still-frame generation)
 *   - whisperTranscribe.js (optional; if WHISPER_API_KEY unset, video renders
 *     WITHOUT subtitles — never fails the whole job on missing captions)
 *
 * Bundled assets:
 *   - src/assets/jimk-crown.png
 *   - src/assets/jimk-piano-bed.mp3
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const sharp = require('sharp');

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); }
catch (err) { console.warn('[audioToVideo] ffmpeg-static not installed. Run `npm install ffmpeg-static`.'); }

const whisper = require('./whisperTranscribe');

const CROWN_ASSET = path.join(__dirname, '..', 'assets', 'jimk-crown.png');
const PIANO_BED   = path.join(__dirname, '..', 'assets', 'jimk-piano-bed.mp3');

const WIDTH  = 1280;
const HEIGHT = 720;
const CROWN_SIZE = 240;
const CROWN_CENTER_Y = 215;   // shifted up to leave room for subtitles lower third
const CAPTION_Y = 380;
const NAME_Y = 440;
const LOCATION_Y = 495;
const BG_STOP1 = '#2a1140';
const BG_STOP2 = '#5a2a82';
const GOLD = '#b8860b';
const END_BREATH_SEC = 1.6;
const END_CARD_SEC = 6.0;
const END_LINE_1 = 'Your testimony could help someone else find hope.';
const END_LINE_2 = 'Share your story.';

function xmlEsc(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Escape an absolute path for the ffmpeg subtitles filter.
 * ffmpeg filter args need backslash-escaped colons and single quotes, and the
 * whole expression is single-quoted in the filtergraph.
 */
function escFilterPath(p) {
  return String(p)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

/**
 * Build the still frame (background + logo + caption + name + location).
 */
async function renderStillFrame({ displayName, location }, outPath) {
  const nameSafe    = String(displayName || 'Anonymous').trim();
  const locSafe     = String(location || '').trim();
  const captionText = 'SHARED TESTIMONY';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%"   stop-color="${BG_STOP1}"/>
        <stop offset="100%" stop-color="${BG_STOP2}"/>
      </linearGradient>
      <radialGradient id="glow" cx="50%" cy="32%" r="42%">
        <stop offset="0%"   stop-color="${GOLD}" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="${GOLD}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    <rect width="100%" height="100%" fill="url(#glow)"/>
    <text x="50%" y="${CAPTION_Y}"
          font-family="Cinzel, Georgia, serif"
          font-size="26"
          fill="${GOLD}"
          text-anchor="middle"
          letter-spacing="6">${captionText}</text>
    <text x="50%" y="${NAME_Y}"
          font-family="Cinzel, Georgia, serif"
          font-size="52"
          font-weight="700"
          fill="#ffffff"
          text-anchor="middle">${xmlEsc(nameSafe)}</text>
    ${locSafe ? `<text x="50%" y="${LOCATION_Y}"
          font-family="Inter, Helvetica, sans-serif"
          font-size="22"
          fill="#e7ddf5"
          text-anchor="middle">${xmlEsc(locSafe)}</text>` : ''}
  </svg>`;

  const bg = await sharp(Buffer.from(svg)).png().toBuffer();

  let crown = null;
  try {
    if (!fs.existsSync(CROWN_ASSET)) throw new Error(`Crown asset missing at ${CROWN_ASSET}`);
    crown = await sharp(CROWN_ASSET)
      .resize(CROWN_SIZE, CROWN_SIZE, { fit: 'inside' })
      .negate({ alpha: false })
      .toBuffer();
  } catch (err) {
    console.warn('[audioToVideo] crown asset unavailable, rendering without it:', err.message);
  }

  const composites = [];
  if (crown) {
    composites.push({
      input: crown,
      top:  Math.max(0, CROWN_CENTER_Y - Math.floor(CROWN_SIZE / 2)),
      left: Math.floor((WIDTH - CROWN_SIZE) / 2)
    });
  }

  await sharp(bg).composite(composites).png().toFile(outPath);
  return outPath;
}


async function renderEndScreen(outPath) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%"   stop-color="${BG_STOP1}"/>
        <stop offset="100%" stop-color="${BG_STOP2}"/>
      </linearGradient>
      <radialGradient id="glow" cx="50%" cy="45%" r="58%">
        <stop offset="0%"   stop-color="${GOLD}" stop-opacity="0.14"/>
        <stop offset="100%" stop-color="${GOLD}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    <rect width="100%" height="100%" fill="url(#glow)"/>
    <text x="50%" y="242"
          font-family="Cinzel, Georgia, serif"
          font-size="26"
          fill="${GOLD}"
          text-anchor="middle"
          letter-spacing="6">SHARED TESTIMONY</text>
    <text x="50%" y="346"
          font-family="Inter, Helvetica, sans-serif"
          font-size="40"
          font-weight="600"
          fill="#ffffff"
          text-anchor="middle">${xmlEsc(END_LINE_1)}</text>
    <text x="50%" y="414"
          font-family="Cinzel, Georgia, serif"
          font-size="44"
          font-weight="700"
          fill="${GOLD}"
          text-anchor="middle">${xmlEsc(END_LINE_2)}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return outPath;
}

async function imageToSilentClip({ imagePath, durationSec, outPath }) {
  await runFfmpeg([
    '-y',
    '-loop', '1',
    '-framerate', '30',
    '-i', imagePath,
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-t', String(durationSec),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '21',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    '-ar', '44100',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath
  ]);
  return outPath;
}

async function extractLastFrame(videoPath, outPath) {
  await runFfmpeg([
    '-y',
    '-sseof', '-0.10',
    '-i', videoPath,
    '-frames:v', '1',
    '-update', '1',
    outPath
  ]);
  return outPath;
}

async function appendEndScreen({ mainVideoPath, outPath }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimk_endcard_'));
  const lastFramePath = path.join(tmpDir, 'last-frame.png');
  const holdClipPath = path.join(tmpDir, 'hold.mp4');
  const endPngPath = path.join(tmpDir, 'end-card.png');
  const endClipPath = path.join(tmpDir, 'end-card.mp4');
  try {
    await extractLastFrame(mainVideoPath, lastFramePath);
    await imageToSilentClip({ imagePath: lastFramePath, durationSec: END_BREATH_SEC, outPath: holdClipPath });
    await renderEndScreen(endPngPath);
    await imageToSilentClip({ imagePath: endPngPath, durationSec: END_CARD_SEC, outPath: endClipPath });
    await runFfmpeg([
      '-y',
      '-i', mainVideoPath,
      '-i', holdClipPath,
      '-i', endClipPath,
      '-filter_complex', '[0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[v][a]',
      '-map', '[v]',
      '-map', '[a]',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '21',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-ar', '44100',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outPath
    ]);
    return outPath;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Convert an audio testimony to an MP4 with karaoke subtitles + piano bed.
 *
 * Params:
 *   audioPath     absolute path to the source audio file
 *   displayName   submitter's name shown on the frame
 *   location      optional location line
 *   outPath       absolute path where the MP4 should be written
 *   withSubtitles   boolean (default true) — attempt Whisper + karaoke burn-in
 *   withMusicBed    boolean (default true) — mix piano bed under the voice
 *
 * Returns: { outPath, durationSec, hasSubtitles, hasMusicBed }
 */
async function audioToTestimonyVideo({ audioPath, displayName, location, outPath, withSubtitles = true, withMusicBed = true }) {
  if (!ffmpegPath) throw new Error('ffmpeg-static is not installed on the server.');
  if (!audioPath || !fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimk_audiovid_'));
  const framePath = path.join(tmpDir, 'frame.png');
  const assPath   = path.join(tmpDir, 'karaoke.ass');

  let hasSubtitles = false;
  let hasMusicBed  = false;

  try {
    await renderStillFrame({ displayName, location }, framePath);

    /* -------- 1. Transcription + karaoke ASS -------- */
    if (withSubtitles) {
      if (!whisper.isAvailable()) {
        console.warn('[audioToVideo] WHISPER_API_KEY unset — rendering without subtitles.');
      } else {
        try {
          const { words } = await whisper.transcribeWithWordTimestamps(audioPath);
          if (words && words.length) {
            fs.writeFileSync(assPath, whisper.buildKaraokeAss(words), 'utf8');
            hasSubtitles = true;
          } else {
            console.warn('[audioToVideo] Whisper returned no word timestamps; skipping subtitles.');
          }
        } catch (err) {
          // Never fail the render on transcription problems.
          console.warn('[audioToVideo] transcription failed (continuing without subtitles):', err.message);
        }
      }
    }

    /* -------- 2. Piano bed -------- */
    if (withMusicBed && fs.existsSync(PIANO_BED)) {
      hasMusicBed = true;
    } else if (withMusicBed) {
      console.warn('[audioToVideo] piano bed missing at ' + PIANO_BED + ' — rendering without music.');
    }

    /* -------- 3. ffmpeg pipeline -------- */
    //
    // Inputs:
    //   0: looped still frame (video)
    //   1: testimony audio (voice)
    //   2: piano bed (looped via -stream_loop -1, trimmed by -shortest)
    //
    // Video chain:
    //   [0:v] zoompan pulse -> fps 30 -> yuv420p -> [optional subtitles burn] -> [v]
    //
    // Audio chain (with music):
    //   [1:a] aresample 44100 -> [voice]
    //   [2:a] volume=0.10,afade in/out -> [music]
    //   [voice][music] amix normalize=0 -> loudnorm -> aac
    //
    // Audio chain (no music):
    //   [1:a] aresample -> loudnorm -> aac

    const videoChain = hasSubtitles
      ? `[0:v]zoompan=z='1+0.025*sin(2*PI*on/90)':d=1:s=1280x720:fps=30,fps=30,format=yuv420p,subtitles='${escFilterPath(assPath)}'[v]`
      : `[0:v]zoompan=z='1+0.025*sin(2*PI*on/90)':d=1:s=1280x720:fps=30,fps=30,format=yuv420p[v]`;

    const audioChain = hasMusicBed
      ? `[1:a]aresample=44100[voice];` +
        `[2:a]aresample=44100,volume=0.10,afade=t=in:st=0:d=1.2[music];` +
        `[voice][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`
      : `[1:a]aresample=44100,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;

    const filterComplex = videoChain + ';' + audioChain;

    const mainClipPath = path.join(tmpDir, 'main.mp4');
    const args = [
      '-y',
      '-loop', '1', '-framerate', '30', '-i', framePath,
      '-i', audioPath,
    ];
    if (hasMusicBed) {
      args.push('-stream_loop', '-1', '-i', PIANO_BED);
    }
    args.push(
      '-filter_complex', filterComplex,
      '-map', '[v]',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-preset', 'medium',
      '-crf', '20',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-ar', '44100',
      '-pix_fmt', 'yuv420p',
      '-shortest',
      '-movflags', '+faststart',
      mainClipPath
    );

    await runFfmpeg(args);
    await appendEndScreen({ mainVideoPath: mainClipPath, outPath });

    const durationSec = await probeDuration(outPath).catch(() => null);
    return { outPath, durationSec, hasSubtitles, hasMusicBed };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      const tail = stderr.split('\n').slice(-8).join('\n');
      reject(new Error(`ffmpeg exited ${code}\n${tail}`));
    });
  });
}

function probeDuration(mp4Path) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-i', mp4Path, '-hide_banner'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (!m) return reject(new Error('Could not parse duration'));
      const [, h, mnt, s] = m;
      resolve(Number(h) * 3600 + Number(mnt) * 60 + parseFloat(s));
    });
    proc.on('error', reject);
  });
}

function tempOutputPathForIntake(intakeId) {
  const id = String(intakeId || 'anon');
  const rand = crypto.randomBytes(4).toString('hex');
  return path.join(os.tmpdir(), `jimk_testimony_${id}_${rand}.mp4`);
}

module.exports = {
  audioToTestimonyVideo,
  tempOutputPathForIntake,
  renderStillFrame,   // exported for tests
  CROWN_ASSET,
  PIANO_BED
};

/**
 * Re-render an uploaded VIDEO testimony with the same treatment as audio:
 *   - karaoke subtitles burned in (Whisper word timestamps)
 *   - piano bed mixed ~-19 dB under the voice
 *   - normalized to 1280x720 (letterboxed with JIMK purple #2a1140)
 * Source video length is preserved (no trim).
 */
async function videoToTestimonyVideo({ videoPath, outPath, withSubtitles = true, withMusicBed = true }) {
  if (!ffmpegPath) throw new Error('ffmpeg-static is not installed on the server.');
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimk_vidvid_'));
  const assPath = path.join(tmpDir, 'karaoke.ass');

  let hasSubtitles = false;
  let hasMusicBed  = false;

  try {
    /* -------- 1. Transcription + karaoke ASS (Whisper accepts mp4 directly) -------- */
    if (withSubtitles) {
      if (!whisper.isAvailable()) {
        console.warn('[audioToVideo] WHISPER_API_KEY unset — rendering video without subtitles.');
      } else {
        try {
          const { words } = await whisper.transcribeWithWordTimestamps(videoPath);
          if (words && words.length) {
            fs.writeFileSync(assPath, whisper.buildKaraokeAss(words), 'utf8');
            hasSubtitles = true;
          } else {
            console.warn('[audioToVideo] Whisper returned no word timestamps; skipping subtitles.');
          }
        } catch (err) {
          console.warn('[audioToVideo] transcription failed (continuing without subtitles):', err.message);
        }
      }
    }

    /* -------- 2. Piano bed -------- */
    if (withMusicBed && fs.existsSync(PIANO_BED)) {
      hasMusicBed = true;
    } else if (withMusicBed) {
      console.warn('[audioToVideo] piano bed missing at ' + PIANO_BED + ' — rendering without music.');
    }

    /* -------- 3. ffmpeg pipeline --------
     * Inputs: 0 = uploaded video (voice on its audio track), 1 = piano bed loop.
     * Video: scale to fit 1280x720, pad with brand purple, 30fps, optional subtitle burn.
     * Audio: voice aresample + music at 0.08, amix duration=first, loudnorm.
     */
    let videoChain = `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x2a1140,fps=30,format=yuv420p`;
    if (hasSubtitles) videoChain += `,subtitles='${escFilterPath(assPath)}'`;
    videoChain += '[v]';

    const audioChain = hasMusicBed
      ? `[0:a]aresample=44100[voice];` +
        `[1:a]aresample=44100,volume=0.08,afade=t=in:st=0:d=1.2[music];` +
        `[voice][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`
      : `[0:a]aresample=44100,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;

    const mainClipPath = path.join(tmpDir, 'main.mp4');
    const args = ['-y', '-i', videoPath];
    if (hasMusicBed) args.push('-stream_loop', '-1', '-i', PIANO_BED);
    args.push(
      '-filter_complex', videoChain + ';' + audioChain,
      '-map', '[v]',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '21',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-ar', '44100',
      '-pix_fmt', 'yuv420p',
      '-shortest',
      '-movflags', '+faststart',
      mainClipPath
    );

    await runFfmpeg(args);
    await appendEndScreen({ mainVideoPath: mainClipPath, outPath });

    const durationSec = await probeDuration(outPath).catch(() => null);
    return { outPath, durationSec, hasSubtitles, hasMusicBed };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports.videoToTestimonyVideo = videoToTestimonyVideo;
