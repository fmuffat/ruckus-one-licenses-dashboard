'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Du plus récent au plus ancien.
const PREVIOUS_NAMES = ['DogTag', 'R1 Licences'];

// L'application a changé de nom : son dossier contient les comptes et la clé qui déchiffre
// leurs secrets. On le renomme d'un bloc, avant le démarrage d'Electron, pour garder les deux.
function migrateUserData(appDataDirectory, currentName) {
  const current = path.join(appDataDirectory, currentName);
  const previous = PREVIOUS_NAMES
    .map((name) => path.join(appDataDirectory, name))
    .find((directory) => fs.existsSync(directory));
  if (!previous || fs.existsSync(current)) return false;
  try {
    fs.renameSync(previous, current);
    return true;
  } catch {
    // Dossier verrouillé (ancienne version encore ouverte) : on démarre sans reprise,
    // sans jamais écraser quoi que ce soit.
    return false;
  }
}

module.exports = { migrateUserData };
