'use strict';

// Nur für das unsichtbare PDF-Fenster: holt die Bytes der Datei aus dem Hauptprozess
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdfApi', { bytes: () => ipcRenderer.invoke('pdf:bytes') });
