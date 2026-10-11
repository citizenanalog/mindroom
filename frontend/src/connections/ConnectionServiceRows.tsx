import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  disconnectDescription,
  sharedAccountStatus,
  sharedAgentNote,
} from "./accountCopy";
import { ConfirmDialog } from "./ConfirmDialog";
import { connectWithPopup, type OAuthAuthorization } from "./oauthPopup";
import { requestConnection } from "./request";
import { SharedAccountDialog } from "./SharedAccountDialog";
import { STACKED, STACKED_CELL, STACKED_LABEL } from "./stackedTable";
import { ToolName, ToolExposure } from "./ToolRow";
import type {
  AgentConnections,
  ConnectionService,
  ConnectionStatus,
} from "./types";
import type { McpSelectionState } from "./useMcpSelection";

/** One account status and operation lifecycle, even when several tools share it. */
export function ConnectionServiceRows({
  agent,
  service,
  mcp,
  refreshVersion,
  onConnectionChange,
  onStatus,
}: {
  agent: AgentConnections;
  service: ConnectionService;
  mcp: McpSelectionState;
  refreshVersion: number;
  onConnectionChange: () => void;
  /** Told whether the account is connected each time its status loads. */
  onStatus?: (
    agentName: string,
    provider: string,
    status: ConnectionStatus,
  ) => void;
}) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sharedOpen, setSharedOpen] = useState(false);
  const statusRequest = useRef<AbortController | null>(null);
  const operation = useRef<AbortController | null>(null);
  const basePath = `/api/connections/agents/${encodeURIComponent(agent.agent_name)}/${encodeURIComponent(service.provider)}`;

  const loadStatus = useCallback(async () => {
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    setLoading(true);
    setError(null);
    try {
      const next = await requestConnection<ConnectionStatus>(
        `${basePath}/status`,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setStatus(next);
        onStatus?.(agent.agent_name, service.provider, next);
      }
    } catch {
      if (!controller.signal.aborted) {
        setStatus(null);
        setError("Could not load connection status. Try again.");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [basePath, agent.agent_name, service.provider, onStatus]);

  useEffect(() => {
    void loadStatus();
    return () => statusRequest.current?.abort();
  }, [loadStatus, refreshVersion]);

  useEffect(() => () => operation.current?.abort(), []);

  const connect = async () => {
    // A second click on Continue, while the first connect is under way, starts nothing.
    if (busy !== null) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy("connect");
    setError(null);
    try {
      await connectWithPopup(
        service.provider,
        () =>
          requestConnection<OAuthAuthorization>(
            `${basePath}/connect`,
            controller.signal,
            "POST",
          ),
        controller.signal,
      );
      if (!controller.signal.aborted) onConnectionChange();
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
    setConfirmOpen(false);
    setBusy("disconnect");
    setError(null);
    const controller = new AbortController();
    operation.current = controller;
    try {
      await requestConnection(
        `${basePath}/disconnect`,
        controller.signal,
        "POST",
      );
      if (!controller.signal.aborted) onConnectionChange();
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

  const tools = agent.tools.filter(
    (tool) => tool.provider === service.provider,
  );
  // Everything on this agent that stops working when the account goes: its
  // services that sign in with the provider, then the tools, once each.
  const users = [
    ...(agent.egress_services ?? [])
      .filter((other) => other.oauth?.provider === service.provider)
      .map((other) => other.display_name),
    ...tools.map((tool) => tool.display_name),
  ];
  // Everyone who uses a shared agent acts as its connected account, so everyone is told.
  const sharedConnected =
    service.is_shared && status?.connected === true && !status.reset_required;
  const dependents = users.filter(
    (name, index) =>
      users.findIndex((other) => other.toLowerCase() === name.toLowerCase()) ===
      index,
  );
  return (
    <>
      {tools.map((tool, index) => (
        <Fragment key={tool.name}>
          <tr
            className={`border-t border-border/60 ${STACKED.row} max-sm:py-2`}
          >
            <th
              scope="row"
              className={`px-5 py-3 text-left font-normal ${STACKED_CELL} max-sm:px-4 max-sm:py-1`}
            >
              <ToolName tool={tool} />
            </th>
            {index === 0 && (
              <td
                rowSpan={tools.length}
                data-label="Connection"
                className={`px-4 py-3 align-top ${STACKED_CELL} ${STACKED_LABEL} max-sm:py-1`}
              >
                {loading ? (
                  <span
                    role="status"
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                    Checking connection…
                  </span>
                ) : (
                  status && (
                    <>
                      <span className="flex items-center gap-1.5 text-sm">
                        {status.connected && (
                          <CheckCircle2
                            className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                            aria-hidden="true"
                          />
                        )}
                        {sharedConnected
                          ? sharedAccountStatus(
                              status.account_label,
                              agent.agent_display_name,
                            )
                          : !service.can_manage
                            ? status.connected
                              ? "Shared connection configured"
                              : "Shared connection unavailable"
                            : status.reset_required
                              ? "Reset required"
                              : status.connected
                                ? "Connected"
                                : "Not connected"}
                      </span>
                      {status.account_label && !sharedConnected && (
                        <p className="mt-1 max-w-56 break-all text-xs text-muted-foreground">
                          {status.account_label}
                        </p>
                      )}
                    </>
                  )
                )}
                {error && (
                  <Alert variant="destructive" className="mt-2 p-2">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
              </td>
            )}
            <td
              data-label="MCP gateway"
              className={`px-4 py-3 ${STACKED_CELL} ${STACKED_LABEL} max-sm:py-1`}
            >
              <ToolExposure agent={agent} tool={tool} mcp={mcp} />
            </td>
            {index === 0 && (
              <td
                rowSpan={tools.length}
                className={`px-5 py-3 text-right align-top ${STACKED_CELL} max-sm:px-4 max-sm:py-2 max-sm:text-left`}
              >
                {!loading && !status && (
                  <Button variant="outline" onClick={() => void loadStatus()}>
                    Retry status
                  </Button>
                )}
                {!loading && status && !service.can_manage && (
                  <span className="text-xs text-muted-foreground">
                    {agent.managers === undefined
                      ? "Managed by credential managers"
                      : sharedAgentNote(false, agent.managers)}
                  </span>
                )}
                {!loading && status && service.can_manage && (
                  <div className="flex flex-wrap items-center gap-2 max-sm:justify-start sm:justify-end">
                    {status.reset_required ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        aria-label={`Reset connection for ${service.display_name}`}
                        onClick={() => setConfirmOpen(true)}
                      >
                        Reset connection
                      </Button>
                    ) : status.connected ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        aria-label={`Disconnect for ${service.display_name}`}
                        onClick={() => setConfirmOpen(true)}
                      >
                        Disconnect
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={busy !== null || !status.can_connect}
                        aria-label={`Connect ${service.display_name}`}
                        onClick={() =>
                          service.is_shared
                            ? setSharedOpen(true)
                            : void connect()
                        }
                      >
                        {busy === "connect" ? "Connecting…" : "Connect"}
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
                    {!status.connected &&
                      !status.can_connect &&
                      !status.reset_required && (
                        <p className="w-full text-sm text-muted-foreground">
                          This service is not ready to connect yet.
                        </p>
                      )}
                  </div>
                )}
                <SharedAccountDialog
                  open={sharedOpen}
                  agent={agent.agent_display_name}
                  provider={service.display_name}
                  onCancel={() => setSharedOpen(false)}
                  onContinue={() => {
                    setSharedOpen(false);
                    void connect();
                  }}
                />
                <ConfirmDialog
                  open={confirmOpen}
                  title={`${status?.reset_required ? "Reset" : "Disconnect"} ${service.display_name}?`}
                  description={disconnectDescription(
                    service.display_name,
                    agent.agent_display_name,
                    dependents,
                  )}
                  confirmLabel={
                    status?.reset_required ? "Reset connection" : "Disconnect"
                  }
                  onCancel={() => setConfirmOpen(false)}
                  onConfirm={() => void disconnect()}
                />
              </td>
            )}
          </tr>
        </Fragment>
      ))}
    </>
  );
}
