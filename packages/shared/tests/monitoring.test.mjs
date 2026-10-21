import assert from "node:assert/strict";
import test from "node:test";
import { BYTES_PER_GB, darwinPressureLevel, diskLevel, expandHome, formatBytes, linuxPressureLevel } from "../src/monitoring.ts";

const GB = BYTES_PER_GB;

test("macOS pressure: 1 normal, 2 warning, 4 critical, anything else normal", () => {
  assert.equal(darwinPressureLevel(1), "normal");
  assert.equal(darwinPressureLevel(2), "warning");
  assert.equal(darwinPressureLevel(4), "critical");
  for (const other of [0, 3, NaN, -1]) assert.equal(darwinPressureLevel(other), "normal", String(other));
});

test("Linux pressure from PSI and available memory", () => {
  const total = 16 * GB;
  const plenty = { availableBytes: 8 * GB, totalBytes: total };
  assert.equal(linuxPressureLevel({ someAvg10: 0, fullAvg10: 0, ...plenty }), "normal");
  assert.equal(linuxPressureLevel({ someAvg10: 9.99, fullAvg10: 9.99, ...plenty }), "normal");
  assert.equal(linuxPressureLevel({ someAvg10: 10, fullAvg10: 0, ...plenty }), "warning", "some avg10 at 10");
  assert.equal(linuxPressureLevel({ someAvg10: 40, fullAvg10: 10, ...plenty }), "critical", "full avg10 at 10");
  assert.equal(linuxPressureLevel({ someAvg10: 0, fullAvg10: 0, availableBytes: total * 0.09, totalBytes: total }), "warning", "under 10 % available");
  assert.equal(linuxPressureLevel({ someAvg10: 0, fullAvg10: 0, availableBytes: total * 0.04, totalBytes: total }), "critical", "under 5 % available");
  assert.equal(linuxPressureLevel({ someAvg10: 0, fullAvg10: 0, availableBytes: total * 0.1, totalBytes: total }), "normal", "exactly 10 % is not under it");
  assert.equal(linuxPressureLevel({ someAvg10: null, fullAvg10: null, ...plenty }), "normal", "a kernel without PSI");
  assert.equal(linuxPressureLevel({ someAvg10: null, fullAvg10: null, availableBytes: 0, totalBytes: 0 }), "normal", "no total reads as plenty");
});

test("disk level from free bytes and the configured levels", () => {
  const levels = { warnFreeGb: 30, criticalFreeGb: 15 };
  assert.equal(diskLevel(100 * GB, levels), "normal");
  assert.equal(diskLevel(30 * GB, levels), "normal", "exactly at the warning level is not below it");
  assert.equal(diskLevel(30 * GB - 1, levels), "warning");
  assert.equal(diskLevel(15 * GB, levels), "warning");
  assert.equal(diskLevel(15 * GB - 1, levels), "critical");
  assert.equal(diskLevel(0, levels), "critical");
  assert.equal(diskLevel(40 * GB, { warnFreeGb: 50, criticalFreeGb: 20 }), "warning");
});

test("expandHome expands ~ and ~/ only", () => {
  assert.equal(expandHome("~", "/Users/me"), "/Users/me");
  assert.equal(expandHome("~/.codex", "/Users/me"), "/Users/me/.codex");
  assert.equal(expandHome("~/.codex", "/Users/me/"), "/Users/me/.codex");
  assert.equal(expandHome("/abs/~/x", "/Users/me"), "/abs/~/x");
  assert.equal(expandHome("~other", "/Users/me"), "~other");
});

test("sizes read as Activity Monitor (memory, binary) and Finder (disk, decimal) count them", () => {
  const GiB = 1024 ** 3;
  const MiB = 1024 ** 2;
  assert.equal(formatBytes(16 * GiB, "memory"), "16 GB");
  assert.equal(formatBytes(350 * MiB, "memory"), "350 MB");
  assert.equal(formatBytes(9.84 * GiB, "memory"), "9.8 GB");
  assert.equal(formatBytes(11.3 * GiB, "memory"), "11 GB");
  assert.equal(formatBytes(4 * GiB, "memory"), "4 GB");
  assert.equal(formatBytes(22e9), "22 GB");
  assert.equal(formatBytes(460e9, "disk"), "460 GB");
  assert.equal(formatBytes(60e6, "disk"), "60 MB");
  assert.equal(formatBytes(1.5e12), "1.5 TB");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(-5), "0 B");
  assert.equal(formatBytes(null), "—");
  assert.equal(formatBytes(undefined), "—");
  assert.equal(formatBytes(Number.NaN), "—");
});
