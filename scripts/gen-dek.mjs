#!/usr/bin/env node
/**
 * Generate a fresh 256-bit data-encryption key (DEK) for credential encryption
 * (research §6b) and print setup instructions.
 *
 * Usage:  node scripts/gen-dek.mjs
 *
 * Prints the key-file JSON to stdout — redirect it into the DEK file yourself
 * so the key never lands in shell history:
 *
 *   node scripts/gen-dek.mjs   # copy the JSON block it prints
 *
 * The key is for the operator's eyes only: it is never written to the repo by
 * this script.
 */
import { randomBytes } from "node:crypto";

const KEY_ID = "k1";
const keyB64 = randomBytes(32).toString("base64");
const doc = { activeKeyId: KEY_ID, keys: { [KEY_ID]: keyB64 } };
const docJson = JSON.stringify(doc, null, 2);

console.log("# Fresh 256-bit DEK for credential encryption (AES-256-GCM)");
console.log("# Key-file JSON — save this EXACTLY as shown to the DEK_FILE path:\n");
console.log(docJson);
console.log(`
SETUP (run on the VPS as a privileged user; the app itself runs as the service user):

  1. Save the JSON above to a file OUTSIDE the repo, e.g. /opt/pwrcell/data/dek.key.
     Do NOT commit it to git. Do NOT put it in the repo working tree.

  2. Lock it down — owned by the service user, nobody else may read it:
       install -o <service-user> -g <service-user> -m 600 /dev/null /opt/pwrcell/data/dek.key
       # then paste the JSON block above into /opt/pwrcell/data/dek.key
       chmod 600 /opt/pwrcell/data/dek.key

  3. Point the app at it (systemd unit Environment= or dashboard.env):
       DEK_FILE=/opt/pwrcell/data/dek.key
     If DEK_FILE is unset, the app auto-generates a key at ./data/dek.key with a
     loud startup warning — fine for dev, never rely on it in production.

  4. Back the key up SEPARATELY from database backups, encrypted with the
     existing backup passphrase (alongside the Drive backups).

  5. Key loss = encrypted credentials are UNRECOVERABLE: PWRview logins must be
     re-entered. There is no recovery path — that is
     deliberate (bounded and honest, never silent corruption).

  6. Rotation: run this script again, add the new key under a new id ("k2"),
     set "activeKeyId" to it, re-encrypt existing credential rows, then retire
     the old key once no rows reference its keyId.
`);
