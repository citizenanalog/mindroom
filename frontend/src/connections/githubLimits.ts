import type { EgressRuleSummary } from "./types";

const API_HOSTS = ["api.github.com", "uploads.github.com"];
const WEB_HOST = "github.com";

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
