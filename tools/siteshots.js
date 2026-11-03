'use strict';

// Bilder für die Website (unsichtbar): npx electron . --siteshots <ordner>
// Alles echt: selbst erzeugte Testdateien, echte Umwandlung. Die Dateien sind von FFmpeg gerechnet, also frei von fremden Rechten.
const fs = require('fs');
const path = require('path');
const ff = require('../src/ffmpeg');
const { app } = require('electron');

module.exports = function siteshots(win, dir) {
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    await wait(350);
    await wc.capturePage();
    fs.writeFileSync(path.join(dir, `${name}.png`), (await wc.capturePage()).toPNG());
  };
  const SRC = path.join(dir, 'quelle');
  const make = async (name, args) => {
    const r = await ff.run(['-y', '-hide_banner', '-nostdin', '-v', 'error', ...args, path.join(SRC, name)]).done;
    if (r.code !== 0) throw new Error(`${name}: ${r.err}`);
  };

  wc.once('did-finish-load', async () => {
    try {
      fs.rmSync(SRC, { recursive: true, force: true });
      fs.mkdirSync(SRC, { recursive: true });
      await make('cover.png', ['-f', 'lavfi', '-i', 'gradients=s=500x500:c0=0x0ea5e9:c1=0x7c3aed:x0=0:y0=0:x1=500:y1=500', '-frames:v', '1', '-update', '1']);
      await make('Holiday 2026.mkv', ['-f', 'lavfi', '-i', 'mandelbrot=s=1920x1080:r=30', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=16', '-t', '16', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
      await make('Screen recording.mov', ['-f', 'lavfi', '-i', 'gradients=s=2560x1440:n=5:speed=0.03:r=30', '-t', '12', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p']);
      await make('Mixtape.flac', ['-f', 'lavfi', '-i', 'sine=frequency=261:duration=150', '-i', path.join(SRC, 'cover.png'), '-map', '0', '-map', '1', '-c:v', 'copy', '-disposition:v', 'attached_pic', '-metadata', 'title=Mixtape', '-c:a', 'flac']);
      await make('Photo 0142.png', ['-f', 'lavfi', '-i', 'gradients=s=4000x3000:c0=0x0f766e:c1=0xfacc15:c2=0x1d4ed8:n=3:x0=0:y0=0:x1=4000:y1=3000', '-frames:v', '1', '-update', '1']);
      fs.writeFileSync(path.join(SRC, 'Notes.md'), '# Notes\n\nSome **text** to turn into a PDF.\n');
      fs.rmSync(path.join(SRC, 'cover.png'));

      win.setSize(1240, 800);
      await wait(500);
      for (const lang of ['en', 'de']) {
        const run = path.join(dir, `lauf-${lang}`);
        fs.rmSync(run, { recursive: true, force: true });
        fs.cpSync(SRC, run, { recursive: true });
        await js(`(() => { const c = window.__cl; c.items.length = 0; c.set({ language: ${JSON.stringify(lang)}, mode: 'dark', look: 'standard', parallel: 2, exists: 'overwrite', useHw: false, save: { mode: 'same', folder: '' } });
          const s = c.settings(); s.targets.video = 'mp4'; s.targets.audio = 'mp3'; s.targets.image = 'webp'; s.targets.doc = 'pdf'; s.video.quality = 'balanced'; s.video.height = 1080; s.video.codec = 'auto'; s.image.quality = 85; c.setKind('video'); c.refresh(); })()`);
        await shot(`empty-${lang}`);
        await js(`window.__cl.addPaths(${JSON.stringify([run])})`);
        await js('new Promise((ok) => { const t = setInterval(() => { const i = window.__cl.items; if (i.length === 5 && i.every((x) => x.status === "ready")) { clearInterval(t); ok(); } }, 50); })');
        await js('window.__cl.items.reverse(); window.__cl.refresh()');
        await shot(`list-${lang}`);
        await js('void window.__cl.start()'); // nicht auf das Ende warten
        await js('new Promise((ok) => { const t = setInterval(() => { if (window.__cl.items.some((x) => x.status === "running" && x.ratio > 0.3)) { clearInterval(t); ok(); } }, 60); })');
        await shot(`queue-${lang}`);
        await js('new Promise((ok) => { const t = setInterval(() => { if (!window.__cl.isRunning()) { clearInterval(t); ok(); } }, 100); })');
        await wait(2800);
        await shot(`done-${lang}`);
        await js('window.__cl.setKind("image")');
        await shot(`image-${lang}`);
      }
      console.log('Bilder fertig');
    } catch (e) {
      console.log('Fehler:', e && e.stack ? e.stack : e);
    }
    app.exit(0);
  });
};
