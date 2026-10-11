import { type EgressServiceForm, usesOwnRules } from "./egressServiceForm";
import {
  GITHUB_API_HOST,
  GITHUB_UPLOADS_HOST,
  GITHUB_WEB_HOST,
  githubRepositoryRules,
} from "./githubRepositoryRules";
import type { EgressRuleSummary } from "./types";

const API_HOSTS = [GITHUB_API_HOST, GITHUB_UPLOADS_HOST];
const GRAPHQL_PATH = "/graphql";

type Rules = readonly EgressRuleSummary[] | undefined;

const hostOf = (rule: { host: string }) => rule.host.trim().toLowerCase();
const onGithub = (rule: { host: string }) =>
  hostOf(rule) === GITHUB_WEB_HOST || API_HOSTS.includes(hostOf(rule));

/** Whether any rule applies to GitHub's API, web, or upload host. */
export function coversGithub(rules: Rules): boolean {
  return (rules ?? []).some(onGithub);
}

/** Whether to offer the GitHub helper: the GitHub preset, or the service's own rules on a GitHub host. */
export function looksLikeGithub(form: EgressServiceForm): boolean {
  if (form.preset === "github") return true;
  if (!usesOwnRules(form)) return false;
  return form.rules.some(onGithub);
}

/** The repository a rule names, as `owner/repo` or `owner/*`, or null when it names none. */
function repositoryOf(rule: EgressRuleSummary): string | null {
  const api = API_HOSTS.includes(hostOf(rule));
  const repo = (
    api ? /^\/repos\/([^/]+)\/([^/]+)$/ : /^\/([^/]+)\/([^/]+?)(?:\.git)?$/
  ).exec(rule.path_prefix);
  if (repo) return `${repo[1]}/${repo[2]}`;
  // An owner prefix ends in a slash and takes everything below it.
  const owner = (api ? /^\/repos\/([^/]+)\/$/ : /^\/([^/]+)\/$/).exec(
    rule.path_prefix,
  );
  return owner ? `${owner[1]}/*` : null;
}

/**
 * The repositories a service reaches on GitHub, as `owner/repo` or `owner/*`,
 * when every one of its rules on a GitHub host names a repository, the way the
 * editor's helper writes them. Empty when it has no such rule, or any other
 * rule on GitHub (the whole API, `/graphql`) lets it reach more.
 */
export function limitedRepositories(rules: Rules): string[] {
  const repositories: string[] = [];
  for (const rule of (rules ?? []).filter(onGithub)) {
    const repository = repositoryOf(rule);
    if (repository === null) return [];
    if (!repositories.includes(repository)) repositories.push(repository);
  }
  return repositories;
}

const isGraphql = (rule: EgressRuleSummary) =>
  hostOf(rule) === GITHUB_API_HOST && rule.path_prefix === GRAPHQL_PATH;

/** What a limit is said to reach when GraphQL is among its rules. */
export const GRAPHQL_CAVEAT =
  "plus GraphQL, which reaches every repository the key can reach";

/**
 * The limit a service's rules put on GitHub, when every rule on a GitHub host
 * names a repository the way the editor's helper writes them, apart from an
 * allowed GraphQL rule; null for any other service. GraphQL is told apart
 * because it reaches every repository the key can, so a limit that allows it
 * must say so.
 */
export function limitedTo(
  rules: Rules,
): { repositories: string[]; graphql: boolean } | null {
  const all = rules ?? [];
  const repositories = limitedRepositories(
    all.filter((rule) => !isGraphql(rule)),
  );
  return repositories.length > 0
    ? { repositories, graphql: all.some(isGraphql) }
    : null;
}

/** What the repository helper's choices were, read back from the rules it wrote. */
export interface GithubLimit {
  /** `owner/repo` or `owner/*`, in rule order, from every rule that names a repository. */
  repositories: string[];
  graphql: boolean;
  /** The rules are exactly what the helper writes for these choices, so applying them again changes nothing. */
  exact: boolean;
}

const ruleKey = (rule: EgressRuleSummary) => `${rule.host}${rule.path_prefix}`;

/**
 * The repositories and options behind a limit's rules, for opening it in the
 * editor again. Unlike `limitedRepositories`, it reads past the GraphQL rule
 * and any other rule that names no repository, and reports whether anything
 * would be lost by writing the rules anew.
 */
export function parseGithubLimit(rules: Rules): GithubLimit {
  const all = rules ?? [];
  const uploads = all.some((rule) => hostOf(rule) === GITHUB_UPLOADS_HOST);
  const graphql = all.some(isGraphql);
  const repositories = [
    ...new Set(
      all
        .filter((rule) => onGithub(rule) && !isGraphql(rule))
        .flatMap((rule) => repositoryOf(rule) ?? []),
    ),
  ];
  const generated =
    repositories.length > 0
      ? githubRepositoryRules(repositories.join("\n"), { uploads, graphql })
          .rules
      : [];
  const expected = new Set(
    generated.map((rule) =>
      ruleKey({
        host: rule.host,
        port: null,
        path_prefix: rule.path_prefix ?? "/",
      }),
    ),
  );
  const actual = new Set(all.map(ruleKey));
  return {
    repositories,
    graphql,
    exact:
      repositories.length > 0 &&
      actual.size === expected.size &&
      [...actual].every((key) => expected.has(key)),
  };
}
