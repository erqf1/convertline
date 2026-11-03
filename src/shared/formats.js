'use strict';

// Was Convertline liest und schreibt. Benutzen Hauptprozess und Oberfläche gemeinsam.
const INPUT = {
  video: ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts', 'mts', '3gp', 'ogv', 'vob', 'asf', 'f4v'],
  audio: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'ac3', 'amr', 'ape', 'mka', 'wv', 'caf'],
  image: ['png', 'jpg', 'jpeg', 'jfif', 'webp', 'avif', 'bmp', 'gif', 'tif', 'tiff', 'ico', 'tga', 'heic', 'heif', 'svg', 'ppm', 'dds'],
  doc: ['txt', 'md', 'markdown', 'html', 'htm', 'docx', 'pdf'],
};
const KINDS = Object.keys(INPUT);
const KIND_OF = {};
for (const k of KINDS) for (const e of INPUT[k]) KIND_OF[e] = k;

const TARGETS = {
  video: ['mp4', 'webm', 'mkv', 'mov', 'avi', 'gif'],
  audio: ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus'],
  image: ['png', 'jpg', 'webp', 'avif', 'bmp', 'tiff', 'gif', 'ico', 'pdf'],
  doc: ['pdf', 'html', 'txt', 'md', 'png', 'jpg'],
};
const DOC_TARGETS = {
  txt: ['pdf', 'html', 'md'],
  md: ['pdf', 'html', 'txt'],
  markdown: ['pdf', 'html', 'txt'],
  html: ['pdf', 'txt', 'md'],
  htm: ['pdf', 'txt', 'md'],
  docx: ['pdf', 'html', 'txt', 'md'],
  pdf: ['png', 'jpg', 'txt'],
};
// Formate, die nur mit diesem FFmpeg-Encoder gehen (die Builds je System haben nicht alle gleich)
const NEEDS = { webm: ['libvpx-vp9'], mp3: ['libmp3lame'], ogg: ['libvorbis'], opus: ['libopus'], webp: ['libwebp'], avif: ['libaom-av1', 'libsvtav1'] };

const CODECS = { mp4: ['auto', 'h264', 'h265', 'av1'], mkv: ['auto', 'h264', 'h265', 'av1'], mov: ['auto', 'h264', 'h265'], webm: ['auto', 'vp9', 'av1'] };
const LOSSLESS_AUDIO = ['flac', 'wav'];
const LOSSY_IMAGE = ['jpg', 'webp', 'avif'];
const FLAT_IMAGE = ['jpg', 'bmp', 'pdf']; // ohne Transparenz: braucht eine Hintergrundfarbe

const DEFAULTS = {
  targets: { video: 'mp4', audio: 'mp3', image: 'png', doc: 'pdf' },
  video: { codec: 'auto', quality: 'original', sizeMB: 0, height: 0, fps: 0, audio: 'keep' },
  audio: { kbps: 256, normalize: false },
  image: { quality: 85, maxSize: 0, background: '#ffffff' },
  doc: { page: 'a4', dpi: 150 },
};

const extOf = (name) => (String(name).match(/\.([^.\\/]+)$/)?.[1] || '').toLowerCase();
const kindOf = (name) => KIND_OF[extOf(name)] || null;

/** Mögliche Ziele für eine Datei; ein animiertes GIF zählt als Video */
function targetsFor(kind, ext, hasAudio = true, encoders = null) {
  let list;
  if (kind === 'doc') list = DOC_TARGETS[ext] || [];
  else if (kind === 'video') list = [...TARGETS.video, ...(hasAudio ? TARGETS.audio : [])];
  else list = TARGETS[kind] || [];
  return encoders ? list.filter((t) => !NEEDS[t] || NEEDS[t].some((n) => encoders.includes(n))) : list;
}
const isAudioTarget = (t) => TARGETS.audio.includes(t);
const isVideoTarget = (t) => TARGETS.video.includes(t);

module.exports = { INPUT, KINDS, TARGETS, CODECS, LOSSLESS_AUDIO, LOSSY_IMAGE, FLAT_IMAGE, DEFAULTS, extOf, kindOf, targetsFor, isAudioTarget, isVideoTarget };
