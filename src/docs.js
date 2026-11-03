'use strict';

// Dokumente und alles, wofür Chromium nötig ist: PDF drucken, PDF lesen, SVG in ein Bild rastern.
// Läuft in unsichtbaren Fenstern ohne Skripte der Datei und ohne Netz.
const { BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const libs = () => require('./dist/doclibs');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const STYLE = `body{font:11pt/1.55 "Segoe UI",system-ui,-apple-system,Roboto,"Noto Sans",sans-serif;color:#111;margin:0}
h1,h2,h3,h4{line-height:1.25;margin:1.2em 0 .5em}h1{font-size:22pt}h2{font-size:16pt}h3{font-size:13pt}
img{max-width:100%}pre{white-space:pre-wrap;word-break:break-word}
pre,code{font-family:Consolas,"SF Mono",Menlo,"DejaVu Sans Mono",monospace;font-size:9.5pt}
pre{background:#f4f4f5;padding:10px 12px;border-radius:4px}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #bbb;padding:5px 8px;text-align:left}blockquote{margin:1em 0;padding-left:12px;border-left:3px solid #bbb;color:#444}`;

/** Text lesen: UTF-8 mit oder ohne BOM, UTF-16, sonst Windows-1252 */
function readText(file) {
  const b = fs.readFileSync(file);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b);
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}

const page = (body, baseFile, title) => `<!doctype html><html><head><meta charset="utf-8">${guard(baseFile)}<title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

// Keine Skripte, kein Netz; Bilder neben der Datei dürfen geladen werden
function guard(baseFile) {
  return `<meta http-equiv="Content-Security-Policy" content="default-src file: data: 'unsafe-inline'; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'"><base href="${esc(pathToFileURL(path.dirname(baseFile)).href)}/">`;
}

async function toHtml(file, ext) {
  const name = path.parse(file).name;
  if (ext === 'txt') return page(`<pre style="background:none;padding:0;font-family:inherit;font-size:inherit">${esc(readText(file))}</pre>`, file, name);
  if (ext === 'md' || ext === 'markdown') return page(await libs().marked.parse(readText(file)), file, name);
  if (ext === 'docx') {
    const { value } = await libs().mammoth.convertToHtml({ path: file });
    return page(value, file, name);
  }
  // HTML: Sperre direkt hinter <head> einsetzen
  const text = readText(file);
  const inject = guard(file);
  if (/<head[^>]*>/i.test(text)) return text.replace(/<head[^>]*>/i, (m) => `${m}<meta charset="utf-8">${inject}`);
  return page(text, file, name);
}

async function withWindow(options, fn) {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true, spellcheck: false, backgroundThrottling: false, ...options } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  try {
    return await fn(win);
  } finally {
    win.destroy();
  }
}

async function withPage(html, fn) {
  const tmp = path.join(os.tmpdir(), `convertline-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(tmp, html);
  try {
    return await withWindow({}, async (win) => {
      await win.loadFile(tmp);
      return fn(win);
    });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function htmlToPdf(html, out, pageSize) {
  await withPage(html, async (win) => {
    const pdf = await win.webContents.printToPDF({ pageSize: pageSize === 'letter' ? 'Letter' : 'A4', printBackground: true, margins: { top: 0.8, bottom: 0.8, left: 0.8, right: 0.8 } });
    fs.writeFileSync(out, pdf);
  });
}

const textOf = (html) => withPage(html, (win) => win.webContents.executeJavaScript('document.body.innerText'));

/** Ein JPEG als PDF-Seite: dafür reicht ein von Hand geschriebenes PDF */
function jpegToPdf(jpeg, w, h, out) {
  const data = fs.readFileSync(jpeg);
  // 96 dpi: 1 Pixel = 0,75 Punkt
  const pw = (w * 0.75).toFixed(2);
  const ph = (h * 0.75).toFixed(2);
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  const parts = [];
  const offsets = [];
  let size = 0;
  const add = (b) => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1');
    parts.push(buf);
    size += buf.length;
  };
  const obj = (n, head, stream) => {
    offsets[n] = size;
    add(`${n} 0 obj\n${head}\n`);
    if (stream) {
      add('stream\n');
      add(stream);
      add('\nendstream\n');
    }
    add('endobj\n');
  };
  add('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>`);
  obj(4, `<< /Length ${content.length} >>`, content);
  obj(5, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>`, data);
  const xref = size;
  add(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('')}`);
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  fs.writeFileSync(out, Buffer.concat(parts));
}

/** SVG in ein PNG rastern (FFmpeg kann das in diesen Builds nicht). Skripte im SVG laufen als <img> nicht */
async function svgToPng(file, out, maxSize) {
  const b64 = fs.readFileSync(file).toString('base64');
  const data = await withPage(page('', file, 'svg'), (win) => win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,${b64}';
    await img.decode();
    const w0 = img.naturalWidth || 1024, h0 = img.naturalHeight || 1024;
    const f = ${Number(maxSize) || 0} ? ${Number(maxSize) || 0} / Math.max(w0, h0) : 1;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * f));
    c.height = Math.max(1, Math.round(h0 * f));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png').split(',')[1];
  })()`));
  fs.writeFileSync(out, Buffer.from(data, 'base64'));
}

// ---------------------------------------------------------------- PDF lesen (pdf.js in einem eigenen Fenster)
let pdfBytes = null;
ipcMain.handle('pdf:bytes', () => pdfBytes);

async function withPdf(file, fn) {
  // pdf.js lädt immer nur eine Datei gleichzeitig: Aufträge laufen nacheinander
  const run = async () => {
    const b = fs.readFileSync(file);
    pdfBytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return withWindow({ preload: path.join(__dirname, 'pdf-preload.js') }, async (win) => {
      await win.loadFile(path.join(__dirname, 'renderer', 'pdf.html'));
      const pages = await win.webContents.executeJavaScript('window.pdfReady');
      return fn(win, pages);
    });
  };
  const next = withPdf.queue.then(run, run);
  withPdf.queue = next.catch(() => {});
  return next;
}
withPdf.queue = Promise.resolve();

async function pdfToText(file, out) {
  await withPdf(file, async (win, pages) => {
    const list = [];
    for (let i = 1; i <= pages; i++) list.push(await win.webContents.executeJavaScript(`window.pdfText(${i})`));
    fs.writeFileSync(out, list.join('\n\n'));
  });
}

async function pdfToImages(file, target, dpi, makeOut, onPage) {
  return withPdf(file, async (win, pages) => {
    const made = [];
    for (let i = 1; i <= pages; i++) {
      const data = await win.webContents.executeJavaScript(`window.pdfImage(${i}, ${Number(dpi) || 150}, ${JSON.stringify(target)})`);
      const name = makeOut(i, pages);
      fs.writeFileSync(name, Buffer.from(data, 'base64'));
      made.push(name);
      onPage(i / pages);
    }
    return made;
  });
}

/** Wandelt ein Dokument um. tmp bekommt das Ergebnis (bei PDF zu Bild übernimmt das convert.js) */
async function convertDoc(file, ext, target, tmp, o) {
  if (ext === 'pdf' && target === 'txt') return pdfToText(file, tmp);
  const kind = ext === 'htm' ? 'html' : ext;
  if (target === 'md') {
    if (kind === 'docx') {
      const { value } = await libs().mammoth.convertToHtml({ path: file });
      return fs.writeFileSync(tmp, new (libs().Turndown)().turndown(value));
    }
    if (kind === 'txt') return fs.copyFileSync(file, tmp);
    return fs.writeFileSync(tmp, new (libs().Turndown)().remove(['script', 'style']).turndown(readText(file)));
  }
  if (target === 'txt') {
    if (kind === 'docx') return fs.writeFileSync(tmp, (await libs().mammoth.extractRawText({ path: file })).value);
    return fs.writeFileSync(tmp, await textOf(await toHtml(file, kind)));
  }
  const html = await toHtml(file, kind);
  if (target === 'html') return fs.writeFileSync(tmp, html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''));
  return htmlToPdf(html, tmp, o.page);
}

module.exports = { convertDoc, jpegToPdf, svgToPng, pdfToImages };
