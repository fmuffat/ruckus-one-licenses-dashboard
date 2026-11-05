'use strict';

// Produit les captures de la documentation, à partir du mode démo (clients fictifs uniquement).
// Usage : npx electron scripts/doc-screenshots.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'r1-licenses-doc-')));

const { register } = require('../src/main/ipc');
const { createWindow } = require('../src/main/window');

const OUTPUT = path.join(__dirname, '..', 'docs', 'screenshots');
const PAGES = ['to-do', 'msp-customers', 'var-customers', 'license-pool', 'settings'];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  register();
  const window = createWindow({ show: true, width: 1280, height: 860 });
  await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  await wait(300);
  // Sans cela, une fenêtre en arrière-plan renvoie parfois une image périmée.
  window.webContents.setBackgroundThrottling(false);
  const js = (code) => window.webContents.executeJavaScript(code);
  const shoot = async (file) => {
    window.webContents.invalidate();
    await wait(700);
    const image = await window.webContents.capturePage();
    fs.writeFileSync(file, image.toPNG());
  };

  await js("document.getElementById('btn-welcome-demo').click()");
  await wait(800);

  for (const language of ['en', 'fr']) {
    const directory = path.join(OUTPUT, language);
    fs.mkdirSync(directory, { recursive: true });
    await js(`(() => { const s = document.getElementById('language'); s.value = '${language}'; s.dispatchEvent(new Event('change')); })()`);
    for (const [index, page] of PAGES.entries()) {
      await js(`document.querySelectorAll('.nav-item')[${index}].click()`);
      await wait(100);
      await shoot(path.join(directory, `${page}.png`));
    }
    // Fiche d'un client ouverte : le détail et les recommandations.
    await js("document.querySelectorAll('.nav-item')[1].click()");
    await wait(100);
    await js("document.querySelector('#rows tr.row').click()");
    await shoot(path.join(directory, 'customer-details.png'));
    await js("document.querySelector('#rows tr.row').click()");
  }
  console.log(`Captures enregistrées dans ${OUTPUT}`);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
