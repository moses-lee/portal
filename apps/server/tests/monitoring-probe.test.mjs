import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parsePs } from "../src/lib/process-probe.ts";
import { parseDu } from "../src/monitoring/disk.ts";
import { containerRuntimeOf, containerVmPids } from "../src/monitoring/probe/darwin.ts";
import { createProbe } from "../src/monitoring/probe/index.ts";
import {
  parseLsofCwd, parseLsofNames, parseLsofPids, parseMeminfo, parsePsi, parseSize, parseSsPids, parseSwapUsage, parseTopMemory, parseVmStat, sysctlValue,
} from "../src/monitoring/probe/parse.ts";

// darwin-* were captured on macOS 15 (Darwin 24.3) on 2026-10-21; linux-* are written by hand from the kernel's documented formats.
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "monitoring");
const fixture = (name) => readFileSync(path.join(fixtures, name), "utf8");
const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

test("sizes parse with and without units", () => {
  assert.equal(parseSize("512"), 512);
  assert.equal(parseSize("3360K"), 3360 * KiB);
  assert.equal(parseSize("2048.00M"), 2048 * MiB);
  assert.equal(parseSize("1.5G"), 1.5 * GiB);
  assert.equal(parseSize("12B"), 12);
  assert.ok(Number.isNaN(parseSize("-")));
  assert.ok(Number.isNaN(parseSize("")));
});

test("vm_stat: available is free + inactive + speculative + purgeable pages at the stated page size", () => {
  const total = 16 * GiB;
  const memory = parseVmStat(fixture("darwin-vm_stat.txt"), total);
  const available = (159771 + 305155 + 64398 + 12378) * 16384;
  assert.deepEqual(memory, { totalBytes: total, availableBytes: available, usedBytes: total - available });
  assert.equal(parseVmStat("Pages free: 10.\n", total), null, "no page size header");
  assert.equal(parseVmStat("Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\n", total), null, "a count is missing");
  const capped = parseVmStat("(page size of 4096 bytes)\nPages free: 1000000.\nPages inactive: 0.\nPages speculative: 0.\nPages purgeable: 0.\n", 1024);
  assert.deepEqual(capped, { totalBytes: 1024, availableBytes: 1024, usedBytes: 0 }, "never more available than there is");
});

test("sysctl: swap usage and the pressure level", () => {
  const swap = sysctlValue(fixture("darwin-swapusage.txt"), "vm.swapusage");
  assert.deepEqual(parseSwapUsage(swap), { totalBytes: 2048 * MiB, usedBytes: Math.round(504.81 * MiB) });
  assert.equal(sysctlValue(fixture("darwin-pressure.txt"), "kern.memorystatus_vm_pressure_level"), "1");
  const both = "vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)\nkern.memorystatus_vm_pressure_level: 4\n";
  assert.deepEqual(parseSwapUsage(sysctlValue(both, "vm.swapusage")), { totalBytes: 0, usedBytes: 0 });
  assert.equal(sysctlValue(both, "kern.memorystatus_vm_pressure_level"), "4");
  assert.equal(sysctlValue(both, "kern.missing"), null);
  assert.equal(parseSwapUsage("nonsense"), null);
});

test("top -l 1 -stats pid,mem: footprint by pid, past the header block", () => {
  const memory = parseTopMemory(fixture("darwin-top.txt"));
  assert.equal(memory.size, 26);
  assert.equal(memory.get(98785), 3360 * KiB);
  assert.equal(memory.get(0), 19 * MiB, "the kernel's row");
  assert.equal(memory.get(49846), 67 * MiB);
  assert.ok(![...memory.keys()].some((pid) => pid === 2026), "the header's date and numbers are not rows");
  const trend = parseTopMemory("PID    MEM\n81257  2433M+\n7684   1.2G-\n12     900B\nnot a row\n");
  assert.deepEqual([...trend], [[81257, 2433 * MiB], [7684, Math.round(1.2 * GiB)], [12, 900]], "trend markers and every unit");
  assert.equal(parseTopMemory("top: failure"), null, "no header");
});

test("ps with pgid and rss: the shared table read", () => {
  const table = parsePs(fixture("darwin-ps.txt"), 0);
  assert.equal(table.rows.size, 18);
  const launchd = table.rows.get(1);
  assert.deepEqual({ pid: launchd.pid, ppid: launchd.ppid, pgid: launchd.pgid, rssBytes: launchd.rssBytes, command: launchd.command }, {
    pid: 1, ppid: 0, pgid: 1, rssBytes: 18480 * KiB, command: "/sbin/launchd",
  });
  assert.equal(table.rows.get(665).command, "/usr/libexec/UserEventAgent (System)");
  assert.equal(table.rows.get(77139).ppid, 77051);
  assert.equal(table.rows.get(49846).elapsedMs, ((86400 + 10 * 3600 + 18 * 60 + 42) * 1000));
});

test("lsof -Fpn: working folders, including from a run that could not read every process", () => {
  const folders = parseLsofCwd(fixture("darwin-lsof.txt"));
  assert.equal(folders.get(2099), "/Users/moses/repos/portal/apps/web");
  assert.equal(folders.get(81257), "/");
  assert.equal(folders.size, 3, "pid 1 (root's) is missing, as lsof leaves it out");
  assert.deepEqual(parseLsofPids("p2099\ncnode\nf12\np2099\np17\n"), [2099, 17]);
  assert.deepEqual(parseLsofCwd(""), new Map());
});

test("lsof -Fpn: every name a process holds", () => {
  assert.deepEqual([...parseLsofNames("p81257\nfcwd\nn/\nftxt\nn/Users/me/.colima/_lima/colima/disk\np12\nn/dev/null\n")], [
    [81257, ["/", "/Users/me/.colima/_lima/colima/disk"]], [12, ["/dev/null"]],
  ]);
});

test("macOS: only the VM of the container runtime serving the database port is the database's", async () => {
  const vz = "/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine";
  const ps = (rows) => parsePs(rows.map(([pid, ppid, command]) => `${pid} ${ppid} ${pid} 01:00 0:01.00 1024 ${command}`).join("\n"), 0);
  // As captured with Colima on vz: the port forward is an ssh mux under launchd, the VM an XPC service under launchd.
  const table = ps([
    [1, 0, "/sbin/launchd"],
    [81246, 1, "/opt/homebrew/bin/limactl hostagent --pidfile /Users/me/.colima/_lima/colima/ha.pid"],
    [81257, 1, vz],
    [81284, 1, "ssh: /Users/me/.colima/_lima/colima/ssh.sock [mux]"],
    [90000, 1, vz],                                                         // another app's VM (UTM, a sandbox)
    [90100, 81246, "qemu-system-aarch64 -drive file=/Users/me/.colima/_lima/colima/disk"],
    [90200, 1, "/Applications/Docker.app/Contents/MacOS/com.docker.backend services"],
    [90300, 90200, "com.docker.hyperkit"],
  ]);
  assert.equal(containerRuntimeOf(table, 81284), "lima");
  assert.equal(containerRuntimeOf(table, 90100), "lima", "by an ancestor");
  assert.equal(containerRuntimeOf(table, 90300), "docker");
  assert.equal(containerRuntimeOf(table, 81257), null);

  const files = new Map([
    [81257, ["/", "/Users/me/.colima/_lima/colima/disk", "/Users/me/.colima/_lima/_disks/colima/datadisk"]],
    [90000, ["/", "/Users/me/Library/Containers/com.utmapp.UTM/Data/Documents/vm.utm/disk.img"]],
  ]);
  const asked = [];
  const openFiles = async (pids) => {
    asked.push(pids);
    return new Map(pids.map((pid) => [pid, files.get(pid) ?? []]));
  };
  assert.deepEqual((await containerVmPids(table, [81284], openFiles)).sort((a, b) => a - b), [81257, 90100]);
  assert.deepEqual(asked, [[81257, 90000]], "only the unnamed Virtualization.framework VMs have their files read");
  assert.deepEqual(await containerVmPids(table, [90200], openFiles), [90300], "Docker Desktop's listener: its VM only");
  assert.deepEqual(await containerVmPids(table, [], openFiles), [], "no listener seen: no runtime, no VM");
  assert.deepEqual(await containerVmPids(ps([[5, 1, "ssh -L 5433:db:5432 bastion"], [6, 1, vz]]), [5], openFiles), [], "a listener that is not a runtime's: no VM");
  assert.deepEqual(await containerVmPids(table, [81284], async () => { throw new Error("lsof failed"); }), [90100], "unreadable files: the unnamed VMs are not charged");
});

test("/proc/meminfo: MemAvailable, swap; older kernels fall back to free + buffers + cached", () => {
  assert.deepEqual(parseMeminfo(fixture("linux-meminfo.txt")), {
    totalBytes: 16303428 * KiB, availableBytes: 6123456 * KiB, swapTotalBytes: 2097148 * KiB, swapFreeBytes: 1048572 * KiB,
  });
  const old = "MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 200 kB\n";
  assert.deepEqual(parseMeminfo(old), { totalBytes: 1000 * KiB, availableBytes: 350 * KiB, swapTotalBytes: 0, swapFreeBytes: 0 });
  assert.equal(parseMeminfo("nothing"), null);
});

test("/proc/pressure/memory: the avg10 of some and full", () => {
  assert.deepEqual(parsePsi(fixture("linux-pressure-memory.txt")), { someAvg10: 12.5, fullAvg10: 2 });
  assert.deepEqual(parsePsi("some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"), { someAvg10: 0, fullAvg10: null });
  assert.deepEqual(parsePsi(""), { someAvg10: null, fullAvg10: null });
});

test("ss -ltnp: listener pids", () => {
  assert.deepEqual(parseSsPids(fixture("linux-ss.txt")), [2211, 2218]);
  assert.deepEqual(parseSsPids(""), []);
});

test("du -sk: kilobytes on the last line", () => {
  assert.equal(parseDu("123\t/some/folder\n"), 123 * KiB);
  assert.equal(parseDu("du: /x/locked: Permission denied\n456\t/x\n"), 456 * KiB, "a partly unreadable folder still has a total");
  assert.equal(parseDu(""), null);
});

test("the probe for this OS answers, and other OSes get none", { skip: !["darwin", "linux"].includes(process.platform) }, async () => {
  assert.equal(createProbe("win32"), null);
  assert.equal(createProbe("freebsd"), null);
  const probe = createProbe();
  assert.equal(probe.platform, process.platform);
  const system = await probe.system();
  assert.equal(system.memory.totalBytes, os.totalmem());
  assert.ok(system.memory.usedBytes > 0 && system.memory.availableBytes > 0);
  assert.ok(["normal", "warning", "critical"].includes(system.pressure.level));
  const folders = await probe.workingFolders([process.pid]);
  assert.equal(folders.get(process.pid), process.cwd());
});
