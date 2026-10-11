import { sharedAccountStatus } from "./accountCopy";
import { limitedRepositories } from "./githubLimits";
import type {
  EgressCredentialService,
  EgressOAuthStatus,
  EgressServiceSource,
} from "./types";

/**
 * The agent a list of rows belongs to, for the wording that depends on it.
 */
export interface RowAgent {
  displayName: string;
  /** A shared or unscoped agent: everyone using it shares its keys and accounts. */
  shared: boolean;
  /**
   * The credential managers' Matrix IDs, when the response names them. Where
   * the page says who manages a shared agent, the rows leave it out.
   */
  managers?: string[];
  /** Every service of the agent: disconnecting a provider names the ones that use it. */
  services: EgressCredentialService[];
}

/** Controls for the services a viewer defines themselves, and a label for the ones someone else defined. */
export interface ServiceEditing {
  /** Services with this `source` get Edit and Delete, when the viewer can manage them. */
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

/** What the row's badge says about where the service's credential comes from. */
export function statusLabel(
  service: EgressCredentialService,
  agent: RowAgent,
): string {
  const oauth = service.oauth;
  if (oauth) {
    if (service.active_source === "key") return "Using API key";
    if (service.active_source === "oauth")
      return sharesAccount(agent, oauth)
        ? sharedAccountStatus(oauth.account_label, agent.displayName)
        : oauth.account_label
          ? `Connected as ${oauth.account_label}`
          : "Connected";
    return oauth.reset_required ? "Reset required" : "Not set";
  }
  if (!service.configured) return "Not set";
  const updated = service.updated_at ? new Date(service.updated_at) : null;
  return updated && !Number.isNaN(updated.getTime())
    ? `Key saved ${updated.toLocaleDateString()}`
    : "Key saved";
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

/** "Limited to a/b" for a service whose rules reach only some repositories, unless its description already says so. */
export function limitedNote(service: EgressCredentialService): string | null {
  const repositories = limitedRepositories(service.rules);
  if (repositories.length === 0) return null;
  const text = `Limited to ${repositories.join(", ")}`;
  return service.description === text ? null : text;
}

/** "Sends to a.com, b.com:8443" for the hosts a service's rules cover, each once; null where the listing gives no rules. */
export function hostsNote(service: EgressCredentialService): string | null {
  const hosts = [
    ...new Set(
      (service.rules ?? []).map(
        (rule) => `${rule.host}${rule.port === null ? "" : `:${rule.port}`}`,
      ),
    ),
  ];
  return hosts.length > 0 ? `Sends to ${hosts.join(", ")}` : null;
}
