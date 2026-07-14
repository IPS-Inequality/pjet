import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { ADMIN_ROLE, VOUCHER_ROLE, openAuthStore } from "./auth-store.js";

test("auth store seeds once and manages revocable vouchers", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pjet-auth-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = openAuthStore(directory, {
    bootstrapPassword: "initial-admin",
    bootstrapSessionSecret: "fixed-test-secret",
  });
  assert.equal(store.sessionSecret, "fixed-test-secret");

  const initialAdmin = store.findByPassword("initial-admin");
  assert.equal(initialAdmin.role, ADMIN_ROLE);
  assert.equal(initialAdmin.sessionVersion, 1);
  const authDb = new Database(path.join(directory, "auth.sqlite"), { readonly: true });
  assert.doesNotMatch(authDb.prepare("SELECT password FROM credentials WHERE role = 'admin'").get().password, /initial-admin/);
  authDb.close();

  const voucherId = store.createVoucher("press-voucher");
  const voucher = store.findByPassword("press-voucher");
  assert.equal(voucher.credentialId, voucherId);
  assert.equal(voucher.role, VOUCHER_ROLE);
  assert.equal(store.incrementQueryCount(voucherId), true);
  assert.equal(store.incrementQueryCount(voucherId), true);
  assert.equal(store.listVouchers()[0].queryCount, 2);
  assert.equal("password" in store.listVouchers()[0], false);

  assert.throws(() => store.createVoucher("press-voucher"), /UNIQUE constraint failed/);
  assert.equal(store.deleteVoucher(voucherId), true);
  assert.equal(store.findById(voucherId), null);
  assert.equal(store.deleteVoucher(voucherId), false);

  assert.equal(store.updateAdminPassword(initialAdmin.credentialId, "wrong-admin", "updated-admin"), false);
  assert.equal(store.findByPassword("initial-admin").sessionVersion, initialAdmin.sessionVersion);
  assert.equal(store.updateAdminPassword(initialAdmin.credentialId, "initial-admin", "updated-admin"), true);
  assert.equal(store.findByPassword("initial-admin"), null);
  const updatedAdmin = store.findByPassword("updated-admin");
  assert.equal(updatedAdmin.credentialId, initialAdmin.credentialId);
  assert.equal(updatedAdmin.sessionVersion, initialAdmin.sessionVersion + 1);
  store.close();

  store = openAuthStore(directory, {
    bootstrapPassword: "ignored-bootstrap-password",
    bootstrapSessionSecret: "ignored-bootstrap-secret",
  });
  assert.equal(store.findByPassword("ignored-bootstrap-password"), null);
  assert.equal(store.findByPassword("updated-admin").role, ADMIN_ROLE);
  assert.equal(store.sessionSecret, "fixed-test-secret");
  store.close();
});

test("auth store migrates a legacy plaintext credential on open", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pjet-auth-migration-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = openAuthStore(directory, {
    bootstrapPassword: "legacy-admin",
    bootstrapSessionSecret: "fixed-test-secret",
  });
  store.db.prepare("UPDATE credentials SET password = ? WHERE role = 'admin'").run("legacy-admin");
  store.db.prepare("DELETE FROM settings WHERE key = 'password_storage'").run();
  store.close();

  store = openAuthStore(directory);
  assert.equal(store.findByPassword("legacy-admin").role, ADMIN_ROLE);
  const authDb = new Database(path.join(directory, "auth.sqlite"), { readonly: true });
  assert.doesNotMatch(authDb.prepare("SELECT password FROM credentials WHERE role = 'admin'").get().password, /legacy-admin/);
  authDb.close();
  store.close();
});
