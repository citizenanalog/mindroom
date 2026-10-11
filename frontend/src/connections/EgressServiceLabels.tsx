import {
  agentSeesNote,
  hostsNote,
  limitedNote,
  limitTarget,
  type ServiceEditing,
  sentAsNote,
  unsetNote,
} from "./egressRowStatus";
import { LimitActions } from "./EgressLimitRows";
import type { EgressCredentialService } from "./types";

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
