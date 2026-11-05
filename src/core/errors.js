'use strict';

// Erreur destinée à l'utilisateur : elle porte une clé de traduction plutôt qu'un texte.
class UserError extends Error {
  constructor(key, params = {}, status = undefined) {
    super(key);
    this.key = key;
    this.params = params;
    this.status = status;
  }

  toMessage() {
    return { key: this.key, params: this.params };
  }
}

module.exports = { UserError };
