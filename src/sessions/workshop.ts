// ============================================================================
// Shared helpers for phase-based workshops
// ============================================================================

/** Settle every item before reporting the first failure in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const errors = new Map<number, unknown>();
  let next = 0;
  const concurrency = Number.isNaN(limit) ? 1 : Math.max(1, Math.floor(limit));
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (e) {
        errors.set(index, e);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, () => worker()));
  for (let i = 0; i < items.length; i++) {
    if (errors.has(i)) throw errors.get(i);
  }
  return results;
}

export function extractJsonObject(text: string): unknown {
  const unfenced = text.replace(/^[ \t]*```[A-Za-z]*[ \t]*\r?$/gm, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("No JSON object found. Return a complete JSON object.");
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    throw new Error("Invalid JSON object. Return valid JSON with quoted keys and no trailing commas.");
  }
}

export function notFoundError(kind: string, id: string, activeIds: string[]): Error {
  return new Error(`${kind} not found: ${id}. Active ${kind.toLowerCase()}s: ${activeIds.join(", ") || "none"}`);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max)) + "\n…[truncated]";
}

/** Match the label at the start of a line and the longest canonical verdict at the start of its value. */
export function parseVerdict(text: string, label: string, options: readonly string[]): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}\\s*:\\s*(.*)$`, "i");
  const sorted = [...options].sort((a, b) => b.length - a.length);
  for (const line of text.split(/\r?\n/).slice(0, 5)) {
    const match = pattern.exec(line.replace(/\*\*/g, ""));
    if (!match) continue;
    const verdict = match[1].trim().toUpperCase();
    for (const option of sorted) {
      const canonical = option.toUpperCase();
      if (verdict.startsWith(canonical) && (verdict.length === canonical.length || /[\s.,;:!?—–(]/.test(verdict[canonical.length]))) {
        return option;
      }
    }
  }
  return "UNCLEAR";
}
