import Database from "better-sqlite3";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ADMIN_ROLE = "admin";
export const VOUCHER_ROLE = "voucher";
const PASSWORD_HASH_PREFIX = "scrypt";
const PASSWORD_HASH_BYTES = 64;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PASSWORD_STORAGE_VERSION = "scrypt-v1";

function nowIso() {
  return new Date().toISOString();
}

function storedCredential(row) {
  if (!row) return null;
  return {
    credentialId: Number(row.credential_id),
    role: row.role,
    sessionVersion: Number(row.session_version),
  };
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, PASSWORD_HASH_BYTES, SCRYPT_OPTIONS);
  return `${PASSWORD_HASH_PREFIX}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function isPasswordHash(value) {
  return typeof value === "string" && value.startsWith(`${PASSWORD_HASH_PREFIX}$`);
}

function verifyPassword(password, storedValue) {
  if (!isPasswordHash(storedValue)) return false;
  const [, saltValue, hashValue, ...extra] = storedValue.split("$");
  if (!saltValue || !hashValue || extra.length) return false;
  try {
    const expected = Buffer.from(hashValue, "base64url");
    const actual = scryptSync(password, Buffer.from(saltValue, "base64url"), expected.length, SCRYPT_OPTIONS);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function duplicatePasswordError() {
  const error = new Error("UNIQUE constraint failed: credentials.password");
  error.code = "SQLITE_CONSTRAINT_UNIQUE";
  return error;
}

export class AuthStore {
  constructor(filePath, { bootstrapPassword, bootstrapSessionSecret } = {}) {
    this.filePath = filePath;
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        credential_id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK (role IN ('admin', 'voucher')),
        password TEXT NOT NULL UNIQUE,
        query_count INTEGER NOT NULL DEFAULT 0 CHECK (query_count >= 0),
        session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_single_admin
        ON credentials(role)
        WHERE role = 'admin';

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const initialize = this.db.transaction(() => {
      const passwordStorage = this.db.prepare("SELECT value FROM settings WHERE key = 'password_storage'").get();
      if (passwordStorage?.value !== PASSWORD_STORAGE_VERSION) {
        const legacyCredentials = this.db.prepare("SELECT credential_id, password FROM credentials").all();
        const migrateCredential = this.db.prepare("UPDATE credentials SET password = ?, updated_at = ? WHERE credential_id = ?");
        for (const credential of legacyCredentials) {
          migrateCredential.run(hashPassword(credential.password), nowIso(), credential.credential_id);
        }
        this.db
          .prepare(
            "INSERT INTO settings(key, value) VALUES ('password_storage', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
          )
          .run(PASSWORD_STORAGE_VERSION);
      }

      const admin = this.db.prepare("SELECT credential_id FROM credentials WHERE role = ?").get(ADMIN_ROLE);
      if (!admin) {
        const password = String(bootstrapPassword || "");
        if (!password) throw new Error("An initial admin password is required to create auth.sqlite");
        const now = nowIso();
        this.db
          .prepare(
            `
            INSERT INTO credentials(role, password, query_count, session_version, created_at, updated_at)
            VALUES (?, ?, 0, 1, ?, ?)
            `
          )
          .run(ADMIN_ROLE, hashPassword(password), now, now);
      }

      const secret = this.db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get();
      if (!secret) {
        const value = String(bootstrapSessionSecret || "") || randomBytes(32).toString("base64url");
        this.db.prepare("INSERT INTO settings(key, value) VALUES ('session_secret', ?)").run(value);
      }
    });
    initialize();

    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // The containing volume may not support POSIX modes; SQLite access still works.
    }

    this.sessionSecret = this.db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get().value;
    this.findCredentialsByPasswordStatement = this.db.prepare(`
      SELECT credential_id, role, password, session_version
      FROM credentials
      ORDER BY credential_id ASC
    `);
    this.findByIdStatement = this.db.prepare(`
      SELECT credential_id, role, session_version
      FROM credentials
      WHERE credential_id = ?
    `);
    this.listVouchersStatement = this.db.prepare(`
      SELECT
        credential_id AS credentialId,
        query_count AS queryCount,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM credentials
      WHERE role = 'voucher'
      ORDER BY credential_id ASC
    `);
    this.createVoucherStatement = this.db.prepare(`
      INSERT INTO credentials(role, password, query_count, session_version, created_at, updated_at)
      VALUES ('voucher', ?, 0, 1, ?, ?)
    `);
    this.deleteVoucherStatement = this.db.prepare("DELETE FROM credentials WHERE credential_id = ? AND role = 'voucher'");
    this.updateAdminPasswordStatement = this.db.prepare(`
      UPDATE credentials
      SET password = ?, session_version = session_version + 1, updated_at = ?
      WHERE credential_id = ? AND role = 'admin'
    `);
    this.incrementQueryStatement = this.db.prepare(`
      UPDATE credentials
      SET query_count = query_count + 1, updated_at = ?
      WHERE credential_id = ? AND role = 'voucher'
    `);
  }

  findByPassword(password) {
    for (const row of this.findCredentialsByPasswordStatement.all()) {
      if (verifyPassword(password, row.password)) return storedCredential(row);
    }
    return null;
  }

  findById(credentialId) {
    return storedCredential(this.findByIdStatement.get(credentialId));
  }

  listVouchers() {
    return this.listVouchersStatement.all();
  }

  createVoucher(password) {
    if (this.findByPassword(password)) throw duplicatePasswordError();
    const now = nowIso();
    const result = this.createVoucherStatement.run(hashPassword(password), now, now);
    return Number(result.lastInsertRowid);
  }

  deleteVoucher(credentialId) {
    return this.deleteVoucherStatement.run(credentialId).changes > 0;
  }

  updateAdminPassword(credentialId, currentPassword, newPassword) {
    const current = this.findById(credentialId);
    if (!current || current.role !== ADMIN_ROLE) return false;
    const verified = this.findByPassword(currentPassword);
    if (!verified || verified.credentialId !== current.credentialId) return false;
    const duplicate = this.findByPassword(newPassword);
    if (duplicate && duplicate.credentialId !== current.credentialId) throw duplicatePasswordError();
    return this.updateAdminPasswordStatement.run(hashPassword(newPassword), nowIso(), credentialId).changes > 0;
  }

  incrementQueryCount(credentialId) {
    return this.incrementQueryStatement.run(nowIso(), credentialId).changes > 0;
  }

  close() {
    this.db.close();
  }
}

export function openAuthStore(dbDir, options = {}) {
  return new AuthStore(path.join(dbDir, "auth.sqlite"), options);
}
