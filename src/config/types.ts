export const CONFIG_FILENAME = ".repository-release-auditor.json";

export interface ForbiddenPattern {
  readonly id: string;
  readonly text: string;
  readonly caseSensitive: boolean;
}

export interface RepositoryConfig {
  readonly forbiddenPatterns: readonly ForbiddenPattern[];
}
