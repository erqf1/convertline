'use strict';

// Baut aus Datei, Ziel und Einstellungen die FFmpeg-Aufrufe. Hier wird nichts gestartet.
// Ergebnis: { steps: [{ args, weight }], hw, sizeLimit }; args enden mit dem Platzhalter OUT für die Zieldatei.
const { LOSSLESS_AUDIO } = require('./shared/formats');

const OUT = '\0OUT';
const TEXT_SUBS = /^(subrip|srt|ass|ssa|mov_text|webvtt|text)$/;
const CONTAINERS = {
  mp4: { v: /^(h264|hevc|av1|mpeg4)$/, a: /^(aac|mp3|ac3|eac3)$/, subs: 'mov_text', codec: 'h264', audio: 'aac' },
  mov: { v: /^(h264|hevc|mpeg4|prores|mjpeg)$/, a: /^(aac|mp3|alac|pcm_s16le|pcm_s24le)$/, subs: 'mov_text', codec: 'h264', audio: 'aac' },
  mkv: { v: /./, a: /./, subs: 'copy', codec: 'h264', audio: 'aac' },
  webm: { v: /^(vp8|vp9|av1)$/, a: /^(opus|vorbis)$/, subs: 'webvtt', codec: 'vp9', audio: 'opus' },
  avi: { v: /^(mpeg4|mjpeg|msmpeg4v3)$/, a: /^(mp3|ac3|pcm_s16le)$/, subs: null, codec: 'mpeg4', audio: 'mp3' },
};
const FAMILY = { h264: 'h264', h265: 'hevc', av1: 'av1', vp9: 'vp9' };
const CRF = {
  h264: { original: 18, high: 20, balanced: 23, small: 28 },
  h265: { original: 20, high: 23, balanced: 26, small: 30 },
  av1: { original: 24, high: 28, balanced: 33, small: 40 },
  vp9: { original: 24, high: 28, balanced: 33, small: 38 },
  mpeg4: { original: 3, high: 4, balanced: 6, small: 9 },
};
const AUDIO_KBPS = { original: 256, high: 192, balanced: 160, small: 112 };
const AUDIO_ENCODER = { aac: 'aac', opus: 'libopus', mp3: 'libmp3lame' };
const OPUS_LAYOUT = 'aformat=channel_layouts=7.1|5.1|stereo|mono';

const head = () => ['-y', '-hide_banner', '-nostdin', '-v', 'error', '-progress', 'pipe:1', '-nostats'];
const fail = (code, detail) => Object.assign(new Error(code), { code, detail });

function softwareVideo(codec, quality, pix, env) {
  const q = CRF[codec][quality];
  if (codec === 'h264') return ['-c:v', 'libx264', '-preset', 'medium', '-crf', q, '-pix_fmt', 'yuv420p'];
  if (codec === 'h265') return ['-c:v', 'libx265', '-preset', 'medium', '-crf', q, '-pix_fmt', pix, '-x265-params', 'log-level=error'];
  if (codec === 'vp9') return ['-c:v', 'libvpx-vp9', '-crf', q, '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '3', '-pix_fmt', pix];
  if (codec === 'av1') {
    if (env.encoders.includes('libsvtav1')) return ['-c:v', 'libsvtav1', '-preset', '8', '-crf', q, '-pix_fmt', pix];
    return ['-c:v', 'libaom-av1', '-cpu-used', '6', '-row-mt', '1', '-crf', q, '-b:v', '0', '-pix_fmt', pix];
  }
  return ['-c:v', 'mpeg4', '-q:v', q, '-pix_fmt', 'yuv420p'];
}

function hardwareVideo(name, codec, quality) {
  const q = CRF[codec][quality];
  if (/nvenc/.test(name)) return ['-c:v', name, '-preset', 'p5', '-rc', 'vbr', '-cq', q, '-b:v', '0', '-pix_fmt', 'yuv420p'];
  if (/amf/.test(name)) return ['-c:v', name, '-usage', 'transcoding', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', q, '-qp_p', q, ...(codec === 'h264' ? ['-qp_b', q] : []), '-pix_fmt', 'yuv420p'];
  if (/qsv/.test(name)) return ['-c:v', name, '-global_quality', q, '-pix_fmt', 'nv12'];
  return ['-c:v', name, '-q:v', Math.max(30, 100 - q * 2), '-pix_fmt', 'yuv420p'];
}

/** Wählt den Codec: fest eingestellt oder das, was zum Container passt */
function chooseCodec(target, o, v) {
  const c = CONTAINERS[target];
  if (o.codec && o.codec !== 'auto') return o.codec;
  if (target === 'webm' && v.codec === 'av1') return 'av1';
  if (target !== 'webm' && target !== 'avi' && v.codec === 'hevc' && c.v.test('hevc')) return 'h265';
  return c.codec;
}

function audioArgs(c, tracks, copy, kbps) {
  const args = [];
  const af = [];
  tracks.forEach((a, i) => {
    if (copy && c.a.test(a.codec)) args.push(`-c:a:${i}`, 'copy');
    else {
      args.push(`-c:a:${i}`, AUDIO_ENCODER[c.audio], `-b:a:${i}`, `${kbps}k`);
      if (c.audio === 'opus') af.push(`[0:${a.index}]`);
    }
  });
  return { args, opus: af.length > 0 };
}

function planGif(src, o) {
  const p = src.probe;
  const v = p.video;
  const fps = Math.min(o.fps || 12, 30, v.fps || 30);
  const height = Math.min(o.height || 480, v.h);
  const graph = `[0:${v.index}]fps=${fps},scale=-2:${height}:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4[out]`;
  return { steps: [{ args: [...head(), '-i', src.file, '-filter_complex', graph, '-map', '[out]', '-loop', '0', '-f', 'gif', OUT], weight: 1 }], hw: false };
}

function planVideo(src, target, o, env, tune = {}) {
  const p = src.probe;
  const v = p.video;
  if (!v) throw fail('NO_VIDEO');
  if (target === 'gif') return planGif(src, o);
  const c = CONTAINERS[target];
  const codec = target === 'avi' ? 'mpeg4' : chooseCodec(target, o, v);
  const sizeMB = Number(o.sizeMB) || 0;
  const quality = sizeMB ? 'high' : o.quality || 'original';
  const scale = o.height && v.h > o.height;
  const slower = o.fps && v.fps > o.fps;
  const sameCodec = (!o.codec || o.codec === 'auto') ? c.v.test(v.codec) : FAMILY[o.codec] === v.codec;
  const copyVideo = quality === 'original' && !sizeMB && !scale && !slower && sameCodec && c.v.test(v.codec);
  const keepAudio = o.audio !== 'none' && target !== 'gif';
  const tracks = keepAudio ? (sizeMB ? p.audio.slice(0, 1) : p.audio) : [];
  const subs = c.subs ? p.subs.filter((s) => c.subs === 'copy' || TEXT_SUBS.test(s.codec)) : [];

  const map = ['-map', `0:${v.index}`, ...tracks.flatMap((a) => ['-map', `0:${a.index}`]), ...subs.flatMap((s) => ['-map', `0:${s.index}`])];
  const filters = [];
  if (scale) filters.push(`scale=-2:${o.height}:flags=lanczos`);
  if (slower) filters.push(`fps=${o.fps}`);
  const vf = filters.length ? ['-vf', filters.join(',')] : [];

  let kbps = AUDIO_KBPS[quality];
  let videoKbps = 0;
  if (sizeMB) {
    if (!p.duration) throw fail('NO_DURATION');
    const total = (sizeMB * 8000 * (tune.factor || 0.96)) / p.duration;
    kbps = tracks.length ? Math.round(Math.min(128, Math.max(48, total * 0.12))) : 0;
    videoKbps = Math.round(total - kbps);
    if (videoKbps < 40) throw fail('TARGET_TOO_SMALL');
  }
  const audio = audioArgs(c, tracks, quality === 'original' && !sizeMB, kbps);
  const opusFix = audio.opus ? ['-af', OPUS_LAYOUT] : [];
  const subArgs = subs.length ? ['-c:s', c.subs] : [];
  const pix = v.bits10 ? 'yuv420p10le' : 'yuv420p';
  const tail = [...(target === 'mp4' || target === 'mov' ? ['-movflags', '+faststart'] : []), OUT];
  const tag = codec === 'h265' && target !== 'mkv' ? ['-tag:v', 'hvc1'] : [];

  if (copyVideo) {
    const hvc = v.codec === 'hevc' && target !== 'mkv' ? ['-tag:v', 'hvc1'] : [];
    return { steps: [{ args: [...head(), '-i', src.file, ...map, '-c:v', 'copy', ...hvc, ...audio.args, ...opusFix, ...subArgs, ...tail], weight: 1 }], hw: false, copied: true };
  }

  if (sizeMB) {
    const enc = softwareVideo(codec, 'high', pix, env).filter((x, i, a) => !['-crf', '-b:v'].includes(x) && !['-crf', '-b:v'].includes(a[i - 1]));
    const x265 = (n) => (codec === 'h265' ? ['-x265-params', `log-level=error:pass=${n}:stats=convertline-pass.log`] : ['-pass', n, '-passlogfile', 'convertline-pass']);
    const encBase = codec === 'h265' ? enc.slice(0, enc.indexOf('-x265-params')) : enc;
    const rate = ['-b:v', `${videoKbps}k`];
    if (codec === 'av1' && env.encoders.includes('libsvtav1')) {
      return { steps: [{ args: [...head(), '-i', src.file, ...map, ...vf, ...encBase, ...rate, ...audio.args, ...opusFix, ...subArgs, ...tail], weight: 1 }], hw: false, sizeLimit: sizeMB * 1e6 };
    }
    return {
      steps: [
        { args: [...head(), '-i', src.file, '-map', `0:${v.index}`, ...vf, ...encBase, ...rate, ...x265(1), '-an', '-sn', '-f', 'null', '-'], weight: 0.4 },
        { args: [...head(), '-i', src.file, ...map, ...vf, ...encBase, ...rate, ...x265(2), ...tag, ...audio.args, ...opusFix, ...subArgs, ...tail], weight: 0.6 },
      ],
      hw: false,
      twoPass: true,
      sizeLimit: sizeMB * 1e6,
    };
  }

  const hwName = !tune.noHw && env.useHw ? env.hw?.[codec] : null;
  const enc = hwName ? hardwareVideo(hwName, codec, quality) : softwareVideo(codec, quality, pix, env);
  return { steps: [{ args: [...head(), '-i', src.file, ...map, ...vf, ...enc, ...tag, ...audio.args, ...opusFix, ...subArgs, ...tail], weight: 1 }], hw: !!hwName };
}

function planAudio(src, target, o) {
  const p = src.probe;
  const a = p.audio[0];
  if (!a) throw fail('NO_AUDIO');
  const kbps = Number(o.kbps) || 256;
  const cover = src.kind === 'audio' && p.cover && /^(mjpeg|png)$/.test(p.cover.codec) && ['mp3', 'm4a', 'flac'].includes(target) ? p.cover : null;
  const map = ['-map', `0:${a.index}`, ...(cover ? ['-map', `0:${cover.index}`, '-c:v', 'copy', '-disposition:v', 'attached_pic'] : ['-vn'])];
  const filters = [];
  if (o.normalize) filters.push('loudnorm=I=-14:TP=-1.5:LRA=11');
  if (target === 'opus') filters.push(OPUS_LAYOUT);
  const af = filters.length ? ['-af', filters.join(',')] : [];
  const rate = o.normalize && !LOSSLESS_AUDIO.includes(target) && target !== 'opus' ? ['-ar', '44100'] : o.normalize ? ['-ar', '48000'] : [];
  const enc = {
    mp3: ['-c:a', 'libmp3lame', '-b:a', `${Math.min(320, kbps)}k`, '-id3v2_version', '3'],
    m4a: ['-c:a', 'aac', '-b:a', `${kbps}k`],
    flac: ['-c:a', 'flac', '-compression_level', '8'],
    wav: ['-c:a', a.bits24 ? 'pcm_s24le' : 'pcm_s16le'],
    ogg: ['-c:a', 'libvorbis', '-b:a', `${Math.min(320, kbps)}k`],
    opus: ['-c:a', 'libopus', '-b:a', `${kbps}k`],
  }[target];
  return { steps: [{ args: [...head(), '-i', src.file, ...map, ...af, ...rate, ...enc, OUT], weight: 1 }], hw: false };
}

const ORIENT = { 2: ['hflip'], 3: ['hflip', 'vflip'], 4: ['vflip'], 5: ['transpose=0'], 6: ['transpose=1'], 7: ['transpose=3'], 8: ['transpose=2'] };
const IMAGE2 = /\.(png|jpe?g|jfif|bmp|tiff?|webp|tga|ppm|dds)$/i;
const color = (hex) => `0x${String(hex || '#ffffff').replace('#', '').slice(0, 6)}`;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function planImage(src, target, o, env) {
  const p = src.probe;
  const v = p.video;
  if (!v) throw fail('NO_IMAGE');
  const orient = src.orientation || 1;
  let w = orient >= 5 ? v.h : v.w;
  let h = orient >= 5 ? v.w : v.h;
  const base = [...(ORIENT[orient] || [])];
  const max = Number(o.maxSize) || 0;
  if (max && Math.max(w, h) > max) {
    const f = max / Math.max(w, h);
    w = Math.max(1, Math.round(w * f));
    h = Math.max(1, Math.round(h * f));
    base.push(`scale=${w}:${h}:flags=lanczos`);
  }
  // Prozentzeichen im Namen wären sonst ein Muster für Bildserien
  const input = /%/.test(src.file) && IMAGE2.test(src.file) ? ['-f', 'image2', '-pattern_type', 'none'] : [];
  // Die Drehung drehen wir selbst, je nach FFmpeg-Version würde sie sonst doppelt angewandt
  const turn = orient > 1 ? ['-noautorotate'] : [];
  const start = [...head(), ...turn, ...input, '-i', src.file];
  const chain = base.length ? `${base.join(',')},` : '';
  const q = Math.min(100, Math.max(1, Number(o.quality) || 85));
  const one = ['-frames:v', '1', '-update', '1'];
  const single = (extra) => ({ steps: [{ args: [...start, ...extra, OUT], weight: 1 }], hw: false, size: [w, h] });
  const simple = base.length ? ['-vf', base.join(',')] : [];
  // Transparenz auf die Hintergrundfarbe legen
  const flatten = (fmt) => ['-filter_complex', `[0:v]${chain}format=rgba[fg];color=c=${color(o.background)}:s=${w}x${h}[bg];[bg][fg]overlay=shortest=1,format=${fmt}[out]`, '-map', '[out]'];

  switch (target) {
    case 'png':
      return single([...simple, '-c:v', 'png', ...one, '-f', 'image2']);
    case 'jpg':
    case 'pdf': {
      const qv = String(Math.round(2 + (100 - (target === 'pdf' ? Math.max(q, 92) : q)) * 0.29));
      const fmt = 'yuvj420p';
      const vf = v.alpha ? flatten(fmt) : [...(base.length ? ['-vf', `${base.join(',')},format=${fmt}`] : ['-vf', `format=${fmt}`])];
      return single([...vf, '-c:v', 'mjpeg', '-q:v', qv, ...one, '-f', 'image2']);
    }
    case 'webp':
      return single([...simple, '-c:v', 'libwebp', ...(q >= 100 ? ['-lossless', '1'] : ['-q:v', String(q)]), '-compression_level', '6', ...one, '-f', 'webp']);
    case 'avif': {
      const crf = String(Math.round((100 - q) * 0.6 + 15));
      const enc = env.encoders.includes('libaom-av1') ? ['-c:v', 'libaom-av1', '-cpu-used', '6', '-row-mt', '1', '-still-picture', '1', '-crf', crf, '-b:v', '0'] : ['-c:v', 'libsvtav1', '-preset', '8', '-crf', crf];
      if (v.alpha && env.encoders.includes('libaom-av1')) {
        return single(['-filter_complex', `[0:v]${chain}format=yuva420p,split[c][a];[a]alphaextract[m]`, '-map', '[c]', '-map', '[m]', ...enc, '-frames:v', '1', '-f', 'avif']);
      }
      return single([...(base.length ? ['-vf', `${base.join(',')},format=yuv420p`] : ['-vf', 'format=yuv420p']), ...enc, '-frames:v', '1', '-f', 'avif']);
    }
    case 'bmp':
      return single([...(v.alpha ? flatten('bgr24') : simple), '-c:v', 'bmp', ...(v.alpha ? [] : ['-pix_fmt', 'bgr24']), ...one, '-f', 'image2']);
    case 'tiff':
      return single([...simple, '-c:v', 'tiff', '-compression_algo', 'lzw', ...one, '-f', 'image2']);
    case 'gif':
      return single(['-filter_complex', `[0:v]${chain}split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse`, '-frames:v', '1', '-f', 'gif']);
    case 'ico': {
      const sizes = ICO_SIZES.filter((s) => s <= Math.max(w, h));
      if (!sizes.length) sizes.push(16);
      const parts = sizes.map((s, i) => `[i${i}]scale=${s}:${s}:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=${s}:${s}:(ow-iw)/2:(oh-ih)/2:color=0x00000000[o${i}]`);
      const graph = `[0:v]${chain}format=rgba,split=${sizes.length}${sizes.map((_, i) => `[i${i}]`).join('')};${parts.join(';')}`;
      return single(['-filter_complex', graph, ...sizes.flatMap((_, i) => ['-map', `[o${i}]`]), '-c:v', 'png', '-frames:v', '1', '-f', 'ico']);
    }
    default:
      throw fail('BAD_TARGET', target);
  }
}

module.exports = { OUT, planVideo, planAudio, planImage };
