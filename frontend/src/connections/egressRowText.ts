import { formatList, sharedAccountStatus } from "./accountCopy";
import { BROKERED_PLACEHOLDER } from "./egressServiceForm";
import { GRAPHQL_CAVEAT, limitedTo, parseGithubLimit } from "./githubLimits";
import type {
  EgressCredentialService,
  EgressOAuthStatus,
  EgressRuleSummary,
  EgressServiceSource,
} from "./types";

/**
 * The agent a list of rows belongs to, for the wording that depends on it.
 */
export interface RowAgent {
  displayName: string;
  /** A shared or unscoped agent: everyone using it shares its keys and accounts. */
  shared: boolean;
  /** The credential managers' Matrix IDs; the dashboard, whose operator manages every service, leaves them out. */
  managers?: string[];
  /** Every service of the agent: disconnecting a provider names the ones that use it. */
  services: EgressCredentialService[];
}

/** Controls for the services a viewer defines themselves, and a label for the ones someone else defined. */
export interface ServiceEditing {
  /**
   * Services with this `source` get Edit and Delete, when the viewer can
   * manage them; a limit of that source gets Change limit and Remove limit.
   */
  editableSource: EgressServiceSource;
  /** Turns Edit and Delete off while something else is being written. */
  disabled?: boolean;
  /** The service whose editor is open: opening it again would only offer to discard what is typed there. */
  editingName?: string | null;
  onEdit: (service: EgressCredentialService) => void;
  /** Rejects with an Error whose message the row shows. */
  onDelete: (service: EgressCredentialService) => Promise<void>;
  deleteWarning: (service: EgressCredentialService) => string;
  /** Label for services of another source; the personal page groups its rows instead. */
  labels?: Partial<Record<EgressServiceSource, string>>;
  /**
   * Offers Limit to repositories on an administrator's service that reaches
   * GitHub, when the viewer can manage the agent.
   */
  onLimitToRepositories?: (service: EgressCredentialService) => void;
  /** Turns Limit to repositories off while the editor is open. */
  limitDisabled?: boolean;
}

/**
 * Whether connecting this account makes everyone who uses the agent act as it.
 * Not so for a personal account (the agent is not shared), a service account,
 * or a requester's own account that a sandbox shared by several users refuses
 * or only uses under the service's opt-in.
 */
export function sharesAccount(
  agent: RowAgent,
  oauth: EgressOAuthStatus | null,
): boolean {
  return (
    agent.shared &&
    oauth !== null &&
    !oauth.service_account &&
    !oauth.shared_worker_opt_in &&
    oauth.unavailable_reason === null
  );
}

function keySavedLabel(saved: string | null): string {
  const date = saved ? new Date(saved) : null;
  return date && !Number.isNaN(date.getTime())
    ? `Key saved ${date.toLocaleDateString()}`
    : "Key saved";
}

/** What the row's badge says about where the service's credential comes from. */
export function statusLabel(
  service: EgressCredentialService,
  agent: RowAgent,
): string {
  const oauth = service.oauth;
  if (oauth) {
    // An account that cannot be used here leaves the key as all there is to say.
    if (service.active_source === "key")
      return oauth.unavailable_reason === null
        ? "Using API key"
        : keySavedLabel(service.key_updated_at);
    if (service.active_source === "oauth")
      return sharesAccount(agent, oauth)
        ? sharedAccountStatus(oauth.account_label, agent.displayName)
        : oauth.account_label
          ? `Connected as ${oauth.account_label}`
          : "Connected";
    return oauth.reset_required ? "Reset required" : "Not set";
  }
  if (!service.configured) return "Not set";
  return keySavedLabel(service.key_updated_at);
}

export function removeWarning(service: EgressCredentialService): string {
  if (service.is_global)
    return "This deletes the global key, which every agent without a worker scope shares. Those agents lose access to this service until a key is set again.";
  if (service.is_shared === null)
    return "This deletes the saved key. The agent loses access to this service until a key is set again.";
  // A shared agent's key, or for an agent without a worker scope the global
  // key, so other agents may rely on it too.
  if (service.is_shared)
    return "This deletes the shared key. Everyone who relies on it loses access to this service until a key is set again.";
  return "This deletes your saved key. Your agent loses access to this service until you set a key again.";
}

/** The names of the agent's services that sign in with this account, for the disconnect question. */
export function servicesUsingAccount(
  agent: RowAgent,
  oauth: EgressOAuthStatus | null,
): string[] {
  if (oauth === null) return [];
  return agent.services
    .filter((other) => other.oauth?.provider === oauth.provider)
    .map((other) => other.display_name);
}

/**
 * "Limited to a/b" for a service whose rules reach only some repositories,
 * unless its description already says so. A limit that allows GraphQL adds
 * that GraphQL reaches every repository the key can reach.
 */
export function limitedNote(service: EgressCredentialService): string | null {
  const limit = limitedTo(service.rules);
  if (limit === null) return null;
  const caveat = limit.graphql ? ` (${GRAPHQL_CAVEAT})` : "";
  const text = `Limited to ${limit.repositories.join(", ")}${caveat}`;
  return service.description === text ? null : text;
}

/** The hosts a service's rules cover, each once, with the port when a rule names one. */
function ruleHosts(rules: readonly EgressRuleSummary[]): string[] {
  return [
    ...new Set(
      rules.map(
        (rule) => `${rule.host}${rule.port === null ? "" : `:${rule.port}`}`,
      ),
    ),
  ];
}

/** "Sends to a.com, b.com:8443" for the hosts a service's rules cover, each once; null without rules. */
export function hostsNote(service: EgressCredentialService): string | null {
  const hosts = ruleHosts(service.rules);
  return hosts.length > 0 ? `Sends to ${hosts.join(", ")}` : null;
}

const SENT_AS: Record<string, (name: string | null | undefined) => string> = {
  bearer: () => "as a bearer token",
  header: (name) => (name ? `as header ${name}` : "as a header"),
  query: (name) =>
    name ? `as query parameter ${name}` : "as a query parameter",
  basic: () => "with basic auth",
  template: () => "with a custom header template",
};

/**
 * How the service's rules send the key: "Sent as a bearer token", "Sent as
 * header X-Api-Key", and so on, once for each way its rules differ. Null for
 * a service that sends no key.
 */
export function sentAsNote(service: EgressCredentialService): string | null {
  const ways = [
    ...new Set(
      service.rules.flatMap((rule) =>
        rule.auth_type ? [SENT_AS[rule.auth_type]?.(rule.auth_name)] : [],
      ),
    ),
  ].filter((way) => way !== undefined);
  return ways.length > 0 ? `Sent ${formatList(ways)}` : null;
}

/**
 * What the sandbox is told about the service: the variables it sets, or for a
 * service with a key and nothing to set, that the agent must be told which
 * website to use. Null where the listing does not name the variables, and for
 * an account service, which the agent finds through the API it calls.
 */
export function agentSeesNote(service: EgressCredentialService): string | null {
  const names = service.placeholder_names;
  if (names === undefined || service.restrict_only) return null;
  if (names.length > 0)
    return `Your agent sees ${names.map((name) => `${name}=${BROKERED_PLACEHOLDER}`).join(", ")}`;
  const hosts = ruleHosts(service.rules);
  return service.oauth === null && hosts.length > 0
    ? `Your agent is not told this key exists; mention ${formatList(hosts)} in your request.`
    : null;
}

/** What happens to requests while the service has no key or account; null once it has, and for a limit. */
export function unsetNote(service: EgressCredentialService): string | null {
  const hosts = ruleHosts(service.rules);
  return service.configured || service.restrict_only || hosts.length === 0
    ? null
    : `While no key is set, requests to ${formatList(hosts)} are refused.`;
}

/**
 * The repositories a limit names, as `a/b, c/*`, or "selected paths" when its
 * rules name none, followed by what GraphQL reaches when the limit allows it.
 */
export function limitTarget(limit: EgressCredentialService): string {
  const { repositories, graphql } = parseGithubLimit(limit.rules);
  const target =
    repositories.length > 0 ? repositories.join(", ") : "selected paths";
  return graphql ? `${target} (${GRAPHQL_CAVEAT})` : target;
}

/**
 * The limit that narrows an administrator's service: a service of the viewer's
 * that only restricts paths on one of its hosts. Null for any other service.
 */
export function limitOf(
  service: EgressCredentialService,
  services: readonly EgressCredentialService[],
): EgressCredentialService | null {
  if (service.source !== "config" || service.restrict_only) return null;
  const hosts = new Set(service.rules.map((rule) => rule.host.toLowerCase()));
  return (
    services.find(
      (other) =>
        other.restrict_only &&
        other.source === "user" &&
        other.rules.some((rule) => hosts.has(rule.host.toLowerCase())),
    ) ?? null
  );
}
