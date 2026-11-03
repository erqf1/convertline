'use strict';

// Selbsttest (unsichtbar): npx electron . --selftest <ordner>
// Erzeugt Testdateien mit FFmpeg, wandelt sie echt um und prüft die Ergebnisse. Am Ende auch die Oberfläche.
const fs = require('fs');
const path = require('path');
const ff = require('../src/ffmpeg');
const convert = require('../src/convert');
const { app } = require('electron');

module.exports = function selftest(win, dir) {
  const wc = win.webContents;
  const errors = [];
  wc.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 3) errors.push(e.message);
  });
  const IN = path.join(dir, 'ein');
  const OUT = path.join(dir, 'aus');
  fs.rmSync(IN, { recursive: true, force: true });
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(IN, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  const check = (name, ok, info = '') => results.push(`${ok ? 'ok  ' : 'FEHL'} ${name}${info !== '' ? ` (${info})` : ''}`);
  const js = (code) => wc.executeJavaScript(code, true);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    await wait(300);
    await wc.capturePage();
    fs.writeFileSync(path.join(dir, `${name}.png`), (await wc.capturePage()).toPNG());
  };
  const make = async (name, args) => {
    const file = path.join(IN, name);
    const r = await ff.run(['-y', '-hide_banner', '-nostdin', '-v', 'error', ...args, file]).done;
    if (r.code !== 0) throw new Error(`Testdatei ${name}: ${r.err}`);
    return file;
  };
  let n = 0;
  const job = async (file, kind, target, options = {}, extra = {}) => {
    const probe = kind === 'doc' ? null : await ff.probe(file);
    return convert.runJob({ id: `t${++n}`, file, kind, ext: path.extname(file).slice(1).toLowerCase(), probe, target, options, outDir: OUT, rule: 'number', useHw: false, ...extra }, () => {});
  };
  const expectStreams = async (label, r, test) => {
    if (r.error || !r.out) return check(label, false, r.error?.slice(0, 200) || 'kein Ergebnis');
    const p = await ff.probe(r.out);
    check(label, !!p && test(p), p ? `${p.video?.codec || '-'} ${p.video?.w}x${p.video?.h} ${p.audio.map((a) => a.codec).join('+')} ${(r.size / 1024).toFixed(0)} KB` : 'nicht lesbar');
  };

  wc.once('did-finish-load', async () => {
    try {
      // ---------------- Testdateien
      const av = ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4'];
      const mkv = await make('Video ä %.mkv', [...av, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
      const srt = path.join(IN, 'u.srt');
      fs.writeFileSync(srt, '1\n00:00:00,500 --> 00:00:02,000\nHallo\n');
      const subs = await make('mit-untertitel.mkv', ['-i', mkv, '-i', srt, '-map', '0', '-map', '1', '-c', 'copy']);
      const stumm = await make('stumm.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']);
      const cover = await make('cover.png', ['-f', 'lavfi', '-i', 'color=c=red:s=300x300', '-frames:v', '1', '-update', '1']);
      const wav = await make('ton.wav', ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=3']);
      const mp3 = await make('getaggt.mp3', ['-i', wav, '-i', cover, '-map', '0', '-map', '1', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', '-c:a', 'libmp3lame', '-metadata', 'title=Müller Song', '-metadata', 'artist=Testband', '-id3v2_version', '3']);
      const alpha = await make('alpha.png', ['-f', 'lavfi', '-i', 'color=c=red@0.5:s=640x480,format=rgba', '-frames:v', '1', '-update', '1']);
      const jpg = await make('foto.jpg', ['-f', 'lavfi', '-i', 'testsrc2=s=800x600', '-frames:v', '1', '-update', '1']);
      const anim = await make('animiert.gif', ['-f', 'lavfi', '-i', 'testsrc2=s=200x150:r=10:d=1']);

      // ---------------- Untersuchen
      const p = await ff.probe(mkv);
      check('Untersuchen: Video und Ton', p.video?.w === 1280 && p.video.h === 720 && p.audio.length === 1 && Math.abs(p.duration - 4) < 0.2, `${p.duration}s`);
      check('Untersuchen: Untertitel', (await ff.probe(subs)).subs.length === 1);
      check('Untersuchen: Cover', !!(await ff.probe(mp3)).cover);
      check('Untersuchen: Transparenz', (await ff.probe(alpha)).video?.alpha === true);
      check('Vorschaubild', /^data:image\/png/.test(await ff.thumbnail(mkv, p) || ''));
      const hw = await ff.hardware();
      check('Grafikkarte erkannt (nur Info)', true, JSON.stringify(hw));

      // ---------------- Video
      const q = { codec: 'auto', quality: 'original', sizeMB: 0, height: 0, fps: 0, audio: 'keep' };
      const t0 = Date.now();
      const copy = await job(mkv, 'video', 'mp4', q);
      await expectStreams('MKV zu MP4 ohne neu kodieren', copy, (x) => x.video.codec === 'h264' && x.audio[0].codec === 'aac');
      check('Umverpacken ist schnell', copy.copied === true && Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
      await expectStreams('zu WebM', await job(mkv, 'video', 'webm', { ...q, quality: 'small' }), (x) => x.video.codec === 'vp9' && x.audio[0].codec === 'opus');
      await expectStreams('zu MOV', await job(mkv, 'video', 'mov', q), (x) => x.video.codec === 'h264');
      await expectStreams('zu AVI', await job(mkv, 'video', 'avi', q), (x) => x.video.codec === 'mpeg4' && x.audio[0].codec === 'mp3');
      await expectStreams('zu H.265', await job(mkv, 'video', 'mp4', { ...q, codec: 'h265', quality: 'balanced' }), (x) => x.video.codec === 'hevc');
      await expectStreams('zu AV1', await job(stumm, 'video', 'mp4', { ...q, codec: 'av1', quality: 'small' }), (x) => x.video.codec === 'av1');
      await expectStreams('verkleinern auf 360p', await job(mkv, 'video', 'mp4', { ...q, height: 360, quality: 'balanced' }), (x) => x.video.h === 360 && x.video.w === 640);
      await expectStreams('nie hochskalieren', await job(stumm, 'video', 'mp4', { ...q, height: 1080, quality: 'balanced' }), (x) => x.video.h === 360);
      await expectStreams('Bilder pro Sekunde', await job(mkv, 'video', 'mp4', { ...q, fps: 15, quality: 'balanced' }), (x) => Math.round(x.video.fps) === 15);
      await expectStreams('Ton entfernen', await job(mkv, 'video', 'mp4', { ...q, audio: 'none', quality: 'balanced' }), (x) => x.audio.length === 0);
      await expectStreams('Untertitel nach MP4', await job(subs, 'video', 'mp4', q), (x) => x.subs[0]?.codec === 'mov_text');
      await expectStreams('Untertitel bleiben in MKV', await job(subs, 'video', 'mkv', q), (x) => x.subs.length === 1);
      await expectStreams('Video ohne Ton', await job(stumm, 'video', 'mp4', { ...q, quality: 'balanced' }), (x) => x.audio.length === 0);
      await expectStreams('Video zu GIF', await job(stumm, 'video', 'gif', q), (x) => x.video.codec === 'gif');
      await expectStreams('Animiertes GIF zu MP4', await job(anim, 'video', 'mp4', { ...q, quality: 'balanced' }), (x) => x.video.codec === 'h264');
      const size = await job(mkv, 'video', 'mp4', { ...q, sizeMB: 1 });
      await expectStreams('Zielgröße 1 MB', size, (x) => x.video.codec === 'h264');
      check('Zielgröße eingehalten', size.size <= 1e6 && size.size > 3e5, `${(size.size / 1e6).toFixed(2)} MB`);
      const size265 = await job(mkv, 'video', 'mkv', { ...q, codec: 'h265', sizeMB: 1 });
      check('Zielgröße mit H.265', !size265.error && size265.size <= 1e6, size265.error?.slice(0, 200) || `${(size265.size / 1e6).toFixed(2)} MB`);
      check('Zielgröße zu klein', (await job(mkv, 'video', 'mp4', { ...q, sizeMB: 0.01 })).code === 'TARGET_TOO_SMALL');
      if (hw.h264) {
        const h = await job(mkv, 'video', 'mp4', { ...q, quality: 'balanced' }, { useHw: true });
        await expectStreams('Grafikkarte H.264', h, (x) => x.video.codec === 'h264');
        check('Grafikkarte wurde benutzt', h.hw === true);
      }
      if (hw.h265) await expectStreams('Grafikkarte H.265', await job(mkv, 'video', 'mp4', { ...q, codec: 'h265', quality: 'balanced' }, { useHw: true }), (x) => x.video.codec === 'hevc');

      // ---------------- Musik
      const a = { kbps: 192, normalize: false };
      const fromVideo = await job(mkv, 'video', 'mp3', a);
      await expectStreams('Video zu MP3', fromVideo, (x) => x.audio[0].codec === 'mp3' && !x.video);
      for (const [target, codec] of [['m4a', 'aac'], ['flac', 'flac'], ['wav', 'pcm_s16le'], ['ogg', 'vorbis'], ['opus', 'opus']]) await expectStreams(`Musik zu ${target}`, await job(wav, 'audio', target, a), (x) => x.audio[0].codec === codec);
      const tagged = await job(mp3, 'audio', 'flac', a);
      await expectStreams('Cover bleibt in FLAC', tagged, (x) => !!x.cover);
      const tags = (await ff.run(['-hide_banner', '-nostdin', '-i', tagged.out]).done).err;
      check('Titel mit Umlaut bleibt', /Müller Song/.test(tags) && /Testband/.test(tags));
      await expectStreams('Cover bleibt in M4A', await job(mp3, 'audio', 'm4a', a), (x) => !!x.cover);
      await expectStreams('Lautstärke angleichen', await job(wav, 'audio', 'mp3', { ...a, normalize: true }), (x) => x.audio[0].codec === 'mp3');
      check('Video ohne Ton zu MP3', (await job(stumm, 'video', 'mp3', a)).code === 'NO_AUDIO');

      // ---------------- Bilder
      const i = { quality: 85, maxSize: 0, background: '#ffffff' };
      for (const [target, codec] of [['png', 'png'], ['jpg', 'mjpeg'], ['webp', 'webp'], ['avif', 'av1'], ['bmp', 'bmp'], ['tiff', 'tiff'], ['gif', 'gif']]) {
        await expectStreams(`Foto zu ${target}`, await job(jpg, 'image', target, i), (x) => x.video.codec === codec && x.video.w === 800);
      }
      for (const target of ['png', 'jpg', 'webp', 'avif', 'bmp', 'tiff', 'gif']) await expectStreams(`Transparent zu ${target}`, await job(alpha, 'image', target, i), (x) => !!x.video && x.video.w === 640);
      const icon = await job(alpha, 'image', 'ico', i);
      const ico = fs.readFileSync(icon.out);
      check('ICO mit mehreren Größen', ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 7, ico.readUInt16LE(4));
      await expectStreams('Bild verkleinern', await job(jpg, 'image', 'png', { ...i, maxSize: 200 }), (x) => x.video.w === 200 && x.video.h === 150);
      const pdf = await job(jpg, 'image', 'pdf', i);
      check('Bild zu PDF', !pdf.error && fs.readFileSync(pdf.out).subarray(0, 5).toString() === '%PDF-', pdf.error || `${pdf.size} B`);
      const flat = await job(alpha, 'image', 'jpg', { ...i, background: '#00ff00' });
      const px = await ff.run(['-hide_banner', '-nostdin', '-v', 'error', '-i', flat.out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { binaryOut: true }).done;
      check('Hintergrundfarbe unter Transparenz', px.out[1] > 90 && px.out[0] > 90, [...px.out.subarray(0, 3)].join(','));
      const svg = path.join(IN, 'logo.svg');
      fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#0af"/></svg>');
      const svgR = await convert.runJob({ id: `t${++n}`, file: svg, kind: 'image', ext: 'svg', probe: { video: null, audio: [], subs: [] }, target: 'png', options: i, outDir: OUT, rule: 'number', useHw: false }, () => {});
      await expectStreams('SVG zu PNG', svgR, (x) => x.video.w === 120);
      // EXIF-Drehung: JPEG mit Orientation 6 von Hand zusammensetzen
      const b = fs.readFileSync(jpg);
      const tiff = Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
      const seg = Buffer.alloc(4);
      seg[0] = 0xff;
      seg[1] = 0xe1;
      seg.writeUInt16BE(exif.length + 2, 2);
      const turned = path.join(IN, 'hochkant.jpg');
      fs.writeFileSync(turned, Buffer.concat([b.subarray(0, 2), seg, exif, b.subarray(2)]));
      check('EXIF-Drehung gelesen', ff.jpegOrientation(turned) === 6, ff.jpegOrientation(turned));
      await expectStreams('EXIF-Drehung wird angewandt', await job(turned, 'image', 'png', i), (x) => x.video.w === 600 && x.video.h === 800);

      // ---------------- Dokumente
      const txt = path.join(IN, 'text.txt');
      fs.writeFileSync(txt, 'Hallo Welt äöü\nZweite Zeile');
      const md = path.join(IN, 'notiz.md');
      fs.writeFileSync(md, '# Titel\n\nEin **fetter** Text.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
      const html = path.join(IN, 'seite.html');
      fs.writeFileSync(html, '<html><head><title>x</title><script>document.title="SKRIPT LIEF"</script></head><body><h1 id="a">Überschrift</h1><p>Absatz</p><script>document.body.innerHTML="SKRIPT LIEF"</script></body></html>');
      const isPdf = (r) => !r.error && fs.readFileSync(r.out).subarray(0, 5).toString() === '%PDF-';
      const pdfA = await job(txt, 'doc', 'pdf', { page: 'a4' });
      check('Text zu PDF', isPdf(pdfA), pdfA.error || `${pdfA.size} B`);
      const pdfB = await job(md, 'doc', 'pdf', { page: 'letter' });
      check('Markdown zu PDF', isPdf(pdfB), pdfB.error || `${pdfB.size} B`);
      const pdfC = await job(html, 'doc', 'pdf', { page: 'a4' });
      check('HTML zu PDF', isPdf(pdfC), pdfC.error || `${pdfC.size} B`);
      const mdHtml = await job(md, 'doc', 'html', {});
      check('Markdown zu HTML', !mdHtml.error && /<strong>fetter<\/strong>/.test(fs.readFileSync(mdHtml.out, 'utf8')) && /<table>/.test(fs.readFileSync(mdHtml.out, 'utf8')), mdHtml.error || '');
      const htmlTxt = await job(html, 'doc', 'txt', {});
      const htmlText = htmlTxt.out ? fs.readFileSync(htmlTxt.out, 'utf8') : '';
      check('HTML zu Text, Skripte laufen nicht', /Überschrift/.test(htmlText) && !/SKRIPT LIEF/.test(htmlText), htmlTxt.error || htmlText.slice(0, 40));
      const htmlMd = await job(html, 'doc', 'md', {});
      check('HTML zu Markdown', !htmlMd.error && /Überschrift/.test(fs.readFileSync(htmlMd.out, 'utf8')), htmlMd.error || '');
      const mdTxt = await job(md, 'doc', 'txt', {});
      check('Markdown zu Text', !mdTxt.error && /fetter/.test(fs.readFileSync(mdTxt.out, 'utf8')) && !/\*\*/.test(fs.readFileSync(mdTxt.out, 'utf8')), mdTxt.error || '');
      const pdfTxt = await job(pdfA.out, 'doc', 'txt', {});
      check('PDF zu Text', !pdfTxt.error && /Hallo Welt/.test(fs.readFileSync(pdfTxt.out, 'utf8')), pdfTxt.error || '');
      const pdfPng = await job(pdfA.out, 'doc', 'png', { dpi: 100 });
      await expectStreams('PDF zu PNG (eine Seite)', pdfPng, (x) => x.video.codec === 'png' && x.video.w > 800);
      const long = path.join(IN, 'lang.txt');
      fs.writeFileSync(long, Array.from({ length: 200 }, (_, k) => `Zeile ${k}`).join('\n'));
      const longPdf = await job(long, 'doc', 'pdf', { page: 'a4' });
      const pages = await job(longPdf.out, 'doc', 'jpg', { dpi: 72 });
      check('PDF mit mehreren Seiten', !pages.error && fs.statSync(pages.out).isDirectory() && fs.readdirSync(pages.out).length > 1, pages.error || fs.readdirSync(pages.out).join(','));

      // ---------------- Dateinamen und Abbruch
      const a1 = await job(wav, 'audio', 'mp3', a, { outDir: IN });
      const a2 = await job(wav, 'audio', 'mp3', a, { outDir: IN });
      check('Nichts überschreiben: Nummer', path.basename(a1.out) === 'ton.mp3' && path.basename(a2.out) === 'ton (1).mp3');
      check('Überspringen', (await job(wav, 'audio', 'mp3', a, { outDir: IN, rule: 'skip' })).skipped === true);
      const before = fs.statSync(a1.out).mtimeMs;
      const over = await job(mp3, 'audio', 'mp3', a, { outDir: IN, rule: 'overwrite' });
      check('Original wird nie überschrieben', path.basename(over.out) === 'getaggt (1).mp3' && fs.statSync(a1.out).mtimeMs === before);
      const srcTime = fs.statSync(wav).mtimeMs;
      check('Änderungsdatum bleibt', Math.abs(fs.statSync(a1.out).mtimeMs - srcTime) < 2000);
      const same = await Promise.all([job(mkv, 'video', 'mkv', q, { outDir: OUT }), job(mkv, 'video', 'mkv', q, { outDir: OUT })]);
      check('Gleichzeitig gleicher Name', same[0].out !== same[1].out);
      const longFile = await make('lang.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']);
      const longProbe = await ff.probe(longFile);
      const running = convert.runJob({ id: 'abbruch', file: longFile, kind: 'video', ext: 'mp4', probe: longProbe, target: 'webm', options: { ...q, quality: 'high' }, outDir: OUT, rule: 'number', useHw: false }, () => {});
      await wait(1500);
      convert.cancel('abbruch');
      const stopped = await running;
      check('Abbrechen', stopped.cancelled === true);
      check('Keine Reste', !fs.readdirSync(OUT).some((f) => /convertline-tmp/.test(f)) && !fs.readdirSync(IN).some((f) => /convertline-tmp/.test(f)));
      let moved = 0;
      const prog = await convert.runJob({ id: 'fortschritt', file: mkv, kind: 'video', ext: 'mkv', probe: await ff.probe(mkv), target: 'webm', options: { ...q, quality: 'balanced' }, outDir: OUT, rule: 'number', useHw: false }, (e) => {
        moved = Math.max(moved, e.ratio);
      });
      check('Fortschritt wird gemeldet', moved > 0.1 && !prog.error, moved.toFixed(2));

      // ---------------- Oberfläche
      win.setSize(1180, 760);
      await wait(600);
      await shot('leer');
      const ui = fs.mkdtempSync(path.join(dir, 'ui-'));
      for (const f of [mkv, mp3, jpg, md, pdfA.out]) fs.copyFileSync(f, path.join(ui, path.basename(f)));
      await js(`window.__cl.set({ save: { mode: 'same', folder: '' }, parallel: 2 }); window.__cl.addPaths(${JSON.stringify([ui])})`);
      await js('new Promise((ok) => { const t = setInterval(() => { if (window.__cl.items.length === 5 && window.__cl.items.every((i) => i.status === "ready")) { clearInterval(t); ok(); } }, 50); })');
      check('Ordner aufgenommen', (await js('window.__cl.items.length')) === 5);
      check('Zeilen da', (await js('document.querySelectorAll(".item").length')) === 5);
      await shot('liste');
      for (const k of ['audio', 'image', 'doc', 'video']) {
        await js(`window.__cl.setKind("${k}")`);
        await shot(`panel-${k}`);
      }
      await js('window.__cl.start()');
      await js('new Promise((ok) => { const t = setInterval(() => { if (!window.__cl.isRunning()) { clearInterval(t); ok(); } }, 80); })');
      const states = await js('window.__cl.items.map((i) => i.status + ":" + (i.error || ""))');
      check('Oberfläche wandelt alles um', states.every((s) => s.startsWith('done')), states.join(' '));
      check('Dateien neben dem Original', fs.readdirSync(ui).length === 10, fs.readdirSync(ui).join(', '));
      await shot('fertig');
      await js('document.querySelector("#topbar .icon-btn").click()');
      await shot('einstellungen');
      check('Einstellungen gehen auf', (await js('document.querySelectorAll(".dialog select").length')) === 5);
      await js('document.querySelector(".dialog .btn.primary").click()');
      for (const lang of ['de', 'ja']) {
        await js(`window.__cl.set({ language: "${lang}" }); window.__cl.refresh()`);
        await shot(`sprache-${lang}`);
      }
      await js('window.__cl.set({ language: "de", look: "acryl" }); window.__cl.refresh()');
      await shot('acryl');
      await js('window.__cl.set({ look: "standard", mode: "light" }); window.__cl.refresh()');
      await shot('hell');
      check('Keine Fehler in der Konsole', errors.length === 0, errors.slice(0, 3).join(' | '));
    } catch (e) {
      check('Testlauf', false, e && e.stack ? e.stack : String(e));
    }
    const failed = results.filter((r) => r.startsWith('FEHL')).length;
    console.log(`${results.join('\n')}\n${results.length} Prüfungen, ${failed} fehlgeschlagen`);
    fs.writeFileSync(path.join(dir, 'ergebnis.txt'), `${results.join('\n')}\n${results.length} Prüfungen, ${failed} fehlgeschlagen\n`);
    app.exit(failed ? 1 : 0);
  });
};
