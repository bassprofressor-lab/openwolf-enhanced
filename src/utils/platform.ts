import * as os from "node:os";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";

export function isWindows(): boolean {
  return os.platform() === "win32";
}

/**
 * Run an npm-installed CLI shim (pm2, and friends) with an argument ARRAY, on every platform.
 *
 * `execFileSync("pm2.cmd", [...])` cannot work on Windows any more: since the fix for
 * CVE-2024-27980 (Node 18.20.2 / 20.12.2 / 21.7.3) Node refuses to spawn a .bat or .cmd without
 * `shell: true` and throws EINVAL. Both pm2 call sites wrapped that in a bare `catch`, so on
 * Windows the daemon never started via pm2 and the user was told "pm2 found but daemon start
 * failed" — a message that reads like a pm2 problem and is not one.
 *
 * The fix is not `shell: true`: that joins the arguments back into a string and hands the project
 * path to a parser, which is the injection this codebase avoids everywhere else. Instead cmd.exe is
 * invoked with `/d /s /c` and `windowsVerbatimArguments`, so WE do the quoting and cmd strips only
 * the outer pair. Double quotes protect &, |, <, > and spaces. They do not protect `%`, which cmd
 * expands and which cannot be escaped on a command line (only inside a .bat), so a path containing
 * one is refused loudly rather than launched wrongly.
 */
export function execShim(bin: string, args: string[], opts: SpawnSyncOptions = {}): void {
  // spawnSync rather than execFileSync only because `windowsVerbatimArguments` lives on the spawn
  // options. The throw-on-failure behaviour callers rely on is reproduced below.
  const run = (cmd: string, argv: string[], o: SpawnSyncOptions): void => {
    const r = spawnSync(cmd, argv, o);
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`${bin} ${args.join(" ")} exited with ${r.status ?? "signal " + r.signal}`);
  };

  if (!isWindows()) {
    run(bin, args, opts);
    return;
  }
  const parts = [bin, ...args];
  const bad = parts.find((p) => p.includes("%") || p.includes('"'));
  if (bad !== undefined) {
    throw new Error(`Cannot pass "${bad}" through cmd.exe safely (contains % or a quote). Run the command manually.`);
  }
  const command = `"${parts.map((p) => `"${p}"`).join(" ")}"`;
  run("cmd.exe", ["/d", "/s", "/c", command], { ...opts, windowsVerbatimArguments: true });
}

export function isMac(): boolean {
  return os.platform() === "darwin";
}

export function isLinux(): boolean {
  return os.platform() === "linux";
}

export function whichCommand(): string {
  return isWindows() ? "where" : "which";
}
