'use strict';

// Convertline - Hauptprozess: Fenster, Einstellungen, Dateien finden, Aufträge starten und Updates.
// Die Warteschlange und alle Menüs und Dialoge leben im Renderer.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, nativeImage, net } = require('electron');
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');
const convert = require('./convert');
const { kindOf, extOf } = require('./shared/formats');
const { t: tr } = require('./shared/i18n');

const APP_ID = 'win.mert.Convertline';
const REPO = 'erqf1/convertline';
// --selftest <ordner>: Selbsttest; --siteshots <ordner>: Bilder für die Website (beides unsichtbar)
const testArg = ['--selftest', '--siteshots'].find((a) => process.argv.includes(a));
const selfTest = testArg ? process.argv[process.argv.indexOf(testArg) + 1] : null;
const MAX_FILES = 5000;

if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
if (selfTest) {
  app.setPath('userData', path.join(selfTest, 'userdata'));
  // Selbsttest läuft unsichtbar: Fehler nur ausgeben, nie als Fehlerfenster zeigen
  process.on('uncaughtException', (e) => {
    console.log('Fehler im Selbsttest:', e && e.stack ? e.stack : e);
    app.exit(1);
  });
}

let win = null;
let settings = {};
let closingAllowed = false;
const pendingFiles = [];

const userFile = (name) => path.join(app.getPath('userData'), name);
const t = (key, vars) => tr(settings.language || 'en', key, vars);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/** Dateien aus der Befehlszeile (Rechtsklick "Mit Convertline umwandeln") */
function filesFromArgs(argv, cwd) {
  const out = [];
  const args = argv.slice(app.isPackaged ? 1 : 2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--selftest' || a === '--siteshots') {
      i++;
      continue;
    }
    if (!a || a.startsWith('-')) continue;
    const p = path.resolve(cwd || process.cwd(), a);
    if (fs.existsSync(p) && p !== path.resolve(app.getAppPath())) out.push(p);
  }
  return out;
}

if (!selfTest && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    const list = filesFromArgs(argv, cwd);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (list.length) win.webContents.send('app:open-files', list);
    }
  });
}

// macOS: Dateien per Finder/Dock
app.on('open-file', (e, file) => {
  e.preventDefault();
  if (win && win.webContents && !win.webContents.isLoading()) win.webContents.send('app:open-files', [file]);
  else pendingFiles.push(file);
});

function createWindow() {
  const state = settings.window || {};
  win = new BrowserWindow({
    width: state.width || 1120,
    height: state.height || 720,
    x: state.x,
    y: state.y,
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'Convertline',
    backgroundColor: settings.mode === 'light' || (settings.mode !== 'dark' && !nativeTheme.shouldUseDarkColors) ? '#f3f4f7' : '#14161b',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      // Selbsttest: das versteckte Fenster soll trotzdem normal zeichnen
      backgroundThrottling: !selfTest,
    },
  });
  if (state.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!selfTest) win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });
  const remember = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const maximized = win.isMaximized();
    const b = maximized ? settings.window || {} : win.getBounds();
    settings.window = { x: b.x, y: b.y, width: b.width, height: b.height, maximized };
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('maximize', remember);
  win.on('unmaximize', remember);
  // Schließen: erst fragt der Renderer nach, wenn noch umgewandelt wird
  win.on('close', (e) => {
    if (closingAllowed || selfTest) return;
    e.preventDefault();
    win.webContents.send('app:closing');
  });
  win.on('closed', () => {
    win = null;
  });
}

function buildMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS braucht ein Bearbeiten-Menü, sonst gehen Kopieren/Einfügen per Cmd in Eingabefeldern nicht
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
}

// ---------------------------------------------------------------- IPC: Einstellungen und App
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, next) => {
  settings = { ...next, window: settings.window };
  writeJson(userFile('settings.json'), settings);
  return true;
});
ipcMain.handle('app:initial-files', () => {
  const list = [...filesFromArgs(process.argv, process.cwd()), ...pendingFiles];
  pendingFiles.length = 0;
  return list;
});
ipcMain.handle('app:info', async () => ({
  version: app.getVersion(),
  platform: process.platform,
  dark: nativeTheme.shouldUseDarkColors,
  selfTest: !!selfTest,
  encoders: await ff.encoders(),
}));
ipcMain.handle('app:hardware', () => ff.hardware());
ipcMain.handle('app:close-now', () => {
  closingAllowed = true;
  convert.cancelAll();
  if (win) win.close();
});
ipcMain.handle('app:progress', (_e, ratio, title) => {
  if (!win) return;
  win.setProgressBar(ratio == null ? -1 : ratio);
  win.setTitle(title);
});
nativeTheme.on('updated', () => {
  if (win) win.webContents.send('app:system-theme', nativeTheme.shouldUseDarkColors);
});

// ---------------------------------------------------------------- IPC: Dateien
ipcMain.handle('file:open-dialog', async (_e, { title, folders = false } = {}) => {
  const r = await dialog.showOpenDialog(win, { title, properties: folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('file:pick-folder', async (_e, { title } = {}) => {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

/** Ordner durchsuchen; zurück kommen nur Dateien, die Convertline kennt */
ipcMain.handle('file:expand', (_e, paths) => {
  const files = [];
  let skipped = 0;
  const visit = (p, top) => {
    if (files.length >= MAX_FILES) return;
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let names = [];
      try {
        names = fs.readdirSync(p);
      } catch {
        return;
      }
      for (const n of names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))) visit(path.join(p, n), false);
      return;
    }
    const kind = kindOf(p);
    if (!kind) {
      if (top) skipped++;
      return;
    }
    files.push({ file: p, name: path.basename(p), size: st.size, kind, ext: extOf(p) });
  };
  for (const p of paths) visit(p, true);
  return { files, skipped };
});

ipcMain.handle('file:probe', async (_e, file, kind) => {
  if (kind === 'doc') return { probe: null, thumb: null, kind };
  if (extOf(file) === 'svg') return { probe: { duration: 0, video: null, audio: [], subs: [] }, thumb: null, kind };
  const probe = await ff.probe(file);
  if (!probe) return { error: true };
  // Animiertes GIF: behandeln wie ein Video
  if (kind === 'image' && extOf(file) === 'gif' && probe.duration >= 0.2) kind = 'video';
  return { probe, thumb: await ff.thumbnail(file, probe), kind };
});

ipcMain.handle('shell:open-external', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});
ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));

// Fertige Datei aus der Liste herausziehen, etwa nach Discord
ipcMain.on('file:drag', (e, file) => {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 32 });
  e.sender.startDrag({ file, icon });
});

// ---------------------------------------------------------------- IPC: Aufträge
ipcMain.handle('job:run', (e, job) => convert.runJob(job, (p) => {
  if (!e.sender.isDestroyed()) e.sender.send('job:progress', { id: job.id, ...p });
}));
ipcMain.handle('job:cancel', (_e, id) => convert.cancel(id));
ipcMain.handle('job:cancel-all', () => convert.cancelAll());

// ---------------------------------------------------------------- Updates (wie bei Picline und Textline)
function isTarGz() {
  if (process.platform !== 'linux') return false;
  const exe = app.getPath('exe');
  return !exe.startsWith('/usr/') && !exe.startsWith('/opt/');
}

function setupAutoUpdate() {
  if (!app.isPackaged || selfTest) return;
  if (process.env.PORTABLE_EXECUTABLE_DIR || process.platform === 'darwin' || isTarGz()) return setupUpdateNotice();
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  let retry = null;
  autoUpdater.on('error', () => {
    clearTimeout(retry);
    retry = setTimeout(check, 10 * 60 * 1000);
  });
  const laterFile = userFile('update.json');
  let asking = false;
  autoUpdater.on('update-downloaded', async (info) => {
    const later = readJson(laterFile, {});
    if (asking || (later.version === info.version && Date.now() < later.until)) return;
    asking = true;
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: [t('restartNow'), t('later')],
      defaultId: 0,
      cancelId: 1,
      title: t('updateTitle'),
      message: t('updateReady', { version: info.version }),
      detail: t('updateDetail'),
    });
    asking = false;
    if (response === 0) {
      closingAllowed = false;
      // erst nach laufenden Umwandlungen fragen lassen, dann installieren
      win.webContents.send('app:closing', { update: true });
      ipcMain.once('app:update-ready', () => {
        closingAllowed = true;
        autoUpdater.quitAndInstall();
      });
    } else {
      writeJson(laterFile, { version: info.version, until: Date.now() + 14 * 24 * 3600 * 1000 });
    }
  });
  setTimeout(check, 5000);
  setInterval(check, 60 * 60 * 1000);
}

function setupUpdateNotice() {
  const laterFile = userFile('update.json');
  const newer = (a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
  };
  let asked = false;
  const check = async () => {
    if (asked) return;
    try {
      const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Convertline' },
      });
      if (!res.ok) return;
      const rel = await res.json();
      const version = String(rel.tag_name || '').replace(/^v/, '');
      if (!version || !newer(version, app.getVersion())) return;
      const later = readJson(laterFile, {});
      if (later.version === version && Date.now() < later.until) return;
      asked = true;
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        buttons: [t('openDownloadPage'), t('later')],
        defaultId: 0,
        cancelId: 1,
        title: t('updateTitle'),
        message: t('updateAvailable', { version }),
        detail: t('updateManualDetail'),
      });
      if (response === 0) shell.openExternal(rel.html_url || `https://github.com/${REPO}/releases/latest`);
      else writeJson(laterFile, { version, until: Date.now() + 14 * 24 * 3600 * 1000 });
    } catch {
      // offline - später nochmal
    }
  };
  setTimeout(check, 8000);
  setInterval(check, 6 * 60 * 60 * 1000);
}
ipcMain.on('app:update-ready', () => {});

// ---------------------------------------------------------------- Start
app.whenReady().then(() => {
  settings = readJson(userFile('settings.json'), {});
  buildMenu();
  createWindow();
  setupAutoUpdate();
  if (selfTest) require(path.join(__dirname, '..', 'tools', testArg === '--siteshots' ? 'siteshots.js' : 'selftest.js'))(win, selfTest);
});

app.on('before-quit', () => {
  convert.cancelAll();
  try {
    writeJson(userFile('settings.json'), settings);
  } catch {
    // egal
  }
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (!win) createWindow();
});
