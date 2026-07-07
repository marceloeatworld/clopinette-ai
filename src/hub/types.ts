/**
 * Skills Hub types.
 */

export interface HubSkillMeta {
  name: string;
  description: string;
  source: string;          // "github", "url", "catalog"
  identifier: string;      // source-specific ID (repo/path, URL, catalog name)
  trustLevel: "builtin" | "trusted" | "community";
  tags?: string[];
  author?: string;
  license?: string;
  collection?: string;
  collectionLabel?: string;
}

export interface HubSupportFile {
  path: string;
  content: string;
}

export interface HubSkillBundle {
  meta: HubSkillMeta;
  content: string;         // full SKILL.md content
  frontmatter: Record<string, unknown>;
  supportFiles?: HubSupportFile[];
}

export interface HubInstallResult {
  ok: boolean;
  name?: string;
  error?: string;
}

export interface SkillSource {
  id: string;
  search(query: string, limit?: number): Promise<HubSkillMeta[]>;
  fetch(identifier: string): Promise<HubSkillBundle | null>;
}

export interface CatalogEntry {
  name: string;
  description: string;
  source: string;
  identifier: string;
  trustLevel: "builtin" | "trusted" | "community";
  tags?: string[];
  featured?: boolean;
}

export interface CatalogIndex {
  version: number;
  updatedAt: string;
  skills: CatalogEntry[];
}

export interface TrustedRepo {
  id: string;
  collection: string;
  owner: string;
  repo: string;
  path: string;
  trustLevel: "trusted" | "community";
  label: string;
}
