import { randomUUID } from "node:crypto"
import { open, rename } from "node:fs/promises"
import { dirname } from "node:path"

/** Replaces `file` with `data` via a synced temp file and rename, then syncs the directory entry. */
export const writeAtomic = async (file: string, data: string): Promise<void> => {
  const tmp = `${file}.${randomUUID()}.tmp`
  const handle = await open(tmp, "w")
  try {
    await handle.writeFile(data, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, file)
  // Persist the rename itself; without this a crash can roll the directory entry back. Windows cannot fsync a
  // directory (EPERM), and a failure here would report a write that already landed as failed.
  if (process.platform === "win32") return
  const dir = await open(dirname(file), "r")
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
}
