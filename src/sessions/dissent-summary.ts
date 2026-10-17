/** Extraction blocks are private provenance, never part of the readable/public summary. */
export function withoutDissentBlocks(text: string): string {
  return text.replace(/<DISSENT>[\s\S]*?(?:<\/DISSENT>|$)/g, "").replace(/<\/?DISSENT>/g, "").trim();
}
