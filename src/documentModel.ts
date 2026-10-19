import { Node as JsonNode, parseTree, findNodeAtLocation } from "jsonc-parser";

export const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
export type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];

export interface DependencyEntry {
  section: DependencySection;
  name: string;
  spec: string;
  keyOffset: number;
  keyLength: number;
  /** Offset/length of the string contents (without quotes). */
  valueOffset: number;
  valueLength: number;
  /** End offset of the whole property, for decoration placement. */
  lineEndOffset: number;
}

export interface SectionInfo {
  section: DependencySection;
  keyOffset: number;
}

export function extractDependencies(text: string, sections: readonly string[]): { entries: DependencyEntry[]; sections: SectionInfo[] } {
  const root = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  const entries: DependencyEntry[] = [];
  const found: SectionInfo[] = [];
  if (!root || root.type !== "object") return { entries, sections: found };
  for (const section of DEPENDENCY_SECTIONS) {
    if (!sections.includes(section)) continue;
    const obj = findNodeAtLocation(root, [section]);
    if (!obj || obj.type !== "object" || !obj.parent) continue;
    const keyNode = obj.parent.children?.[0];
    found.push({ section, keyOffset: keyNode?.offset ?? obj.offset });
    for (const prop of obj.children ?? []) {
      const [k, v] = prop.children ?? ([] as JsonNode[]);
      if (!k || !v || typeof k.value !== "string" || v.type !== "string" || typeof v.value !== "string") continue;
      entries.push({
        section,
        name: k.value,
        spec: v.value,
        keyOffset: k.offset + 1,
        keyLength: k.length - 2,
        valueOffset: v.offset + 1,
        valueLength: v.length - 2,
        lineEndOffset: v.offset + v.length,
      });
    }
  }
  return { entries, sections: found };
}
