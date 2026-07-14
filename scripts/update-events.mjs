#!/usr/bin/env node

import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), "..");

const DEFAULT_DB_DIR = "/var/lib/pjet";
const DEFAULT_CACHE_DIR = "/var/cache/pjet/adsbx";
const DEFAULT_BUILDER = path.join(ROOT_DIR, "rust", "pjet", "target", "release", "pjet");
const SLOT_SECONDS = 30 * 60;
const DEFAULT_MAX_SLOTS_PER_BATCH = 48;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function environment(name, fallback = "") {
  return process.env[name] || fallback;
}

function parseArgs(argv) {
  const args = {
    dbDir: environment("PJET_DB_DIR", DEFAULT_DB_DIR),
    cacheDir: environment("PJET_UPDATE_CACHE_DIR", DEFAULT_CACHE_DIR),
    builder: environment("PJET_BUILDER", DEFAULT_BUILDER),
    lockPath: environment("PJET_UPDATE_LOCK") || null,
    statusPath: environment("PJET_UPDATE_STATUS") || null,
    maxSlotsPerBatch: Number(environment("PJET_UPDATE_BATCH_SLOTS", DEFAULT_MAX_SLOTS_PER_BATCH)),
    commitEvery: Number(environment("PJET_UPDATE_COMMIT_EVERY", 50)),
    progressEvery: Number(environment("PJET_UPDATE_PROGRESS_EVERY", 25)),
    keepCache: ["1", "true", "yes", "on"].includes(
      String(environment("PJET_UPDATE_KEEP_CACHE")).trim().toLowerCase()
    ),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--db-dir") args.dbDir = argv[++index];
    else if (value === "--cache-dir") args.cacheDir = argv[++index];
    else if (value === "--builder") args.builder = argv[++index];
    else if (value === "--lock") args.lockPath = argv[++index];
    else if (value === "--status") args.statusPath = argv[++index];
    else if (value === "--batch-slots") args.maxSlotsPerBatch = Number(argv[++index]);
    else if (value === "--commit-every") args.commitEvery = Number(argv[++index]);
    else if (value === "--progress-every") args.progressEvery = Number(argv[++index]);
    else if (value === "--keep-cache") args.keepCache = true;
  }
  args.lockPath ||= path.join(args.dbDir, "update.lock");
  args.statusPath ||= path.join(args.dbDir, "update-status.json");
  if (!Number.isInteger(args.maxSlotsPerBatch) || args.maxSlotsPerBatch <= 0) {
    throw new Error("--batch-slots must be a positive integer");
  }
  return args;
}

function isoForSlot(slotTs) {
  return new Date(slotTs * 1000).toISOString().replace(".000Z", "Z");
}

function slotParts(slotTs) {
  const value = new Date(slotTs * 1000);
  const slot = value.getUTCHours() * 2 + Math.floor(value.getUTCMinutes() / 30);
  return {
    year: String(value.getUTCFullYear()).padStart(4, "0"),
    month: String(value.getUTCMonth() + 1).padStart(2, "0"),
    day: String(value.getUTCDate()).padStart(2, "0"),
    slot: String(slot).padStart(2, "0"),
  };
}

function pathForSlot(cacheDir, slotTs) {
  const parts = slotParts(slotTs);
  return path.join(cacheDir, parts.year, parts.month, parts.day, `${parts.slot}.bin.ttf`);
}

function urlForSlot(slotTs) {
  const parts = slotParts(slotTs);
  return `https://globe.adsbexchange.com/globe_history/${parts.year}/${parts.month}/${parts.day}/heatmap/${parts.slot}.bin.ttf`;
}

function latestCompletedSlot(now = Date.now()) {
  return Math.floor((Math.floor(now / 1000) - SLOT_SECONDS) / SLOT_SECONDS) * SLOT_SECONDS;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeJsonAtomic(filename, payload) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const tmp = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmp, filename);
}

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    return null;
  }
}

function acquireLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
  };
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    fs.closeSync(fd);
    return { acquired: true, payload };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = readJson(lockPath);
    if (existing && processExists(Number(existing.pid))) {
      return { acquired: false, payload: existing };
    }
    fs.unlinkSync(lockPath);
    return acquireLock(lockPath);
  }
}

function cleanupLock(lockPath) {
  try {
    const existing = readJson(lockPath);
    if (!existing || Number(existing.pid) === process.pid) fs.unlinkSync(lockPath);
  } catch {}
}

function getProcessedState(dbDir) {
  const db = new Database(path.join(dbDir, "build_state.sqlite"), { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `
        SELECT
          COUNT(*) AS processedCount,
          MAX(slot_ts) AS maxSlotTs,
          MAX(path) AS maxPath
        FROM processed_files
        `
      )
      .get();
  } finally {
    db.close();
  }
}

function checkpointDatabase(filename) {
  if (!fs.existsSync(filename)) return null;
  const db = new Database(filename);
  try {
    return db.pragma("wal_checkpoint(TRUNCATE)", { simple: false });
  } finally {
    db.close();
  }
}

function checkpointDatabases(dbDir) {
  return {
    events: checkpointDatabase(path.join(dbDir, "events.sqlite")),
    buildState: checkpointDatabase(path.join(dbDir, "build_state.sqlite")),
  };
}

function ensureRequiredFiles(args) {
  for (const name of ["events.sqlite", "airports.sqlite", "aircraft.sqlite", "build_state.sqlite"]) {
    const filename = path.join(args.dbDir, name);
    if (!fs.existsSync(filename)) throw new Error(`Missing required database file: ${filename}`);
  }
  if (!fs.existsSync(args.builder)) throw new Error(`Missing Rust builder binary: ${args.builder}`);
}

function downloadToFile(url, destination) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const part = `${destination}.part`;
    const request = https.get(url, { headers: { "User-Agent": USER_AGENT }, timeout: 180_000 }, (response) => {
      if (response.statusCode === 404) {
        response.resume();
        resolve({ status: "not_found", bytes: 0 });
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      const output = fs.createWriteStream(part);
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
      });
      response.pipe(output);
      output.on("finish", () => {
        output.close(() => {
          if (bytes <= 0) {
            fs.rmSync(part, { force: true });
            reject(new Error(`Downloaded empty file from ${url}`));
            return;
          }
          fs.renameSync(part, destination);
          resolve({ status: "downloaded", bytes });
        });
      });
      output.on("error", reject);
    });
    request.on("timeout", () => {
      request.destroy(new Error(`Timed out downloading ${url}`));
    });
    request.on("error", (error) => {
      fs.rmSync(part, { force: true });
      reject(error);
    });
  });
}

async function downloadSlot(cacheDir, slotTs) {
  const destination = pathForSlot(cacheDir, slotTs);
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) {
    return { status: "cached", bytes: fs.statSync(destination).size, path: destination, url: urlForSlot(slotTs), slotTs };
  }
  const url = urlForSlot(slotTs);
  const result = await downloadToFile(url, destination);
  return { ...result, path: destination, url, slotTs };
}

function removeEmptyParents(filename, stopDir) {
  let current = path.dirname(filename);
  const stop = path.resolve(stopDir);
  while (path.resolve(current).startsWith(stop) && path.resolve(current) !== stop) {
    try {
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function cleanupDownloadedFiles(files, cacheDir) {
  for (const file of files) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.part`, { force: true });
    removeEmptyParents(file, cacheDir);
  }
}

function runBuilder(args, startSlot, lastSlot) {
  const started = performance.now();
  const command = [
    "build-events",
    "--cache-dir",
    args.cacheDir,
    "--events-db",
    path.join(args.dbDir, "events.sqlite"),
    "--airports-db",
    path.join(args.dbDir, "airports.sqlite"),
    "--aircraft-db",
    path.join(args.dbDir, "aircraft.sqlite"),
    "--state-db",
    path.join(args.dbDir, "build_state.sqlite"),
    "--start",
    isoForSlot(startSlot),
    "--end",
    isoForSlot(lastSlot + SLOT_SECONDS),
    "--commit-every",
    String(args.commitEvery),
    "--progress-every",
    String(args.progressEvery),
  ];
  const result = spawnSync(args.builder, command, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const elapsedSeconds = (performance.now() - started) / 1000;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(detail || `Builder exited with status ${result.status}`);
  }
  let details = null;
  try {
    details = JSON.parse(result.stdout);
  } catch {}
  return {
    elapsedSeconds,
    details,
    stderrTail: String(result.stderr || "").split("\n").slice(-20).join("\n").trim(),
  };
}

function baseStatus(args, startedAt) {
  return {
    running: true,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt,
    dbDir: args.dbDir,
    cacheDir: args.cacheDir,
    builder: args.builder,
    maxSlotsPerBatch: args.maxSlotsPerBatch,
    keepCache: args.keepCache,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lock = acquireLock(args.lockPath);
  if (!lock.acquired) {
    const status = {
      running: true,
      skipped: true,
      reason: "update_already_running",
      existingLock: lock.payload,
      checkedAt: new Date().toISOString(),
    };
    writeJsonAtomic(args.statusPath, status);
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }

  const startedAt = new Date().toISOString();
  const summary = {
    batches: [],
    downloadedFiles: 0,
    downloadedBytes: 0,
    insertedEvents: 0,
    processedFiles: 0,
    unavailableSlots: 0,
  };

  try {
    ensureRequiredFiles(args);
    fs.mkdirSync(args.cacheDir, { recursive: true });
    let state = getProcessedState(args.dbDir);
    const targetSlot = latestCompletedSlot();
    writeJsonAtomic(args.statusPath, {
      ...baseStatus(args, startedAt),
      phase: "planning",
      processed: state,
      targetSlot,
      targetSlotTime: isoForSlot(targetSlot),
      summary,
    });

    if (!Number.isFinite(Number(state.maxSlotTs))) {
      throw new Error("build_state.sqlite has no processed_files max slot");
    }

    let nextSlot = Number(state.maxSlotTs) + SLOT_SECONDS;
    while (nextSlot <= targetSlot) {
      const batchStart = nextSlot;
      const batchEnd = Math.min(targetSlot, batchStart + SLOT_SECONDS * (args.maxSlotsPerBatch - 1));
      const downloaded = [];
      const cleanupAfterBuild = [];
      const batch = {
        startSlot: batchStart,
        startSlotTime: isoForSlot(batchStart),
        targetEndSlot: batchEnd,
        targetEndSlotTime: isoForSlot(batchEnd),
        files: 0,
        bytes: 0,
        unavailable: 0,
      };
      writeJsonAtomic(args.statusPath, {
        ...baseStatus(args, startedAt),
        phase: "downloading",
        currentBatch: batch,
        processed: state,
        targetSlot,
        targetSlotTime: isoForSlot(targetSlot),
        summary,
      });

      for (let slot = batchStart; slot <= batchEnd; slot += SLOT_SECONDS) {
        const result = await downloadSlot(args.cacheDir, slot);
        if (result.status === "not_found") {
          batch.unavailable += 1;
          summary.unavailableSlots += 1;
          break;
        }
        downloaded.push(result.path);
        if (!args.keepCache && result.status === "downloaded") cleanupAfterBuild.push(result.path);
        batch.files += 1;
        batch.bytes += result.bytes;
        summary.downloadedFiles += result.status === "downloaded" ? 1 : 0;
        summary.downloadedBytes += result.status === "downloaded" ? result.bytes : 0;
      }

      if (downloaded.length === 0) {
        summary.batches.push(batch);
        break;
      }

      const actualEndSlot = batchStart + SLOT_SECONDS * (downloaded.length - 1);
      writeJsonAtomic(args.statusPath, {
        ...baseStatus(args, startedAt),
        phase: "building",
        currentBatch: { ...batch, actualEndSlot, actualEndSlotTime: isoForSlot(actualEndSlot) },
        processed: state,
        targetSlot,
        targetSlotTime: isoForSlot(targetSlot),
        summary,
      });

      try {
        const build = runBuilder(args, batchStart, actualEndSlot);
        batch.build = build;
        summary.insertedEvents += Number(build.details?.inserted_events || 0);
        summary.processedFiles += Number(build.details?.files_processed || 0);
        batch.checkpoint = checkpointDatabases(args.dbDir);
      } finally {
        cleanupDownloadedFiles(cleanupAfterBuild, args.cacheDir);
      }

      summary.batches.push(batch);
      state = getProcessedState(args.dbDir);
      nextSlot = Number(state.maxSlotTs) + SLOT_SECONDS;
      if (batch.unavailable > 0) break;
    }

    const finishedAt = new Date().toISOString();
    const finalStatus = {
      ...baseStatus(args, startedAt),
      running: false,
      ok: true,
      phase: "complete",
      finishedAt,
      elapsedSeconds: (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000,
      processed: getProcessedState(args.dbDir),
      targetSlot,
      targetSlotTime: isoForSlot(targetSlot),
      summary,
    };
    writeJsonAtomic(args.statusPath, finalStatus);
    console.log(JSON.stringify(finalStatus, null, 2));
    return 0;
  } catch (error) {
    const failedAt = new Date().toISOString();
    const status = {
      ...baseStatus(args, startedAt),
      running: false,
      ok: false,
      phase: "failed",
      failedAt,
      elapsedSeconds: (Date.parse(failedAt) - Date.parse(startedAt)) / 1000,
      error: error?.stack || error?.message || String(error),
      summary,
    };
    writeJsonAtomic(args.statusPath, status);
    console.error(JSON.stringify(status, null, 2));
    return 1;
  } finally {
    cleanupLock(args.lockPath);
  }
}

process.exitCode = await main();
