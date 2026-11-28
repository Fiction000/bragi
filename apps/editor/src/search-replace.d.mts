export type SearchMatch = { start: number; end: number; text: string; replacement?: string };
export type SearchOptions = { caseSensitive?: boolean; wordBoundary?: boolean; regex?: boolean; excludeCode?: boolean; replacement?: string };
export function findReplacements(text: string, query: string, options?: SearchOptions): { matches: SearchMatch[]; error: string };
export function replaceSelected(text: string, matches: SearchMatch[], selected: boolean[], replacement: string): string;
export function previewContext(text: string, match: SearchMatch, radius?: number): { before: string; hit: string; after: string };
