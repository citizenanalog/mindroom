import { githubRepositoryRules } from "./egressServiceModel";
import type { EgressRuleSummary } from "./types";

const API_HOSTS = ["api.github.com", "uploads.github.com"];
const WEB_HOST = "github.com";
const UPLOADS_HOST = "uploads.github.com";
const GRAPHQL_PATH = "/graphql";

type Rules = readonly EgressRuleSummary[] | undefined;

const hostOf = (rule: EgressRuleSummary) => rule.host.trim().toLowerCase();
const onGithub = (rule: EgressRuleSummary) =>
  hostOf(rule) === WEB_HOST || API_HOSTS.includes(hostOf(rule));

/** Whether any rule applies to GitHub's API, web, or upload host. */
export function coversGithub(rules: Rules): boolean {
  return (rules ?? []).some(onGithub);
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
  hostOf(rule) === "api.github.com" && rule.path_prefix === GRAPHQL_PATH;

/** What the repository helper's choices were, read back from the rules it wrote. */
export interface GithubLimit {
  /** `owner/repo` or `owner/*`, in rule order, from every rule that names a repository. */
  repositories: string[];
  uploads: boolean;
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
  const uploads = all.some((rule) => hostOf(rule) === UPLOADS_HOST);
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
    uploads,
    graphql,
    exact:
      repositories.length > 0 &&
      actual.size === expected.size &&
      [...actual].every((key) => expected.has(key)),
  };
}
