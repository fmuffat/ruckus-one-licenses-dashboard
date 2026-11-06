'use strict';

const REPOSITORY = 'fmuffat/ruckus-one-licenses-dashboard';
const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`;
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases/`;
const TIMEOUT_MS = 10000;

function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(text ?? ''));
  if (!match) return null;
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] || null };
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] - b.numbers[i];
  }
  // 1.0.0-beta précède 1.0.0.
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  return (a.prerelease || '').localeCompare(b.prerelease || '', 'en', { numeric: true });
}

// Le fichier qui remplace celui que l'utilisateur a déjà : portable, installateur, ou Mac de la bonne puce.
function installerPattern({ platform, arch, portable }) {
  if (platform === 'win32') return portable ? /-portable\.exe$/ : /-Setup-[^/]*\.exe$/;
  if (platform === 'darwin') return arch === 'arm64' ? /-arm64\.dmg$/ : /-x64\.dmg$/;
  return null;
}

function downloadUrl(release, target) {
  const pattern = installerPattern(target);
  const asset = pattern && (release.assets || []).find((candidate) => pattern.test(candidate.name || ''));
  return asset?.browser_download_url || release.html_url;
}

// Toutes les versions publiées comptent, y compris les pré-versions : les tests passent par elles.
function findUpdate(releases, currentVersion, target) {
  const current = parseVersion(currentVersion);
  if (!current || !Array.isArray(releases)) return null;
  const newest = releases
    .filter((release) => !release.draft)
    .map((release) => ({ release, parsed: parseVersion(release.tag_name) }))
    .filter(({ parsed }) => parsed && compareVersions(parsed, current) > 0)
    .sort((a, b) => compareVersions(b.parsed, a.parsed))[0];
  if (!newest) return null;
  const url = downloadUrl(newest.release, target);
  // L'adresse sera ouverte sur le poste : uniquement les versions de ce dépôt.
  if (typeof url !== 'string' || !url.startsWith(RELEASES_URL)) return null;
  return { version: newest.release.tag_name.replace(/^v/, ''), url };
}

// Hors ligne, proxy, quota GitHub : pas de bandeau, et jamais d'erreur pour une simple vérification.
async function checkForUpdate({ fetchImpl, currentVersion, target }) {
  try {
    const response = await fetchImpl(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `RUCKUS-One-Licenses-Dashboard/${currentVersion}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return findUpdate(await response.json(), currentVersion, target);
  } catch {
    return null;
  }
}

module.exports = { checkForUpdate, compareVersions, findUpdate, parseVersion };
