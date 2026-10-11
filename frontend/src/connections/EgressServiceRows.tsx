import { type FormEvent, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  disconnectDescription,
  personalAccountRefusal,
  personalSandboxRefusal,
} from "./accountCopy";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  agentSeesNote,
  hostsNote,
  limitedNote,
  limitOf,
  limitTarget,
  removeWarning,
  type RowAgent,
  type ServiceEditing,
  sentAsNote,
  servicesUsingAccount,
  sharesAccount,
  statusLabel,
  unsetNote,
} from "./egressRowStatus";
import { coversGithub } from "./githubLimits";
import { connectWithPopup, type OAuthAuthorization } from "./oauthPopup";
import { type RequestErrorMessages, requestConnection } from "./request";
import { SharedAccountDialog } from "./SharedAccountDialog";
import type { EgressCredentialList, EgressCredentialService } from "./types";

export type { RowAgent, ServiceEditing } from "./egressRowStatus";

type AccountAction = "connect" | "disconnect";

/** The endpoints one service row talks to. */
interface ServicePaths {
  secret: string;
  connect: string;
  disconnect: string;
  /** Whether the service's account is connected now, read again from the listing the row came from. */
  accountConnected: (signal: AbortSignal) => Promise<boolean>;
}

function EgressServiceRow({
  paths,
  service,
  onChanged,
  errorMessages,
  serviceEditing,
  agent,
  hideKeyActions,
}: {
  paths: ServicePaths;
  service: EgressCredentialService;
  onChanged: () => void;
  errorMessages?: RequestErrorMessages;
  serviceEditing?: ServiceEditing;
  agent: RowAgent;
  hideKeyActions: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<
    "save" | "remove" | "connect" | "disconnect" | "delete" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    "key" | "account" | "service" | "shared" | null
  >(null);
  const operation = useRef<AbortController | null>(null);
  const keyLabel = `${service.display_name} API key`;
  const oauth = service.oauth;
  // Rows with an account keep the key behind a toggle until a key is set.
  const showKeyControls = !oauth || service.key_configured || editing;
  const canManageKey = service.can_manage && !hideKeyActions;
  const keyInsteadLabel = oauth?.connected
    ? "Use an API key instead of the account"
    : "Use an API key instead";
  // Requester-scoped accounts belong to the requester, so the server lets any
  // eligible user manage them even without key rights.
  const canResetAccount =
    oauth !== null &&
    !hideKeyActions &&
    (oauth.connected || oauth.reset_required) &&
    (service.can_manage || oauth.can_connect);

  const sourceLabel =
    serviceEditing && service.source
      ? serviceEditing.labels?.[service.source]
      : undefined;
  const canEditService =
    serviceEditing !== undefined &&
    service.source === serviceEditing.editableSource &&
    service.can_manage;
  const limitedText = limitedNote(service);
  const hostsText = hostsNote(service);
  const sentAsText = sentAsNote(service);
  const agentSeesText = agentSeesNote(service);
  const unsetText = unsetNote(service);
  // A limit of the viewer's that narrows this administrator's service.
  const limit = limitOf(service, agent.services);
  const canChangeLimit =
    limit !== null &&
    serviceEditing?.onChangeLimit !== undefined &&
    serviceEditing.onRemoveLimit !== undefined &&
    limit.can_manage;
  // A service that already has a limit changes or removes it instead of getting another.
  const canLimit =
    limit === null &&
    serviceEditing?.onLimitToRepositories !== undefined &&
    service.source === "config" &&
    service.can_manage &&
    coversGithub(service.rules);
  // Everyone using a shared agent acts as the account connected there.
  const asksAboutSharedAccount = sharesAccount(agent, oauth);
  // Once a key is saved there is nothing left to ask for, so the hint goes.
  const refusalShown =
    oauth?.unavailable_reason === "shared_sandbox" && !service.key_configured;
  // The page names a shared agent's managers once, and a refused personal
  // account row says whom to ask itself, so the row only does without it.
  const managersNamed = agent.managers !== undefined || refusalShown;

  useEffect(() => () => operation.current?.abort(), []);

  const closeEditor = () => {
    setEditing(false);
    setSecret("");
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!secret.trim() || busy) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy("save");
    setError(null);
    try {
      await requestConnection<void>(
        paths.secret,
        controller.signal,
        "PUT",
        { secret },
        errorMessages,
      );
      if (controller.signal.aborted) return;
      closeEditor();
      onChanged();
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not save the key. Try again.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  };

  const remove = async () => {
    setConfirm(null);
    const controller = new AbortController();
    operation.current = controller;
    setBusy("remove");
    setError(null);
    try {
      await requestConnection<void>(
        paths.secret,
        controller.signal,
        "DELETE",
        undefined,
        errorMessages,
      );
      if (!controller.signal.aborted) onChanged();
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not remove the key. Try again.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  };

  const deleteService = async () => {
    setConfirm(null);
    if (!serviceEditing) return;
    setBusy("delete");
    setError(null);
    try {
      await serviceEditing.onDelete(service);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "Could not delete the service. Try again.",
      );
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    // A second click on Continue, while the first connect is under way, starts nothing.
    if (!oauth || busy !== null) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy("connect");
    setError(null);
    try {
      await connectWithPopup(
        oauth.provider,
        () =>
          requestConnection<OAuthAuthorization>(
            paths.connect,
            controller.signal,
            "POST",
            {},
            errorMessages,
          ),
        controller.signal,
        // A popup that closed after connecting is a connection, not a cancel.
        () => paths.accountConnected(controller.signal),
      );
      if (!controller.signal.aborted) onChanged();
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not connect. Try again.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  };

  const disconnect = async () => {
    setConfirm(null);
    const controller = new AbortController();
    operation.current = controller;
    setBusy("disconnect");
    setError(null);
    try {
      await requestConnection<void>(
        paths.disconnect,
        controller.signal,
        "POST",
        {},
        errorMessages,
      );
      if (!controller.signal.aborted) onChanged();
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not disconnect. Try again.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  };

  return (
    <li
      aria-label={service.display_name}
      className="border-t border-border/60 px-5 py-3 first:border-t-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <span className="font-medium">{service.display_name}</span>
          <p
            className="max-w-md truncate text-xs text-muted-foreground"
            title={service.description}
          >
            {service.description}
          </p>
          {hostsText && (
            <p className="break-words text-xs text-muted-foreground">
              {hostsText}
            </p>
          )}
          {[sentAsText, agentSeesText, unsetText].map(
            (text) =>
              text && (
                <p
                  key={text}
                  className="break-words text-xs text-muted-foreground"
                >
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
                  onError={setError}
                />
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 max-sm:justify-start sm:justify-end">
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
              Everyone using this agent can act with the connected account until
              its access expires
            </span>
          )}
          {!service.can_manage && !managersNamed && (
            <span className="text-xs text-muted-foreground">
              {oauth?.can_connect
                ? "API key managed by credential managers"
                : "Managed by credential managers"}
            </span>
          )}
          {/* Connecting reads the saved connection first, so an unreadable one needs a reset before. */}
          {oauth &&
            !hideKeyActions &&
            oauth.can_connect &&
            !oauth.connected &&
            !oauth.reset_required && (
              <Button
                size="sm"
                disabled={busy !== null}
                aria-label={`Connect ${oauth.display_name} for ${service.display_name}`}
                onClick={() =>
                  asksAboutSharedAccount ? setConfirm("shared") : void connect()
                }
              >
                {busy === "connect"
                  ? "Connecting…"
                  : `Connect ${oauth.display_name}`}
              </Button>
            )}
          {busy === "connect" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                operation.current?.abort();
                setBusy(null);
              }}
            >
              Cancel
            </Button>
          )}
          {oauth && canResetAccount && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              aria-label={`${oauth.connected ? "Disconnect" : "Reset connection"} for ${service.display_name}`}
              onClick={() => setConfirm("account")}
            >
              {busy === "disconnect"
                ? "Disconnecting…"
                : oauth.connected
                  ? "Disconnect"
                  : "Reset connection"}
            </Button>
          )}
          {oauth && canManageKey && !showKeyControls && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              aria-label={`${keyInsteadLabel} for ${service.display_name}`}
              onClick={() => {
                setError(null);
                setEditing(true);
              }}
            >
              {keyInsteadLabel}
            </Button>
          )}
          {canManageKey && showKeyControls && !editing && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                aria-label={`${service.key_configured ? "Replace" : "Set"} key for ${service.display_name}`}
                onClick={() => {
                  setError(null);
                  setEditing(true);
                }}
              >
                {service.key_configured ? "Replace key" : "Set key"}
              </Button>
              {service.key_configured && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  aria-label={`Remove key for ${service.display_name}`}
                  onClick={() => setConfirm("key")}
                >
                  {busy === "remove" ? "Removing…" : "Remove key"}
                </Button>
              )}
            </>
          )}
          {canLimit && serviceEditing?.onLimitToRepositories && (
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy !== null ||
                serviceEditing.disabled ||
                serviceEditing.limitDisabled
              }
              aria-label={`Limit to repositories for ${service.display_name}`}
              onClick={() => serviceEditing.onLimitToRepositories?.(service)}
            >
              Limit to repositories
            </Button>
          )}
          {canEditService && serviceEditing && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy !== null ||
                  serviceEditing.disabled ||
                  serviceEditing.editingName === service.name
                }
                aria-label={`Edit service for ${service.display_name}`}
                onClick={() => serviceEditing.onEdit(service)}
              >
                Edit service
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || serviceEditing.disabled}
                aria-label={`Delete service for ${service.display_name}`}
                onClick={() => setConfirm("service")}
              >
                {busy === "delete" ? "Deleting…" : "Delete service"}
              </Button>
            </>
          )}
        </div>
      </div>
      {canManageKey && editing && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(event) => void save(event)}
        >
          <Input
            type="password"
            autoComplete="off"
            aria-label={keyLabel}
            placeholder="Paste the key"
            className="h-9 max-w-sm flex-1 max-sm:basis-full"
            value={secret}
            disabled={busy !== null}
            onChange={(event) => setSecret(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            disabled={busy !== null || !secret.trim()}
          >
            {busy === "save" ? (
              <>
                <Loader2
                  className="mr-2 h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
                Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={closeEditor}
          >
            Cancel
          </Button>
        </form>
      )}
      {error && (
        <Alert variant="destructive" className="mt-3 p-2">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <ConfirmDialog
        open={confirm === "key"}
        title={`Remove ${keyLabel}?`}
        description={removeWarning(service)}
        confirmLabel="Remove"
        onCancel={() => setConfirm(null)}
        onConfirm={() => void remove()}
      />
      {canEditService && serviceEditing && (
        <ConfirmDialog
          open={confirm === "service"}
          title={`Delete ${service.display_name}?`}
          description={serviceEditing.deleteWarning(service)}
          confirmLabel="Delete"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void deleteService()}
        />
      )}
      {oauth && (
        <SharedAccountDialog
          open={confirm === "shared"}
          agent={agent.displayName}
          provider={oauth.display_name}
          onCancel={() => setConfirm(null)}
          onContinue={() => {
            setConfirm(null);
            void connect();
          }}
        />
      )}
      {oauth && (
        <ConfirmDialog
          open={confirm === "account"}
          title={`${oauth.connected ? "Disconnect" : "Reset"} ${oauth.display_name}?`}
          description={disconnectDescription(
            oauth.display_name,
            agent.displayName,
            servicesUsingAccount(agent, oauth),
          )}
          confirmLabel={oauth.connected ? "Disconnect" : "Reset connection"}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void disconnect()}
        />
      )}
    </li>
  );
}

/**
 * Change and Remove for a limit, with the question before it goes. `label`
 * names what the buttons are for. The page turns every limit action off while
 * one is being written (`serviceEditing.disabled`), so a limit shown in two
 * rows cannot be removed twice.
 */
function LimitActions({
  limit,
  label,
  serviceEditing,
  onError,
}: {
  limit: EgressCredentialService;
  label: string;
  serviceEditing: ServiceEditing;
  onError: (message: string | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const disabled = busy || serviceEditing.disabled === true;

  const remove = async () => {
    setConfirming(false);
    setBusy(true);
    onError(null);
    try {
      await serviceEditing.onRemoveLimit?.(limit);
    } catch (cause) {
      onError(
        cause instanceof Error && cause.message
          ? cause.message
          : "Could not remove the limit. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled || serviceEditing.editingName === limit.name}
        aria-label={`Change limit for ${label}`}
        onClick={() => serviceEditing.onChangeLimit?.(limit)}
      >
        Change limit
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        aria-label={`Remove limit for ${label}`}
        onClick={() => setConfirming(true)}
      >
        {busy ? "Removing…" : "Remove limit"}
      </Button>
      <ConfirmDialog
        open={confirming}
        title={`Remove the limit on ${label}?`}
        description={serviceEditing.removeLimitWarning ?? ""}
        confirmLabel="Remove limit"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void remove()}
      />
    </>
  );
}

/** A service that only limits paths: no key, account, or status, just what it limits and how to change that. */
function LimitRow({
  service,
  serviceEditing,
}: {
  service: EgressCredentialService;
  serviceEditing?: ServiceEditing;
}) {
  const [error, setError] = useState<string | null>(null);
  const hosts = hostsNote(service)?.replace(/^Sends to/, "Limits requests to");
  const canChange =
    serviceEditing?.onChangeLimit !== undefined &&
    serviceEditing.onRemoveLimit !== undefined &&
    service.source === serviceEditing.editableSource &&
    service.can_manage;
  return (
    <li
      aria-label={service.display_name}
      className="border-t border-border/60 px-5 py-3 first:border-t-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <span className="font-medium">{service.display_name}</span>
          {service.description && (
            <p
              className="max-w-md truncate text-xs text-muted-foreground"
              title={service.description}
            >
              {service.description}
            </p>
          )}
          {hosts && (
            <p className="break-words text-xs text-muted-foreground">{hosts}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 max-sm:justify-start sm:justify-end">
          <Badge variant="outline" className="font-normal">
            Limit only
          </Badge>
          {canChange && serviceEditing && (
            <LimitActions
              limit={service}
              label={service.display_name}
              serviceEditing={serviceEditing}
              onError={setError}
            />
          )}
        </div>
      </div>
      {error && (
        <Alert variant="destructive" className="mt-3 p-2">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </li>
  );
}

/** Where one service's secret is written and its account is connected. */
type ServiceTarget =
  | {
      agentName: string;
      secretPath?: undefined;
      accountPath?: undefined;
      servicesPath?: undefined;
    }
  | {
      agentName?: undefined;
      secretPath: (serviceName: string) => string;
      accountPath: (serviceName: string, action: AccountAction) => string;
      /** The listing these services came from, `{services: [...]}`, read again when a login popup closes without answering. */
      servicesPath: string;
    };

const EGRESS_LISTING_PATH = "/api/connections/egress";

const accountConnectedIn = (
  services: readonly EgressCredentialService[] | undefined,
  serviceName: string,
) =>
  services?.find((service) => service.name === serviceName)?.oauth
    ?.connected === true;

// The egress listings say whether each service's account is connected, for any
// agent and provider; a provider's own status route only knows the agent's tools.
function servicePathsFor(
  target: ServiceTarget,
  serviceName: string,
): ServicePaths {
  if (target.secretPath) {
    const { servicesPath } = target;
    return {
      secret: target.secretPath(serviceName),
      connect: target.accountPath(serviceName, "connect"),
      disconnect: target.accountPath(serviceName, "disconnect"),
      accountConnected: async (signal) =>
        accountConnectedIn(
          (
            await requestConnection<{ services: EgressCredentialService[] }>(
              servicesPath,
              signal,
            )
          ).services,
          serviceName,
        ),
    };
  }
  const { agentName } = target;
  const base = `/api/connections/egress/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(serviceName)}`;
  return {
    secret: base,
    connect: `${base}/connect`,
    disconnect: `${base}/disconnect`,
    accountConnected: async (signal) =>
      accountConnectedIn(
        (
          await requestConnection<EgressCredentialList>(
            EGRESS_LISTING_PATH,
            signal,
          )
        ).agents.find((agent) => agent.agent_name === agentName)?.services,
        serviceName,
      ),
  };
}

/**
 * Accounts and API keys the egress broker injects into outbound requests.
 *
 * Rows target one agent's personal connections API by default. Pass
 * `secretPath`, `accountPath`, and `servicesPath` instead of `agentName` to
 * use another endpoint, such as the dashboard's.
 */
export function EgressServiceRows({
  services,
  onChanged,
  errorMessages,
  serviceEditing,
  agent,
  hideKeyActions = false,
  ...target
}: ServiceTarget & {
  services: EgressCredentialService[];
  onChanged: () => void;
  /** Wording for 403 and 404 responses outside the Connections portal. */
  errorMessages?: RequestErrorMessages;
  /** Edit and delete controls for the services the viewer defines. */
  serviceEditing?: ServiceEditing;
  /** The agent the rows belong to, for the wording that depends on it. */
  agent: RowAgent;
  /** Leaves out what sets, removes, or connects a key or account, for rows no agent uses. */
  hideKeyActions?: boolean;
}) {
  return (
    <ul>
      {services.map((service) =>
        service.restrict_only ? (
          <LimitRow
            key={service.name}
            service={service}
            serviceEditing={serviceEditing}
          />
        ) : (
          <EgressServiceRow
            key={service.name}
            paths={servicePathsFor(target, service.name)}
            service={service}
            onChanged={onChanged}
            errorMessages={errorMessages}
            serviceEditing={serviceEditing}
            agent={agent}
            hideKeyActions={hideKeyActions}
          />
        ),
      )}
    </ul>
  );
}
