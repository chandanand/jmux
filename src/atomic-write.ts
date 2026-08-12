import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync } from "fs";
import { dirname } from "path";

// Unique per write, so two writers to one path never share a temp name. Mirrors
// the counter in src/snapshot/fs.ts, which solves the same race asynchronously.
let writeCounter = 0;

/**
 * Replace `path` with `contents`, durably and atomically.
 *
 * Synchronous on purpose: `ConfigStore.persist()` is reached from synchronous
 * UI handlers throughout main.ts, and making it async would ripple through
 * every one of them. That rules out reusing `ProductionFileSystem.writeAtomic`
 * from src/snapshot/fs.ts, which is otherwise the same algorithm.
 *
 * The steps are load-bearing in this order: write the bytes to a temp file,
 * fsync *that file* so its contents are on disk, rename over the target (atomic
 * within a filesystem), then fsync the *parent directory* so the rename's
 * directory entry survives power loss. Skipping the file fsync can leave a
 * renamed-but-empty file, which is worse than the partial write it replaced.
 */
export function writeFileAtomicSync(path: string, contents: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const tmp = `${path}.tmp.${process.pid}.${++writeCounter}`;
  let wroteTmp = false;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    wroteTmp = true;
    renameSync(tmp, path);
  } catch (err) {
    // Either way the temp file may exist and must not be left behind: a
    // half-written `config.json.tmp.123.4` beside the real config is litter
    // that nothing else will ever clean up.
    void wroteTmp;
    try { unlinkSync(tmp); } catch { /* never created, or already gone */ }
    throw err;
  }

  // Best-effort: not every platform or filesystem supports directory fsync,
  // and failing here would undo a write that has already succeeded.
  try {
    const dh = openSync(dir, "r");
    try { fsyncSync(dh); } finally { closeSync(dh); }
  } catch { /* unsupported */ }
}
