import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Download, Plus, RefreshCw } from "lucide-react";
import { breakAfterUnderscores } from "@/connections/breakAfterUnderscores";
import {
  DiscardEditsNotice,
  EgressServiceEditor,
} from "@/connections/EgressServiceEditor";
import {
  EgressServiceRows,
  type ServiceEditing,
} from "@/connections/EgressServiceRows";
import type { RequestErrorMessages } from "@/connections/request";
import type {
  AuthoredEgressService,
  EgressCredentialService,
  EgressOAuthStatus,
  EgressPresetCatalog,
  EgressRuleSummary,
  EgressServiceSource,
} from "@/connections/types";
import {
  API_ENDPOINTS,
  fetchJSON,
  withAgentName,
  withQueryParams,
} from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { ConfigPath } from "@/lib/configSchema";
import {
  type ConfigDraftMark,
  type SaveConfigResult,
  useConfigStore,
} from "@/store/configStore";
import {
  type Agent,
  type Config,
  resolveEffectiveDefaultTools,
} from "@/types/config";

const NOT_RUNNING_MESSAGE =
  "Egress broker is not running. Set MINDROOM_EGRESS_BROKER_PORT and MINDROOM_EGRESS_BROKER_URL.";
const LOG_ERROR_MESSAGE = "Could not load the request log. Try again.";
const LOG_TIMEOUT_MS = 30_000;
const UNSCOPED_OPTION = "Agents without a scope";
const UNSCOPED_AGENTS = "the agents without a scope";
// The target that uses the one set of keys all agents without a worker scope share.
const UNSCOPED_VALUE = "";
// Brokered traffic only exists for agents that can run commands.
const EGRESS_TOOLS = ["shell", "python"];
const SECRET_ERROR_MESSAGES: RequestErrorMessages = {
  forbidden: "You are not allowed to change egress keys or accounts.",
  notFound:
    "This service is no longer configured. Reload the page to update the list.",
};

interface BrokerService {
  name: string;
  display_name: string | null;
  description: string;
  source: EgressServiceSource;
  rules: EgressRuleSummary[];
  /** The service only limits paths: it has no key or account. Absent from older servers. */
  restrict_only?: boolean;
  configured: boolean;
  updated_at: string | null;
  active_source: "key" | "oauth" | null;
  key_configured: boolean;
  key_updated_at: string | null;
  oauth: EgressOAuthStatus | null;
}

interface AuditRecord {
  at: string;
  agent_name: string | null;
  /** The Matrix ID of the user whose request this was; `null` when none is known. */
  requester_id: string | null;
  method: string;
  host: string;
  path: string;
  service: string | null;
  status: number;
  duration_ms: number;
  /** The error code the broker refused with; `null` for a forwarded request. */
  code: string | null;
}

interface LogFilters {
  user: string;
  agent: string;
  host: string;
  service: string;
}

type LogState =
  | { kind: "loading" }
  | { kind: "ready"; records: AuditRecord[] }
  | { kind: "not-running" }
  | { kind: "error" };

// The path comes last because it is the one that can be long; it is cut short
// with its full value as a title, and the duration is in the time's title.
const LOG_COLUMNS = [
  "Time",
  "User",
  "Agent",
  "Method",
  "Host",
  "Status",
  "Service",
  "Path",
];

const NO_FILTERS: LogFilters = { user: "", agent: "", host: "", service: "" };

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

const STALE_SAVE_MESSAGE =
  "The configuration changed while saving. Reload the page and check the service list.";
const USER_SERVICE_LABEL = "User service";
const DELETE_WARNING =
  "This removes the service from the configuration. Saved keys stay stored and apply again if a service with the same name is added back.";
// Saving writes the whole draft, so the other unsaved changes go out with the service.
const OTHER_CHANGES_WARNING =
  "This also saves your other unsaved settings changes.";

type EditorState = ({ kind: "add" } | { kind: "edit"; name: string }) & {
  /**
   * The name of another service whose Edit was pressed while this editor had
   * unsaved changes. It lives here so that closing the editor drops it.
   */
  pendingEdit?: string;
};

// The store holds the config as authored, so a preset service reads
// `{preset: "github"}` and goes back the same way.
function operatorServices(
  config: Config | null,
): Record<string, AuthoredEgressService> {
  const section = (
    config as unknown as {
      egress_broker?: { services?: Record<string, AuthoredEgressService> };
    } | null
  )?.egress_broker;
  return section?.services ?? {};
}

function saveFailureMessage(
  result: Exclude<SaveConfigResult, { status: "saved" | "stale" }>,
): string {
  const issues = result.diagnostics.flatMap((diagnostic) => {
    if (
      diagnostic.kind !== "validation" ||
      diagnostic.issue.loc[0] !== "egress_broker"
    )
      return [];
    const message = diagnostic.issue.msg.replace(/^Value error, /, "");
    // An issue on `egress_broker` itself has no field path to show.
    const where = diagnostic.issue.loc.slice(2).join(".");
    return [where ? `${where}: ${message}` : message];
  });
  return issues.length > 0 ? issues.join("; ") : result.message;
}

function loadPresets(): Promise<EgressPresetCatalog> {
  return fetchJSON<EgressPresetCatalog>(API_ENDPOINTS.egressBroker.presets);
}

function canUseEgress(agent: Agent, defaults: Config["defaults"]): boolean {
  const inherited =
    agent.include_default_tools === false
      ? []
      : resolveEffectiveDefaultTools(defaults);
  return [...agent.tools, ...inherited].some((tool) =>
    EGRESS_TOOLS.includes(tool),
  );
}

type KeyScope = "shared" | "unscoped" | "requester";

// Keys for `user` and `user_agent` agents belong to each requester, so the
// admin API rejects them; their users set keys on the Connections page.
function keyScope(agent: Agent, defaults: Config["defaults"]): KeyScope {
  if (agent.private != null) return "requester";
  const scope = agent.worker_scope ?? defaults?.worker_scope ?? null;
  if (scope === "user" || scope === "user_agent") return "requester";
  return scope === "shared" ? "shared" : "unscoped";
}

function ServiceSection({
  agentName,
  agentLabel,
  keysUnused,
}: {
  agentName: string | null;
  /** How the agent, or the agents without a scope, reads in a sentence. */
  agentLabel: string;
  /** No agent uses these keys, so there is nothing to set or connect them for. */
  keysUnused: boolean;
}) {
  const config = useConfigStore((state) => state.config);
  const dirtyRoots = useConfigStore((state) => state.dirtyRoots);
  const updateConfigValue = useConfigStore((state) => state.updateConfigValue);
  const restoreConfigValue = useConfigStore(
    (state) => state.restoreConfigValue,
  );
  const saveConfig = useConfigStore((state) => state.saveConfig);
  const [services, setServices] = useState<EgressCredentialService[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const latest = useRef(0);
  const authoredServices = operatorServices(config);
  // A save writes the whole draft, so say so when it holds more than this service.
  const saveWarning = (dirtyRoots ?? []).some(
    (root) => root !== "egress_broker",
  )
    ? OTHER_CHANGES_WARNING
    : null;

  const load = useCallback(async () => {
    const request = ++latest.current;
    try {
      const payload = await fetchJSON<{ services: BrokerService[] }>(
        withAgentName(API_ENDPOINTS.egressBroker.services, agentName),
      );
      if (request !== latest.current) return;
      // The dashboard operator manages every service. Only shared agents and
      // the global store are offered, so every key here is shared, and the
      // global one is the one that agents without a worker scope share.
      setServices(
        payload.services.map((service) => ({
          ...service,
          display_name: service.display_name ?? service.name,
          is_shared: true,
          is_global: agentName === null,
          can_manage: true,
        })),
      );
      setError(null);
    } catch (cause) {
      if (request !== latest.current) return;
      setError(errorMessage(cause, "Could not load the egress services."));
    }
  }, [agentName]);

  useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  // Writes one config service through the store, as Settings does. When the
  // save fails the value goes back to what it was before this write. So does
  // the draft's dirty state, unless something else changed the draft meanwhile:
  // the store then keeps that dirty state, since it holds those other edits.
  const writeService = async (
    name: string,
    next: AuthoredEgressService | undefined,
  ) => {
    const path: ConfigPath = ["egress_broker", "services", name];
    const previous = authoredServices[name];
    // Read now, not from the last render: other edits may have landed since.
    const {
      isDirty,
      dirtyRoots: rootsBefore,
      draftVersion,
    } = useConfigStore.getState();
    const before: ConfigDraftMark = {
      isDirty,
      dirtyRoots: rootsBefore ?? [],
      draftVersion,
    };
    setSaving(true);
    try {
      updateConfigValue(path, next);
      const result = await saveConfig();
      if (result.status === "saved") {
        await load();
        return;
      }
      if (result.status === "stale") throw new Error(STALE_SAVE_MESSAGE);
      restoreConfigValue(path, previous, before);
      throw new Error(saveFailureMessage(result));
    } finally {
      setSaving(false);
    }
  };

  const saveService = async (name: string, service: AuthoredEgressService) => {
    await writeService(name, service);
    setEditor(null);
  };

  const deleteService = async (name: string) => {
    await writeService(name, undefined);
    setEditor((current) =>
      current?.kind === "edit" && current.name === name ? null : current,
    );
  };

  const setPendingEdit = (pendingEdit?: string) =>
    setEditor((current) => current && { ...current, pendingEdit });

  const startEdit = (name: string) => {
    setPendingEdit(undefined);
    if (authoredServices[name] === undefined) {
      setActionError(
        "This service is not in the loaded configuration. Reload the page and try again.",
      );
      return;
    }
    setActionError(null);
    setEditor({ kind: "edit", name });
  };

  // Opening another service's editor would throw away what is typed in this one.
  const requestEdit = (name: string) => {
    if (editor !== null && editorDirty) setPendingEdit(name);
    else startEdit(name);
  };

  const pendingEdit = editor?.pendingEdit;
  const serviceEditing: ServiceEditing = {
    editableSource: "config",
    disabled: saving,
    editingName: editor?.kind === "edit" ? editor.name : null,
    onEdit: (service) => requestEdit(service.name),
    onDelete: (service) => deleteService(service.name),
    deleteWarning: () =>
      saveWarning ? `${DELETE_WARNING} ${saveWarning}` : DELETE_WARNING,
    // Limits are services users add, so they show read-only like the other user services.
    labels: { user: USER_SERVICE_LABEL },
  };

  return (
    <section aria-labelledby="egress-services-heading" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="egress-services-heading" className="text-sm font-medium">
          Service keys and accounts
        </h3>
        <Button
          size="sm"
          variant="outline"
          disabled={config === null || editor !== null}
          onClick={() => {
            setActionError(null);
            setEditor({ kind: "add" });
          }}
        >
          <Plus className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Add service
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Services you add here are offered to every agent and user. Private
        agents are not listed: each user sets their own keys on the{" "}
        <a
          href="/connections"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Connections page
        </a>
        .
      </p>
      {keysUnused && (
        <p className="text-xs text-muted-foreground">
          No agent uses these keys.
        </p>
      )}
      {error && (
        <Alert variant="destructive" className="p-2">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive" className="p-2">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}
      {pendingEdit !== undefined && (
        <DiscardEditsNotice
          onDiscard={() => startEdit(pendingEdit)}
          onKeep={() => setPendingEdit(undefined)}
        />
      )}
      {editor && (
        <div className="overflow-hidden rounded-md border border-border/60">
          <EgressServiceEditor
            key={editor.kind === "add" ? "add" : `edit:${editor.name}`}
            context="operator"
            name={editor.kind === "edit" ? editor.name : undefined}
            service={
              editor.kind === "edit" ? authoredServices[editor.name] : null
            }
            takenNames={[
              ...Object.keys(authoredServices),
              ...(services ?? []).map((service) => service.name),
            ]}
            loadPresets={loadPresets}
            saveWarning={saveWarning}
            onDirtyChange={setEditorDirty}
            onSave={saveService}
            onDelete={
              editor.kind === "edit"
                ? () => deleteService(editor.name)
                : undefined
            }
            onCancel={() => setEditor(null)}
          />
        </div>
      )}
      {!services && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading services...
        </p>
      )}
      {services?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No egress services are configured yet. Use Add service, or add them
          under <code>egress_broker.services</code> in the config.
        </p>
      )}
      {services && services.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border/60">
          <EgressServiceRows
            secretPath={(serviceName) =>
              withAgentName(
                API_ENDPOINTS.egressBroker.secret(serviceName),
                agentName,
              )
            }
            accountPath={(serviceName, action) =>
              withAgentName(
                API_ENDPOINTS.egressBroker.account(serviceName, action),
                agentName,
              )
            }
            services={services}
            onChanged={() => void load()}
            errorMessages={SECRET_ERROR_MESSAGES}
            serviceEditing={serviceEditing}
            hideKeyActions={keysUnused}
            // Only shared agents and the global store are offered here, so every key is shared.
            agent={{ displayName: agentLabel, shared: true, services }}
          />
        </div>
      )}
    </section>
  );
}

function LogTable({
  records,
  agentNames,
}: {
  records: AuditRecord[];
  /** The display name of each configured agent, by its id. */
  agentNames: ReadonlyMap<string, string>;
}) {
  if (records.length === 0)
    return (
      <p className="text-sm text-muted-foreground">No requests logged yet.</p>
    );
  return (
    <div className="overflow-x-auto rounded-md border border-border/60">
      <table aria-label="Request log" className="w-full text-left text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr>
            {LOG_COLUMNS.map((column) => (
              <th key={column} className="px-3 py-2 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((record, index) => (
            <tr
              // The log has no unique ids and can repeat identical requests.
              key={`${record.at}-${index}`}
              className="border-t border-border/60"
            >
              <td
                className="whitespace-nowrap px-3 py-2"
                title={`${record.duration_ms} ms`}
              >
                {new Date(record.at).toLocaleString()}
              </td>
              <td className="break-all px-3 py-2">
                {record.requester_id ?? "-"}
              </td>
              <td className="px-3 py-2">
                {record.agent_name === null
                  ? "-"
                  : (agentNames.get(record.agent_name) ?? record.agent_name)}
              </td>
              <td className="px-3 py-2 font-mono text-xs">{record.method}</td>
              <td className="px-3 py-2">{record.host}</td>
              <td className="px-3 py-2">
                <Badge
                  variant={record.status >= 400 ? "destructive" : "secondary"}
                  className="font-normal"
                >
                  {record.status}
                </Badge>
                {record.code && (
                  <div className="mt-1 break-words text-xs text-muted-foreground">
                    {breakAfterUnderscores(record.code)}
                  </div>
                )}
              </td>
              <td className="px-3 py-2">{record.service ?? "-"}</td>
              <td
                className="max-w-[14rem] truncate px-3 py-2 font-mono text-xs"
                title={record.path}
              >
                {record.path}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LogSection() {
  const agents = useConfigStore((state) => state.agents);
  const agentNames = useMemo(
    () =>
      new Map(
        agents.flatMap((agent) =>
          agent.display_name ? [[agent.id, agent.display_name] as const] : [],
        ),
      ),
    [agents],
  );
  const [filters, setFilters] = useState<LogFilters>(NO_FILTERS);
  const [log, setLog] = useState<LogState>({ kind: "loading" });
  const operation = useRef<AbortController | null>(null);

  const load = useCallback(async (applied: LogFilters) => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    // A newer request or an unmount replaces `operation.current`; a timeout
    // only aborts the controller, so it still reaches the error state.
    const superseded = () => operation.current !== controller;
    const timeout = setTimeout(() => controller.abort(), LOG_TIMEOUT_MS);
    setLog({ kind: "loading" });
    try {
      const response = await fetch(
        withQueryParams(API_ENDPOINTS.egressBroker.logs, {
          requester: applied.user.trim(),
          agent_name: applied.agent.trim(),
          host: applied.host.trim(),
          service: applied.service.trim(),
        }),
        { credentials: "same-origin", signal: controller.signal },
      );
      if (superseded()) return;
      if (response.status === 409) {
        setLog({ kind: "not-running" });
        return;
      }
      if (!response.ok) {
        setLog({ kind: "error" });
        return;
      }
      const payload = (await response.json()) as { records: AuditRecord[] };
      if (!superseded()) setLog({ kind: "ready", records: payload.records });
    } catch {
      if (!superseded()) setLog({ kind: "error" });
    } finally {
      clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    void load(NO_FILTERS);
    return () => {
      operation.current?.abort();
      operation.current = null;
    };
  }, [load]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void load(filters);
  };

  const filterInput = (field: keyof LogFilters, label: string) => (
    <Input
      aria-label={`Filter by ${label.toLowerCase()}`}
      placeholder={label}
      className="h-9 w-40"
      value={filters[field]}
      onChange={(event) =>
        setFilters((previous) => ({ ...previous, [field]: event.target.value }))
      }
    />
  );

  return (
    <section aria-labelledby="egress-log-heading" className="space-y-2">
      <h3 id="egress-log-heading" className="text-sm font-medium">
        Request log
      </h3>
      <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
        {filterInput("user", "User")}
        {filterInput("agent", "Agent")}
        {filterInput("host", "Host")}
        {filterInput("service", "Service")}
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={log.kind === "loading"}
        >
          <RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Refresh
        </Button>
      </form>
      {log.kind === "loading" && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading request log...
        </p>
      )}
      {log.kind === "not-running" && (
        <Alert className="p-2">
          <AlertDescription>{NOT_RUNNING_MESSAGE}</AlertDescription>
        </Alert>
      )}
      {log.kind === "error" && (
        <Alert variant="destructive" className="p-2">
          <AlertDescription>{LOG_ERROR_MESSAGE}</AlertDescription>
        </Alert>
      )}
      {log.kind === "ready" && (
        <LogTable records={log.records} agentNames={agentNames} />
      )}
      {/* The CA only exists while the broker runs, so the link would 409. */}
      {log.kind === "not-running" ? (
        <Button size="sm" variant="outline" disabled>
          <Download className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Download CA certificate
        </Button>
      ) : (
        <Button asChild size="sm" variant="outline">
          <a href={API_ENDPOINTS.egressBroker.caPem} download>
            <Download className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            Download CA certificate
          </a>
        </Button>
      )}
    </section>
  );
}

/** The keys and accounts of the shared agents and of the agents without a scope, plus the request log. */
export function EgressBroker() {
  const agents = useConfigStore((state) => state.agents);
  const config = useConfigStore((state) => state.config);
  const defaults = config?.defaults;
  const [selected, setSelected] = useState<string | null>(null);

  // Brokered traffic only exists for agents that can run commands. Shared
  // agents come first, each with keys of its own. All agents without a worker
  // scope share one set of keys, so they are one option, offered only when
  // such an agent exists.
  const targets = useMemo(() => {
    const commandAgents = agents.filter((agent) =>
      canUseEgress(agent, defaults),
    );
    const shared = commandAgents
      .filter((agent) => keyScope(agent, defaults) === "shared")
      .map((agent) => ({
        value: agent.id,
        label: agent.display_name || agent.id,
      }));
    const hasUnscoped = commandAgents.some(
      (agent) => keyScope(agent, defaults) === "unscoped",
    );
    return hasUnscoped
      ? [...shared, { value: UNSCOPED_VALUE, label: UNSCOPED_OPTION }]
      : shared;
  }, [agents, defaults]);
  // The first target is the default, and the fallback when the selected one
  // disappears from the config.
  const target = targets.find((item) => item.value === selected) ?? targets[0];
  const agentName =
    target === undefined || target.value === UNSCOPED_VALUE
      ? null
      : target.value;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-xl">Agent API keys and accounts</CardTitle>
        <CardDescription>
          API keys and connected accounts the broker injects into outbound
          requests from agent workers. Keys are write-only and never shown
          again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="egress-key-target" className="text-sm font-medium">
            Keys for
          </label>
          <select
            id="egress-key-target"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={target?.value ?? UNSCOPED_VALUE}
            disabled={targets.length === 0}
            onChange={(event) => setSelected(event.target.value)}
          >
            {targets.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        {/* Keyed so an unsaved secret never carries over to another target. */}
        <ServiceSection
          key={agentName === null ? "global" : `agent:${agentName}`}
          agentName={agentName}
          agentLabel={
            agentName === null ? UNSCOPED_AGENTS : (target?.label ?? agentName)
          }
          keysUnused={target === undefined && config !== null}
        />
        <LogSection />
      </CardContent>
    </Card>
  );
}
