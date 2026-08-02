'use strict';

/**
 * src/services/audioToVideo.js
 *
 * Renders an MP4 from an audio testimony:
 *   - 1280x720
 *   - Gradient background: #2a1140 -> #5a2a82 (JIMK palette)
 *   - Centered crown-of-thorns JIMK logo with subtle pulse (100% <-> 105% every 3s)
 *   - "SHARED TESTIMONY" caption in gold (#b8860b)
 *   - Submitter's display name in white
 *   - Optional location subtitle
 *   - Audio track = the uploaded audio file (converted to AAC 128k stereo)
 *
 * The final video length matches the input audio (no hard trim).
 *
 * Dependencies:
 *   - ffmpeg-static (bundled Node binary; ~40 MB build overhead)
 *   - sharp (already in the backend for artist images) — used to prep the still frame
 *
 * Bundled asset:
 *   - src/assets/jimk-crown.png  (crown-of-thorns logo, black on transparent)
 *
 * The still frame is generated on the fly with sharp so ffmpeg only handles
 * the encoding pass. This keeps the ffmpeg command simple and lets us hit
 * the pulse animation with a single zoompan filter.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const sharp = require('sharp');

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (err) {
  console.warn('[audioToVideo] ffmpeg-static not installed. Run `npm install ffmpeg-static`.');
}

const CROWN_ASSET = path.join(__dirname, '..', 'assets', 'jimk-crown.png');

const WIDTH  = 1280;
const HEIGHT = 720;
const CROWN_SIZE = 260;                 // px, centered vertically slightly above middle
const CROWN_CENTER_Y = 260;             // y of crown center
const CAPTION_Y = 435;                  // "SHARED TESTIMONY"
const NAME_Y = 495;                     // display name
const LOCATION_Y = 555;                 // location subtitle
const BG_STOP1 = '#2a1140';
const BG_STOP2 = '#5a2a82';
const GOLD = '#b8860b';

/**
 * Escape a string for use inside ffmpeg drawtext text='...'
 * ffmpeg quoting rules: escape backslash, single quote, colon, and %{}
 */
function escDrawtext(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\\\'")
    .replace(/:/g, '\\\\:')
    .replace(/%/g, '\\\\%');
}

/**
 * Build the still frame (background + logo + caption + name + location) as a
 * single PNG using sharp. Everything except the pulse animation is baked in
 * here. The pulse is applied later by ffmpeg's zoompan filter on the whole
 * frame — because the JIMK layout is centered, zooming the whole frame reads
 * as "the crown is breathing" which is the visual we want.
 */
async function renderStillFrame({ displayName, location }, outPath) {
  const nameSafe     = String(displayName || 'Anonymous').trim();
  const locSafe      = String(location || '').trim();
  const captionText  = 'SHARED TESTIMONY';

  // Background gradient built as an SVG (sharp accepts SVG input natively).
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%"   stop-color="${BG_STOP1}"/>
        <stop offset="100%" stop-color="${BG_STOP2}"/>
      </linearGradient>
      <radialGradient id="glow" cx="50%" cy="35%" r="40%">
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

  // Overlay the crown centered horizontally, y = CROWN_CENTER_Y (as CENTER).
  // The bundled logo is black. On a dark purple background we invert it to
  // white for legibility — sharp's negate() flips black -> white while
  // preserving the transparent background.
  let crown;
  try {
    if (!fs.existsSync(CROWN_ASSET)) {
      throw new Error(`Crown asset missing at ${CROWN_ASSET}`);
    }
    crown = await sharp(CROWN_ASSET)
      .resize(CROWN_SIZE, CROWN_SIZE, { fit: 'inside' })
      .negate({ alpha: false })         // black -> white
      .toBuffer();
  } catch (err) {
    console.warn('[audioToVideo] crown asset unavailable, rendering without it:', err.message);
    crown = null;
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

function xmlEsc(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Convert an audio file to an MP4 with the JIMK still frame + subtle pulse.
 *
 * Params:
 *   audioPath   absolute path to the source audio file (mp3, m4a, wav, webm, ogg, etc.)
 *   displayName submitter's name shown on the frame
 *   location    optional location line
 *   outPath     absolute path where the MP4 should be written
 *
 * Returns: { outPath, durationSec }
 */
async function audioToTestimonyVideo({ audioPath, displayName, location, outPath }) {
  if (!ffmpegPath) throw new Error('ffmpeg-static is not installed on the server.');
  if (!audioPath || !fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimk_audiovid_'));
  const framePath = path.join(tmpDir, 'frame.png');

  try {
    await renderStillFrame({ displayName, location }, framePath);

    // Pulse filter:
    //   scale = 1.0 + 0.025 * sin(2*PI * t / 3)   (approx 100% -> 105% -> 100% every 3s)
    // We implement this by zooming the whole frame around center with zoompan
    // being awkward on a single still, so instead we scale up the source frame
    // via the "scale" + "crop" trick using expressions.
    //
    // Actually the cleanest way: use ffmpeg's "zoompan" filter on a looped
    // still input. zoompan takes zoom expression 'z' and produces s frames
    // per second with the still zoomed by z(n).
    //
    // pulse zoom range: 1.00 -> 1.05
    // period: 3 seconds
    // fps: 30
    // zoom expression: '1+0.025*sin(2*PI*on/(3*30))'
    //     (on = current output frame number)

    // ffmpeg pipeline:
    //   -loop 1 -framerate 30 -i frame.png
    //   -i audio.ext
    //   -shortest
    //   -filter_complex "[0:v]zoompan=z='1+0.025*sin(2*PI*on/90)':d=1:s=1280x720,fps=30,format=yuv420p[v]"
    //   -map "[v]" -map 1:a
    //   -c:v libx264 -tune stillimage -preset medium -crf 20
    //   -c:a aac -b:a 128k -ac 2 -ar 44100
    //   -pix_fmt yuv420p
    //   -movflags +faststart
    //   out.mp4

    const filter = [
      '[0:v]',
      "zoompan=z='1+0.025*sin(2*PI*on/90)':d=1:s=1280x720:fps=30",
      ',fps=30,format=yuv420p[v]'
    ].join('');

    const args = [
      '-y',
      '-loop', '1',
      '-framerate', '30',
      '-i', framePath,
      '-i', audioPath,
      '-filter_complex', filter,
      '-map', '[v]',
      '-map', '1:a:0',
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-preset', 'medium',
      '-crf', '20',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      '-ar', '44100',
      '-pix_fmt', 'yuv420p',
      '-shortest',
      '-movflags', '+faststart',
      outPath
    ];

    await runFfmpeg(args);

    // Best-effort probe of the resulting duration.
    const durationSec = await probeDuration(outPath).catch(() => null);

    return { outPath, durationSec };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      // ffmpeg writes progress info to stderr; keep the tail for error reporting.
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
  // Use ffmpeg itself to probe: `ffmpeg -i file` writes the "Duration:" line to stderr.
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

/**
 * Convenience: build an output path in the OS temp dir for a given intake id.
 */
function tempOutputPathForIntake(intakeId) {
  const id  = String(intakeId || 'anon');
  const rand = crypto.randomBytes(4).toString('hex');
  return path.join(os.tmpdir(), `jimk_testimony_${id}_${rand}.mp4`);
}

module.exports = {
  audioToTestimonyVideo,
  tempOutputPathForIntake,
  renderStillFrame,   // exported for tests
  CROWN_ASSET
};
