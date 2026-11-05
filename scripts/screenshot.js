'use strict';

// Lance la vraie fenêtre, parcourt la démo et enregistre des captures. Profil temporaire.
// Usage : npx electron scripts/screenshot.js <dossier>

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'r1-shot-')));

const { register } = require('../src/main/ipc');
const { createWindow } = require('../src/main/window');

const outDir = process.argv[2];
const LANGUAGES = ['en', 'de', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ja', 'zh'];
const PAGES = ['home', 'msp', 'var', 'licenses', 'settings'];
const RAW_KEY = /\b(action|status|table|tile|inventory|reco|error|source|line|detail|capacity|filter|accounts|region|nav|home|item|settings|forecast)\.[a-zA-Z]+/;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  register();
  const window = createWindow({ show: true, width: 1280, height: 860 });
  const errors = [];
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning') errors.push(details.message);
  });
  await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  await wait(300);
  const js = (code) => window.webContents.executeJavaScript(code);
  // Sans cela, une fenêtre en arrière-plan renvoie parfois une image périmée.
  window.webContents.setBackgroundThrottling(false);
  const shoot = async (name) => {
    window.webContents.invalidate();
    await wait(500);
    const image = await window.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name), image.toPNG());
  };
  const setLanguage = (language) => js(`(() => { const s = document.getElementById('language'); s.value = '${language}'; s.dispatchEvent(new Event('change')); })()`);
  const openPage = async (index) => {
    await js(`document.querySelectorAll('.nav-item')[${index}].click()`);
    await wait(100);
  };

  const welcome = await js("({ nav: document.querySelectorAll('.nav-item').length, welcome: !document.getElementById('page-welcome').hidden, refresh: !document.getElementById('refresh-area').hidden, lang: document.documentElement.lang })");
  await js("document.getElementById('btn-welcome-demo').click()");
  await wait(800);

  await setLanguage('fr');
  for (const [index, page] of PAGES.entries()) {
    await openPage(index);
    await shoot(`page-${page}.png`);
  }

  // Une ligne de « À traiter » doit ouvrir la fiche du bon client.
  await openPage(0);
  const clickThrough = await js(`(async () => {
    const task = [...document.querySelectorAll('.task')].find((t) => t.querySelector('.tag'));
    const name = task.querySelector('.task-title').firstChild.textContent;
    task.click();
    await new Promise((r) => setTimeout(r, 150));
    return {
      name,
      title: document.getElementById('page-title').textContent,
      opened: document.querySelector('#rows tr.row button[aria-expanded="true"]')?.innerText.replace(/[^\\p{L} ]/gu, '').trim(),
      detail: Boolean(document.querySelector('tr.detail')),
    };
  })()`);
  await shoot('page-clic.png');

  const report = {};
  for (const language of LANGUAGES) {
    await setLanguage(language);
    let raw = null;
    let overflow = false;
    for (const index of PAGES.keys()) {
      await openPage(index);
      const text = await js('document.body.innerText');
      raw = raw || (text.match(RAW_KEY) || [null])[0];
      overflow = overflow || await js('document.getElementById("content").scrollWidth > document.getElementById("content").clientWidth');
    }
    await openPage(0);
    report[language] = {
      rawKey: raw,
      overflow,
      nav: await js("[...document.querySelectorAll('.nav-item')].map((n) => n.innerText.replace(/\\n/g, ' ')).join(' | ')"),
      firstTask: await js("document.querySelector('.task').innerText.replace(/\\n/g, ' / ')"),
    };
  }
  console.log(JSON.stringify({ welcome, clickThrough, report, errors }, null, 2));
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
