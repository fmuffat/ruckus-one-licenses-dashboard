'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateUserData } = require('../src/main/migrateUserData');

const CURRENT = 'RUCKUS One Licenses Dashboard';

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'r1-migrate-'));
}

for (const previousName of ['DogTag', 'R1 Licences']) {
  test(`reprend tout le dossier ${previousName} : comptes et clé de chiffrement`, () => {
    const root = sandbox();
    const previous = path.join(root, previousName);
    fs.mkdirSync(previous);
    fs.writeFileSync(path.join(previous, 'accounts.json'), 'comptes');
    fs.writeFileSync(path.join(previous, 'Local State'), 'cle');
    assert.equal(migrateUserData(root, CURRENT), true);
    assert.equal(fs.readFileSync(path.join(root, CURRENT, 'accounts.json'), 'utf8'), 'comptes');
    assert.equal(fs.readFileSync(path.join(root, CURRENT, 'Local State'), 'utf8'), 'cle');
    assert.equal(fs.existsSync(previous), false);
  });
}

test('deux anciens dossiers : reprend le plus récent', () => {
  const root = sandbox();
  fs.mkdirSync(path.join(root, 'R1 Licences'));
  fs.mkdirSync(path.join(root, 'DogTag'));
  fs.writeFileSync(path.join(root, 'DogTag', 'accounts.json'), 'recent');
  assert.equal(migrateUserData(root, CURRENT), true);
  assert.equal(fs.readFileSync(path.join(root, CURRENT, 'accounts.json'), 'utf8'), 'recent');
  assert.equal(fs.existsSync(path.join(root, 'R1 Licences')), true);
});

test('n\'écrase jamais un dossier existant', () => {
  const root = sandbox();
  fs.mkdirSync(path.join(root, 'DogTag'));
  fs.mkdirSync(path.join(root, CURRENT));
  fs.writeFileSync(path.join(root, CURRENT, 'accounts.json'), 'recent');
  assert.equal(migrateUserData(root, CURRENT), false);
  assert.equal(fs.readFileSync(path.join(root, CURRENT, 'accounts.json'), 'utf8'), 'recent');
  assert.equal(fs.existsSync(path.join(root, 'DogTag')), true);
});

test('première installation : rien à reprendre, aucune erreur', () => {
  assert.equal(migrateUserData(sandbox(), CURRENT), false);
});
