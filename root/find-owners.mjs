// Run by the supervisor as the uid that owns a listening socket: prints the pids (as JSON)
// holding the given socket inodes. A process may read /proc/<pid>/fd of its own uid even
// where root may not (no CAP_SYS_PTRACE).
import { pidsForInodes } from "./procnet.mjs";

console.log(JSON.stringify([...pidsForInodes(new Set(process.argv.slice(2)))]));
