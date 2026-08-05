/**
 * Pure command-search helpers. Kept free of SolidJS and Wails so they can be
 * unit tested directly (see search.test.ts).
 *
 * A query is split into whitespace-separated tokens; a command matches only if
 * *every* token appears somewhere in its searchable text (label, command, group).
 * Matches are ranked so label hits surface above command-body hits.
 */

/** Minimal shape needed to search — any CommandConfig satisfies it. */
export interface Searchable {
  label: string;
  command: string;
  group?: string;
  /** Owning project name, so a global query like "pos build" can match. */
  project?: string;
  /** Pre-hooks, searched with the same weight as the command body. */
  preCommands?: string[];
  /** Post-hooks, searched with the same weight as the command body. */
  postCommands?: Array<{ command: string }>;
}

/** True when the command has any pre- or post-hook configured. */
export function hasHooks(cmd: Searchable): boolean {
  return (cmd.preCommands?.length || 0) + (cmd.postCommands?.length || 0) > 0;
}

/** All hook shell text of a command as one lowercase haystack. */
function hookText(cmd: Searchable): string {
  const pre = cmd.preCommands || [];
  const post = (cmd.postCommands || []).map(p => p?.command || '');
  return [...pre, ...post].join('\n').toLowerCase();
}

/** Splits a raw query into lowercase tokens. Returns [] for a blank query. */
export function queryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Scores one command against pre-tokenised query terms.
 * Returns 0 when any token is missing (no match); higher is a better match.
 */
export function scoreCommand(cmd: Searchable, tokens: string[]): number {
  if (tokens.length === 0) return 0;

  const label = (cmd.label || '').toLowerCase();
  const command = (cmd.command || '').toLowerCase();
  const group = (cmd.group || '').toLowerCase();
  const project = (cmd.project || '').toLowerCase();
  const hooks = hookText(cmd);

  let score = 0;
  for (const token of tokens) {
    if (label.startsWith(token)) score += 8;
    else if (label.includes(token)) score += 4;
    else if (group.includes(token)) score += 2;
    else if (project.includes(token)) score += 2;
    else if (command.includes(token)) score += 1;
    else if (hooks.includes(token)) score += 1;
    else return 0; // every token must match something
  }
  return score;
}

/** True when the command matches the whole query. A blank query matches nothing. */
export function matchesQuery(cmd: Searchable, query: string): boolean {
  return scoreCommand(cmd, queryTokens(query)) > 0;
}

/**
 * Filters and ranks commands by query. A blank query returns the input list
 * unchanged (callers use their normal group filter in that case).
 * Ties keep the original order, so results stay stable while typing.
 */
export function searchCommands<T extends Searchable>(cmds: readonly T[], query: string): T[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [...cmds];

  return cmds
    .map((cmd, index) => ({ cmd, index, score: scoreCommand(cmd, tokens) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.cmd);
}

/** A minimal project shape for global search. Any Project satisfies it. */
export interface SearchableProject<C extends Searchable> {
  id: string;
  name: string;
  commands?: C[];
}

/** One global search hit: the command plus the project it belongs to. */
export interface GlobalResult<C extends Searchable> {
  projectId: string;
  projectName: string;
  cmd: C;
}

/**
 * Searches every command of every project, ranked highest-first.
 * A blank query returns no results (the Spotlight panel shows a hint instead).
 * `limit` caps the list so a one-letter query can't render thousands of rows.
 */
export function searchAllProjects<C extends Searchable>(
  projects: readonly SearchableProject<C>[],
  query: string,
  limit = 50,
): GlobalResult<C>[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];

  const scored: Array<{ result: GlobalResult<C>; index: number; score: number }> = [];
  let index = 0;

  for (const project of projects) {
    for (const cmd of project.commands || []) {
      // Project name participates in matching without being copied onto the command.
      const score = scoreCommand({ ...cmd, project: project.name }, tokens);
      if (score > 0) {
        scored.push({
          result: { projectId: project.id, projectName: project.name, cmd },
          index,
          score,
        });
      }
      index++;
    }
  }

  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(entry => entry.result);
}
