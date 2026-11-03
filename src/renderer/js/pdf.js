// Unsichtbare Seite zum Lesen von PDFs: Text und Seitenbilder. Der Hauptprozess ruft die Funktionen per executeJavaScript auf.
import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import * as worker from 'pdfjs-dist/build/pdf.worker.mjs';

// Worker im selben Fenster: aus file:// lässt sich keiner starten, und sichtbar wird hier sowieso nichts
globalThis.pdfjsWorker = worker;

let doc = null;
window.pdfReady = (async () => {
  const data = await window.pdfApi.bytes();
  doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  return doc.numPages;
})();

window.pdfText = async (n) => {
  const page = await doc.getPage(n);
  const { items } = await page.getTextContent();
  const text = items.map((i) => `${i.str || ''}${i.hasEOL ? '\n' : ''}`).join('');
  page.cleanup();
  return text;
};

window.pdfImage = async (n, dpi, target) => {
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale: dpi / 72 });
  const c = document.createElement('canvas');
  c.width = Math.ceil(viewport.width);
  c.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport, background: '#ffffff' }).promise;
  page.cleanup();
  return c.toDataURL(target === 'jpg' ? 'image/jpeg' : 'image/png', 0.92).split(',')[1];
};
