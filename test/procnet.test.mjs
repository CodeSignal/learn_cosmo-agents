import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listeningInodes, listeningSockets, pidsForInodes, descendsFrom } from "../root/procnet.mjs";

const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 4242 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 5151 1 0000000000000000 100 0 0 10 0
   2: 0100007F:0BB8 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000  1001        0 6161 1 0000000000000000 100 0 0 10 0`;

test("finds LISTEN sockets on a port, ignoring other ports and established connections", () => {
  assert.deepEqual([...listeningInodes([TCP], 3000)], ["4242"]);
  assert.deepEqual([...listeningInodes([TCP], 4096)], ["5151"]);
  assert.equal(listeningInodes([TCP], 5000).size, 0);
});

test("reports each listener's uid, which is all root can see without CAP_SYS_PTRACE", () => {
  assert.deepEqual(listeningSockets([TCP], 3000), [{ inode: "4242", uid: 1001 }]);
});

function fakeProc() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proc-"));
  const proc = (pid, ppid, sockets) => {
    fs.mkdirSync(path.join(root, String(pid), "fd"), { recursive: true });
    fs.writeFileSync(path.join(root, String(pid), "stat"), `${pid} (node server (x)) S ${ppid} 1 1 0`);
    sockets.forEach((inode, i) => fs.symlinkSync(`socket:[${inode}]`, path.join(root, String(pid), "fd", String(i + 3))));
  };
  proc(100, 1, []); // supervised child
  proc(101, 100, ["4242"]); // its worker holding the port
  proc(200, 1, ["5151"]); // an impostor
  return root;
}

test("maps socket inodes to pids and tells descendants from impostors", () => {
  const root = fakeProc();
  assert.deepEqual([...pidsForInodes(new Set(["4242"]), root)], [101]);
  assert.equal(descendsFrom(101, 100, root), true);
  assert.equal(descendsFrom(200, 100, root), false);
  fs.rmSync(root, { recursive: true, force: true });
});
