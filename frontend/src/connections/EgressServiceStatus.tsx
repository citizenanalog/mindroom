import { Badge } from "@/components/ui/badge";
import { personalAccountRefusal, personalSandboxRefusal } from "./accountCopy";
import {
  agentSeesNote,
  hostsNote,
  limitedNote,
  limitTarget,
  type RowAgent,
  type ServiceEditing,
  sentAsNote,
  statusLabel,
  unsetNote,
} from "./egressRowStatus";
import { LimitActions } from "./EgressLimitRows";
import type { EgressCredentialService } from "./types";

/**
 * What a service row says about its service: the name, description, and notes
 * on the left (`ServiceLabels`), and the status badge with the notes about the
 * account on the right (`ServiceStatus`).
 */

/** The row's left side: what the service is, where it sends, and the limit that narrows it. */
export function ServiceLabels({
  service,
  limit,
  canChangeLimit,
  serviceEditing,
  onError,
}: {
  service: EgressCredentialService;
  /** A limit of the viewer's that narrows this service. */
  limit: EgressCredentialService | null;
  canChangeLimit: boolean;
  serviceEditing?: ServiceEditing;
  onError: (message: string | null) => void;
}) {
  const limitedText = limitedNote(service);
  const hostsText = hostsNote(service);
  const sentAsText = sentAsNote(service);
  const agentSeesText = agentSeesNote(service);
  const unsetText = unsetNote(service);
  return (
    <div className="min-w-0 space-y-0.5">
      <span className="font-medium">{service.display_name}</span>
      <p
        className="max-w-md truncate text-xs text-muted-foreground"
        title={service.description}
      >
        {service.description}
      </p>
      {hostsText && (
        <p className="break-words text-xs text-muted-foreground">{hostsText}</p>
      )}
      {[sentAsText, agentSeesText, unsetText].map(
        (text) =>
          text && (
            <p key={text} className="break-words text-xs text-muted-foreground">
              {text}
            </p>
          ),
      )}
      {limitedText && (
        <p className="text-xs text-muted-foreground">{limitedText}</p>
      )}
      {limit && (
        <div className="flex flex-wrap items-center gap-x-2">
          <p className="text-xs text-muted-foreground">
            Limited to {limitTarget(limit)}
          </p>
          {canChangeLimit && serviceEditing && (
            <LimitActions
              limit={limit}
              label={service.display_name}
              serviceEditing={serviceEditing}
              onError={onError}
            />
          )}
        </div>
      )}
    </div>
  );
}

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
