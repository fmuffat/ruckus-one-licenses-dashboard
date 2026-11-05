'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { UserError } = require('../core/errors');

// Comptes enregistrés dans le profil utilisateur. Le secret est chiffré par le système
// (DPAPI sous Windows, Trousseau sur Mac) et n'est jamais transmis à l'interface.
class AccountStore {
  constructor(directory, safeStorage) {
    this.file = path.join(directory, 'accounts.json');
    this.safeStorage = safeStorage;
  }

  readAll() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  writeAll(accounts) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(accounts, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  listPublic() {
    return this.readAll().map(({ id, label, region, tenantId, clientId }) => ({ id, label, region, tenantId, clientId }));
  }

  async decryptSecret(encryptedSecret) {
    const { result } = await this.safeStorage.decryptStringAsync(Buffer.from(encryptedSecret, 'base64'));
    return result;
  }

  listWithSecrets() {
    return Promise.all(this.readAll().map(async ({ encryptedSecret, ...account }) => ({
      ...account,
      clientSecret: await this.decryptSecret(encryptedSecret),
    })));
  }

  async add({ label, region, tenantId, clientId, clientSecret }) {
    if (!(await this.safeStorage.isAsyncEncryptionAvailable())) {
      throw new UserError('error.encryption');
    }
    const encrypted = await this.safeStorage.encryptStringAsync(clientSecret);
    const account = {
      id: crypto.randomUUID(),
      label,
      region,
      tenantId,
      clientId,
      encryptedSecret: encrypted.toString('base64'),
    };
    this.writeAll([...this.readAll(), account]);
    return account.id;
  }

  remove(id) {
    this.writeAll(this.readAll().filter((account) => account.id !== id));
  }
}

module.exports = { AccountStore };
