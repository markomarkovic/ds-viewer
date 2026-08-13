export type Gathered = {
  accepted: File[]
  refused: string[]
  skippedCount: number
}

export function classifyName(name: string): 'accept' | 'refuse' | 'skip' {
  const lower = name.toLowerCase()
  if (lower.endsWith('.ds1')) return 'accept'
  if (/\.ds[234]$/.test(lower)) return 'refuse'
  return 'skip'
}

export function gather(files: readonly File[]): Gathered {
  const out: Gathered = { accepted: [], refused: [], skippedCount: 0 }
  for (const f of files) {
    const c = classifyName(f.name)
    if (c === 'accept') out.accepted.push(f)
    else if (c === 'refuse') out.refused.push(f.name)
    else out.skippedCount++
  }
  return out
}

// readEntries returns at most 100 entries per call and must be called until
// it yields an empty batch — the classic cause of "only some files loaded".
async function readAll(
  dir: FileSystemDirectoryEntry
): Promise<FileSystemEntry[]> {
  const reader = dir.createReader()
  const out: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject)
    )
    if (batch.length === 0) return out
    out.push(...batch)
  }
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

async function walk(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    out.push(await fileOf(entry as FileSystemFileEntry))
  } else if (entry.isDirectory) {
    for (const child of await readAll(entry as FileSystemDirectoryEntry))
      await walk(child, out)
  }
}

export async function filesFromDataTransfer(
  items: DataTransferItemList
): Promise<File[]> {
  // Snapshot entries synchronously: the DataTransferItemList is only valid
  // during the drop event tick.
  const entries: (FileSystemEntry | null)[] = []
  const fallback: File[] = []
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue
    const entry = item.webkitGetAsEntry()
    if (entry) entries.push(entry)
    else {
      const f = item.getAsFile()
      if (f) fallback.push(f)
    }
  }
  const out: File[] = [...fallback]
  for (const entry of entries) if (entry) await walk(entry, out)
  return out
}
