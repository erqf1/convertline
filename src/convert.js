'use strict';

// Ein Auftrag = eine Datei. Das Ergebnis entsteht als Hilfsdatei neben dem Ziel und wird erst am Ende umbenannt,
// ein Abbruch hinterlässt also nie eine halbe Datei. Die Originaldatei wird nie verändert.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ff = require('./ffmpeg');
const { OUT, planVideo, planAudio, planImage } = require('./ffargs');
const docs = require('./docs');
const { extOf, isAudioTarget } = require('./shared/formats');

const active = new Map(); // id -> { child, cancelled }
const reserved = new Set(); // Zielnamen laufender Aufträge: a.mkv und a.avi dürfen nicht beide a.mp4 werden

const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const taken = (p) => reserved.has(key(p)) || fs.existsSync(p);

/** Zielname nach der Regel aus den Einstellungen; das Original wird in keinem Fall überschrieben */
function targetPath(dir, base, ext, rule, source) {
  const first = path.join(dir, `${base}.${ext}`);
  const isSource = key(first) === key(source);
  if (!taken(first)) return first;
  if (rule === 'skip') return null;
  if (rule === 'overwrite' && !isSource && !reserved.has(key(first))) return first;
  for (let i = 1; ; i++) {
    const p = path.join(dir, `${base} (${i}).${ext}`);
    if (!taken(p)) return p;
  }
}

function cleanup(files) {
  for (const f of files) fs.rmSync(f, { force: true, recursive: true });
}

function runStep(job, step, tmp, cwd, from, share, emit) {
  return new Promise((resolve) => {
    const args = step.args.map((a) => (a === OUT ? tmp : a));
    const duration = job.probe?.duration || 0;
    let speed = 0;
    let lastSent = 0;
    const { child, done } = ff.run(args, {
      cwd,
      onLine(line) {
        const [k, v] = line.split('=');
        if (k === 'speed') speed = parseFloat(v) || 0;
        if (k !== 'out_time_us' && k !== 'out_time_ms') return;
        const now = Date.now();
        const time = Number(v) / 1e6; // am Anfang steht hier N/A
        if (!duration || !Number.isFinite(time) || now - lastSent < 200) return;
        lastSent = now;
        const part = Math.max(0, Math.min(1, time / duration));
        const left = speed > 0 ? ((1 - part) * duration) / speed : 0;
        emit({ ratio: from + part * share, speed, left });
      },
    });
    active.get(job.id).child = child;
    done.then(resolve);
  });
}

async function runPlan(job, plan, tmp, emit) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'convertline-'));
  try {
    let from = 0;
    for (const step of plan.steps) {
      const r = await runStep(job, step, tmp, cwd, from, step.weight, emit);
      if (active.get(job.id)?.cancelled) return { cancelled: true };
      if (r.code !== 0) return { error: r.err.trim().split(/\r?\n/).slice(-6).join('\n') };
      from += step.weight;
    }
    return {};
  } finally {
    cleanup([cwd]);
  }
}

function plan(src, target, o, env, tune) {
  if (src.kind === 'image') return planImage(src, target, o, env);
  if (isAudioTarget(target)) return planAudio(src, target, o);
  return planVideo(src, target, o, env, tune);
}

async function mediaJob(job, tmp, env, emit) {
  const src = { file: job.file, kind: job.kind, probe: job.probe, orientation: job.kind === 'image' ? ff.jpegOrientation(job.file) : 1 };
  const o = job.options;
  const target = job.target;
  const raster = job.kind === 'image' && extOf(job.file) === 'svg';
  const extra = [];
  try {
    if (raster) {
      const png = `${tmp}.svg.png`;
      extra.push(png);
      await docs.svgToPng(job.file, png, o.maxSize);
      src.file = png;
      src.probe = await ff.probe(png);
      if (!src.probe) return { error: 'SVG' };
    }
    const asPdf = job.kind === 'image' && target === 'pdf';
    const jpeg = asPdf ? `${tmp}.jpg` : null;
    if (jpeg) extra.push(jpeg);
    const work = asPdf ? jpeg : tmp;
    let tune = {};
    for (let attempt = 0; attempt < 3; attempt++) {
      const p = plan(src, target, o, env, tune);
      const r = await runPlan(job, p, work, emit);
      if (r.cancelled) return r;
      if (r.error) {
        // Grafikkarte zickt: einmal ohne sie
        if (p.hw && !tune.noHw) {
          tune = { ...tune, noHw: true };
          continue;
        }
        return r;
      }
      if (asPdf) {
        const [w, h] = p.size;
        docs.jpegToPdf(jpeg, w, h, tmp);
        return { hw: false };
      }
      // Zielgröße nicht getroffen: mit weniger Bitrate nochmal
      if (p.sizeLimit && fs.statSync(tmp).size > p.sizeLimit && attempt < 2) {
        tune = { ...tune, factor: (tune.factor || 0.96) * 0.88 };
        continue;
      }
      return { hw: p.hw, copied: p.copied };
    }
    return {};
  } catch (e) {
    return { code: e.code, error: e.detail || String(e.message) };
  } finally {
    cleanup(extra);
  }
}

function freeFolder(dir, base) {
  let p = path.join(dir, base);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})`);
  return p;
}

async function pdfPagesJob(job, dir, base, emit) {
  // Mehrere Seiten kommen in einen eigenen Ordner, eine einzelne direkt neben das Original
  const folder = freeFolder(dir, base);
  const made = [];
  try {
    const list = await docs.pdfToImages(job.file, job.target, job.options.dpi, (i, n) => {
      if (n === 1) {
        const p = targetPath(dir, base, job.target, job.rule === 'skip' ? 'number' : job.rule, job.file);
        made.push(p);
        return p;
      }
      if (i === 1) {
        fs.mkdirSync(folder, { recursive: true });
        made.push(folder);
      }
      return path.join(folder, `${base}-${String(i).padStart(String(n).length, '0')}.${job.target}`);
    }, (ratio) => {
      if (active.get(job.id)?.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
      emit({ ratio, speed: 0, left: 0 });
    });
    return list.length > 1 ? folder : list[0];
  } catch (e) {
    cleanup(made);
    throw e;
  }
}

/** job: { id, file, kind, ext, probe, target, options, outDir, rule, useHw } */
async function runJob(job, emit) {
  active.set(job.id, { child: null, cancelled: false });
  const dir = job.outDir || path.dirname(job.file);
  const base = path.parse(job.file).name;
  const ext = job.target;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const st = fs.statSync(job.file);
    if (job.kind === 'doc' && job.ext === 'pdf' && ext !== 'txt') {
      const out = await pdfPagesJob(job, dir, base, emit);
      const size = fs.statSync(out).isDirectory() ? fs.readdirSync(out).reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0) : fs.statSync(out).size;
      return { out, size };
    }
    const out = targetPath(dir, base, ext, job.rule, job.file);
    if (!out) return { skipped: true };
    reserved.add(key(out));
    const tmp = path.join(dir, `${base}.convertline-tmp-${job.id}.${ext}`);
    try {
      let r;
      if (job.kind === 'doc') {
        await docs.convertDoc(job.file, job.ext, ext, tmp, job.options);
        r = {};
      } else {
        const env = { encoders: await ff.encoders(), useHw: job.useHw, hw: job.useHw ? await ff.hardware() : {} };
        r = await mediaJob(job, tmp, env, emit);
      }
      if (r.cancelled) return { cancelled: true };
      if (r.error) return { error: r.error, code: r.code };
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) return { error: 'EMPTY' };
      fs.rmSync(out, { force: true });
      fs.renameSync(tmp, out);
      fs.utimesSync(out, st.atime, st.mtime);
      return { out, size: fs.statSync(out).size, hw: !!r.hw, copied: !!r.copied };
    } finally {
      cleanup([tmp]);
      reserved.delete(key(out));
    }
  } catch (e) {
    return e.cancelled ? { cancelled: true } : { error: String(e.message || e), code: e.code };
  } finally {
    active.delete(job.id);
  }
}

function cancel(id) {
  const a = active.get(id);
  if (!a) return;
  a.cancelled = true;
  a.child?.kill();
}
const cancelAll = () => [...active.keys()].forEach(cancel);

module.exports = { runJob, cancel, cancelAll, targetPath };
