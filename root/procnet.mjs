// Who is listening on a TCP port, from /proc. The socket tables give each listener's inode and
// uid; mapping an inode to a pid means reading /proc/<pid>/fd, which in a container without
// CAP_SYS_PTRACE only works for processes of the reader's own uid (see find-owners.mjs).
import fs from "node:fs";

/** LISTEN sockets on `port` as {inode, uid}, from /proc/net/tcp{,6} text. */
export function listeningSockets(tables, port) {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const found = new Map();
  for (const text of tables) {
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      if (cols[3] === "0A" && cols[1].endsWith(`:${hex}`)) found.set(cols[9], Number(cols[7]));
    }
  }
  return [...found].map(([inode, uid]) => ({ inode, uid }));
}

/** Socket inodes in LISTEN state on `port`. */
export function listeningInodes(tables, port) {
  return new Set(listeningSockets(tables, port).map((s) => s.inode));
}

/** PIDs holding any of the socket inodes open. */
export function pidsForInodes(inodes, procRoot = "/proc") {
  const pids = new Set();
  if (!inodes.size) return pids;
  for (const entry of fs.readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    let fds;
    try {
      fds = fs.readdirSync(`${procRoot}/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target;
      try {
        target = fs.readlinkSync(`${procRoot}/${entry}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m && inodes.has(m[1])) {
        pids.add(Number(entry));
        break;
      }
    }
  }
  return pids;
}

export function readTables(procRoot = "/proc") {
  const tables = [];
  for (const t of ["tcp", "tcp6"]) {
    try {
      tables.push(fs.readFileSync(`${procRoot}/net/${t}`, "utf8"));
    } catch {
      /* table absent */
    }
  }
  return tables;
}

export function listenersOn(port, procRoot = "/proc") {
  return pidsForInodes(listeningInodes(readTables(procRoot), port), procRoot);
}

/** Real uid of a process, from /proc/<pid>/status. */
export function uidOf(pid, procRoot = "/proc") {
  try {
    const m = /^Uid:\s+(\d+)/m.exec(fs.readFileSync(`${procRoot}/${pid}/status`, "utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Parent PID from /proc/<pid>/stat (field 4; the comm field may contain spaces). */
export function parentOf(pid, procRoot = "/proc") {
  try {
    const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return null;
  }
}

/** True when `pid` is `ancestor` or one of its descendants. */
export function descendsFrom(pid, ancestor, procRoot = "/proc") {
  for (let p = pid, hops = 0; p && p > 1 && hops < 64; p = parentOf(p, procRoot), hops++) {
    if (p === ancestor) return true;
  }
  return false;
}
