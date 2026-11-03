'use strict';

// FFmpeg finden und starten, Dateien untersuchen, Vorschaubilder, verfügbare Encoder.
// Es gibt kein ffprobe im Paket: die Angaben kommen aus der Ausgabe von "ffmpeg -i".
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let binary = null;
function ffmpegPath() {
  if (binary) return binary;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const os = { win32: 'win', darwin: 'mac' }[process.platform] || 'linux';
  const dirs = [path.join(process.resourcesPath || '', 'ffmpeg'), path.join(__dirname, '..', 'vendor', `${os}-${process.arch}`)];
  binary = process.env.CONVERTLINE_FFMPEG || dirs.map((d) => path.join(d, exe)).find((p) => fs.existsSync(p)) || 'ffmpeg';
  return binary;
}

/** Startet FFmpeg ohne Konsolenfenster. Liefert { child, done }; done wird nie abgelehnt */
function run(args, { cwd, onLine, binaryOut = false } = {}) {
  const child = spawn(ffmpegPath(), args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  let err = '';
  let rest = '';
  child.stdout.on('data', (d) => {
    if (binaryOut) return out.push(d);
    if (!onLine) return;
    rest += d.toString('utf8');
    const lines = rest.split(/\r?\n/);
    rest = lines.pop();
    lines.forEach(onLine);
  });
  child.stderr.on('data', (d) => {
    err = (err + d.toString('utf8')).slice(-16000);
  });
  const done = new Promise((resolve) => {
    child.on('error', (e) => resolve({ code: -1, err: String(e.message), out: Buffer.alloc(0) }));
    child.on('close', (code, signal) => resolve({ code: code ?? -1, signal, err, out: Buffer.concat(out) }));
  });
  return { child, done };
}

const seconds = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);
const ALPHA = /^(yuva|rgba|bgra|argb|abgr|ya\d|gbrap|pal8|rgb32|bgr32)/;
const PIX = /\b(yuv[a-z0-9]*|rgb[a-z0-9]*|bgr[a-z0-9]*|gbr[a-z0-9]*|pal8|gray[a-z0-9]*|ya\d+[a-z]*|argb|abgr|nv12|p010le)\b/;

/** Liest die Ausgabe von "ffmpeg -i" */
function parseProbe(text) {
  const p = { duration: 0, bitrate: 0, format: '', video: null, cover: null, audio: [], subs: [] };
  p.format = /Input #0, ([^,\s]+)/.exec(text)?.[1] || '';
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (d) p.duration = seconds(d[1], d[2], d[3]);
  const b = /bitrate: (\d+) kb\/s/.exec(text);
  if (b) p.bitrate = Number(b[1]);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /Stream #0:(\d+)(?:\[0x[0-9a-f]+\])?(?:\((\w+)\))?: (Video|Audio|Subtitle): (.*)$/.exec(lines[i]);
    if (!m) continue;
    const index = Number(m[1]);
    const lang = m[2] || '';
    const rest = m[4];
    const codec = /^([\w.-]+)/.exec(rest)?.[1] || '';
    if (m[3] === 'Video') {
      const size = /(?:^|[ ,])(\d{2,5})x(\d{2,5})(?:[ ,]|$)/.exec(rest);
      const pix = PIX.exec(rest.replace(/^[^,]*,/, ''))?.[1] || '';
      const fps = /([\d.]+) fps/.exec(rest) || /([\d.]+) tbr/.exec(rest);
      const v = { index, codec, w: size ? Number(size[1]) : 0, h: size ? Number(size[2]) : 0, pix, alpha: ALPHA.test(pix), fps: fps ? Number(fps[1]) : 0, bits10: /(10|12)(le|be)/.test(pix) };
      // Handyvideos: die Drehung steht in den Nebendaten darunter
      for (let k = i + 1; k < Math.min(i + 8, lines.length) && !/Stream #0:/.test(lines[k]); k++) {
        const r = /rotation of (-?[\d.]+) degrees/.exec(lines[k]);
        if (r && Math.abs(Math.round(Number(r[1]) / 90)) % 2 === 1) [v.w, v.h] = [v.h, v.w];
      }
      if (/attached pic/.test(rest)) p.cover ||= v;
      else p.video ||= v;
    } else if (m[3] === 'Audio') {
      const rate = /(\d+) Hz/.exec(rest);
      const parts = rest.split(',').map((s) => s.trim());
      p.audio.push({ index, lang, codec, rate: rate ? Number(rate[1]) : 0, channels: parts[2] || '', bits24: /s24|s32|24 bit/.test(rest) });
    } else p.subs.push({ index, lang, codec });
  }
  return p;
}

async function probe(file) {
  const { err } = await run(['-hide_banner', '-nostdin', '-i', file]).done;
  if (!/Input #0/.test(err)) return null;
  return parseProbe(err);
}

/** Vorschaubild als PNG-data-URL (oder null) */
async function thumbnail(file, p, size = 96) {
  if (!p?.video && !p?.cover) return null;
  const at = p.video && p.duration > 1 ? ['-ss', String(Math.min(1, p.duration / 3))] : [];
  const stream = p.video || p.cover;
  const vf = `scale=${size}:${size}:force_original_aspect_ratio=increase:flags=bilinear,crop=${size}:${size}`;
  const { code, out } = await run(['-hide_banner', '-nostdin', '-v', 'error', ...at, '-i', file, '-map', `0:${stream.index}`, '-frames:v', '1', '-vf', vf, '-f', 'image2pipe', '-c:v', 'png', '-'], { binaryOut: true }).done;
  return code === 0 && out.length ? `data:image/png;base64,${out.toString('base64')}` : null;
}

let encoderList = null;
async function encoders() {
  if (encoderList) return encoderList;
  const { out } = await run(['-hide_banner', '-encoders'], { binaryOut: true }).done;
  encoderList = [...out.toString('utf8').matchAll(/^ [VAS][F.][S.][X.][B.][D.] (\S+)/gm)].map((m) => m[1]);
  return encoderList;
}

// Grafikkarten-Encoder je Codec, wichtigster zuerst. Ob einer wirklich läuft, zeigt nur ein kurzer Versuch
const HW = {
  h264: ['h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_videotoolbox'],
  h265: ['hevc_nvenc', 'hevc_amf', 'hevc_qsv', 'hevc_videotoolbox'],
};
let hwFound = null;
function hardware() {
  hwFound ||= (async () => {
    const have = await encoders();
    const found = {};
    for (const [codec, list] of Object.entries(HW)) {
      for (const name of list) {
        if (!have.includes(name)) continue;
        const { code } = await run(['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=640x360:r=30:d=0.3', '-pix_fmt', 'yuv420p', '-c:v', name, '-f', 'null', '-']).done;
        if (code === 0) {
          found[codec] = name;
          break;
        }
      }
    }
    return found;
  })();
  return hwFound;
}

/** Drehung aus den EXIF-Daten eines JPEG (FFmpeg beachtet sie bei Bildern nicht) */
function jpegOrientation(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(131072);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
    let i = 2;
    while (i + 4 < n && b[i] === 0xff) {
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker === 0xe1 && b.toString('latin1', i + 4, i + 8) === 'Exif') {
        const tiff = i + 10;
        const le = b.toString('latin1', tiff, tiff + 2) === 'II';
        const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
        const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
        const ifd = tiff + u32(tiff + 4);
        const count = u16(ifd);
        for (let k = 0; k < count; k++) {
          const e = ifd + 2 + k * 12;
          if (u16(e) === 0x0112) return u16(e + 8) || 1;
        }
        return 1;
      }
      if (marker === 0xda) break;
      i += 2 + len;
    }
  } catch {
    // nicht lesbar oder kaputte EXIF-Daten: wie abgelegt
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return 1;
}

module.exports = { ffmpegPath, run, parseProbe, probe, thumbnail, encoders, hardware, jpegOrientation };
