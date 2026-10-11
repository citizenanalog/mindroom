import { Badge } from "@/components/ui/badge";
import { personalAccountRefusal, personalSandboxRefusal } from "./accountCopy";
import {
  type RowAgent,
  type ServiceEditing,
  statusLabel,
} from "./egressRowText";
import type { EgressCredentialService } from "./types";

/** The row's status badge and the notes about the account it uses, in the order they are shown. */
export function ServiceStatus({
  service,
  agent,
  serviceEditing,
}: {
  service: EgressCredentialService;
  agent: RowAgent;
  serviceEditing?: ServiceEditing;
}) {
  const oauth = service.oauth;
  const sourceLabel =
    serviceEditing && service.source
      ? serviceEditing.labels?.[service.source]
      : undefined;
  // Once a key is saved there is nothing left to ask for, so the hint goes.
  const refusalShown =
    oauth?.unavailable_reason === "shared_sandbox" && !service.key_configured;
  // The page names a shared agent's managers once, and a refused personal
  // account row says whom to ask itself, so the row only does without it.
  const managersNamed = agent.managers !== undefined || refusalShown;
  return (
    <>
      <Badge
        variant={service.configured ? "secondary" : "outline"}
        className="max-w-full font-normal"
      >
        {statusLabel(service, agent)}
      </Badge>
      {service.active_source === "key" && oauth?.connected && (
        <span className="text-xs text-muted-foreground">
          Your connected {oauth.display_name} account is kept for other
          services.
        </span>
      )}
      {sourceLabel && (
        <Badge variant="outline" className="font-normal">
          {sourceLabel}
        </Badge>
      )}
      {oauth?.service_account && (
        <span className="text-xs text-muted-foreground">
          Uses a shared service account
        </span>
      )}
      {refusalShown && (
        <span className="text-xs text-muted-foreground">
          {agent.shared
            ? personalAccountRefusal(
                oauth.display_name,
                service.can_manage,
                agent.managers,
              )
            : personalSandboxRefusal(oauth.display_name)}
        </span>
      )}
      {oauth?.shared_worker_opt_in && (
        <span className="text-xs text-amber-600 dark:text-amber-400">
          Everyone using this agent can act with the connected account until its
          access expires
        </span>
      )}
      {!service.can_manage && !managersNamed && (
        <span className="text-xs text-muted-foreground">
          {oauth?.can_connect
            ? "API key managed by credential managers"
            : "Managed by credential managers"}
        </span>
      )}
    </>
  );
}
