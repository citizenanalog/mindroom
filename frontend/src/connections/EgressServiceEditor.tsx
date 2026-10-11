import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AUTH_CHOICES,
  BROKERED_PLACEHOLDER,
  DEFAULT_TEMPLATE,
  type EditorContext,
  type EditorOptions,
  type EgressServiceForm,
  type PlaceholderForm,
  type RuleAuthChoice,
  type RuleFieldPart,
  type RuleForm,
  type ServiceProblem,
  MAX_RULES,
  NOT_EXPLICITLY_EMPTY,
  applyAuthChoice,
  configPlaceholderWarning,
  emptyRule,
  formFromService,
  githubLimitLabels,
  githubRepositoryRules,
  looksLikeGithub,
  placeholderField,
  presetOf,
  ruleField,
  ruleFormFrom,
  scopeNote,
  serializeService,
  suggestedName,
  usesMoreOptions,
  usesOwnRules,
  validateService,
} from "./egressServiceModel";
import type {
  AuthoredEgressService,
  EgressPreset,
  EgressRule,
  EgressRuleSummary,
  EgressScope,
} from "./types";

/** A rule as a short host and path, such as `www.googleapis.com/drive/`. */
function ruleCoverage(rule: EgressRuleSummary): string {
  const path = rule.path_prefix === "/" ? "" : rule.path_prefix;
  return `${rule.host}${rule.port === null ? "" : `:${rule.port}`}${path}`;
}

const GITHUB_PLACEHOLDER_NAMES = ["GH_TOKEN", "GITHUB_TOKEN"];
const brokered = (name: string): PlaceholderForm => ({
  name,
  value: BROKERED_PLACEHOLDER,
});

// What "Refuse other paths" does, in the order spec 12.4 gives it. The second
// sentence is about a user's own services, so the dashboard leaves it out.
const RESTRICT_HELP = {
  refusal:
    "Requests to these hosts whose path matches none of your rules are refused (path_not_allowed) instead of being sent without a key.",
  administrator:
    "This also limits services from your administrator on these hosts, for this agent only.",
  boundary:
    "The real boundary is the key itself, so scope it as narrowly as the website allows.",
  github:
    "GraphQL (/graphql) is refused unless listed, and a listed GraphQL rule reaches every repository the key can reach. Use a fine-grained token or a GitHub App installed on selected repositories.",
};

function restrictHelp(context: EditorContext, onGithub: boolean): string {
  return [
    RESTRICT_HELP.refusal,
    context === "personal" ? RESTRICT_HELP.administrator : null,
    RESTRICT_HELP.boundary,
    onGithub ? RESTRICT_HELP.github : null,
  ]
    .filter((sentence) => sentence !== null)
    .join(" ");
}

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm aria-invalid:border-destructive";
const inputClass = "h-9 aria-invalid:border-destructive";
const errorClass = "text-xs text-destructive";
const warningClass = "text-xs text-amber-700 dark:text-amber-400";

/** What a control needs to point at the hint and the error its field shows. */
interface ControlProps {
  id: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
}

function Field({
  label,
  id,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  id: string;
  hint?: string;
  error?: string;
  children: (control: ControlProps) => ReactNode;
  className?: string;
}) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter((part) => part !== null)
    .join(" ");
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      {children({
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy || undefined,
      })}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className={errorClass}>
          {error}
        </p>
      )}
    </div>
  );
}

/** How a rule is edited: the first rule in the basic fields, the others in full under More options. */
interface RuleEditing {
  index: number;
  rule: RuleForm;
  onChange: (rule: RuleForm) => void;
  errorFor: (part: RuleFieldPart) => string | undefined;
  disabled: boolean;
  /** An extra rule, whose fields say which rule they belong to. */
  extra: boolean;
}

function RuleHostField({
  index,
  rule,
  onChange,
  errorFor,
  disabled,
  extra,
}: RuleEditing) {
  const id = useId();
  return (
    <Field
      id={`${id}-host`}
      label={extra ? "Host" : "Website"}
      hint="For example api.example.com, or *.example.com for every subdomain"
      error={errorFor("host")}
    >
      {(control) => (
        <Input
          {...control}
          aria-label={extra ? `Rule ${index + 1} host` : undefined}
          className={inputClass}
          value={rule.host}
          disabled={disabled}
          onChange={(event) => onChange({ ...rule, host: event.target.value })}
        />
      )}
    </Field>
  );
}

function RulePathAndPortFields({
  index,
  rule,
  onChange,
  errorFor,
  disabled,
  extra,
}: RuleEditing) {
  const id = useId();
  return (
    <>
      <Field
        id={`${id}-path`}
        label="Path prefix"
        error={errorFor("pathPrefix")}
      >
        {(control) => (
          <Input
            {...control}
            aria-label={extra ? `Rule ${index + 1} path prefix` : undefined}
            placeholder="/ (every path)"
            className={inputClass}
            value={rule.pathPrefix}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...rule, pathPrefix: event.target.value })
            }
          />
        )}
      </Field>
      <Field id={`${id}-port`} label="Port" error={errorFor("port")}>
        {(control) => (
          <Input
            {...control}
            aria-label={extra ? `Rule ${index + 1} port` : undefined}
            inputMode="numeric"
            placeholder="any"
            className={inputClass}
            value={rule.port}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...rule, port: event.target.value })
            }
          />
        )}
      </Field>
    </>
  );
}

/** How the rule sends the key, with the fields that way needs. */
function RuleSendFields({
  index,
  rule,
  onChange,
  errorFor,
  disabled,
  extra,
}: RuleEditing) {
  const id = useId();
  const named = ["header", "template", "query"].includes(rule.authType);
  const ariaLabel = (part: string) =>
    extra ? `Rule ${index + 1} ${part}` : undefined;
  return (
    <>
      <Field id={`${id}-auth`} label="Send the key as">
        {(control) => (
          <select
            {...control}
            aria-label={ariaLabel("auth type")}
            className={selectClass}
            value={rule.authType}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                applyAuthChoice(rule, event.target.value as RuleAuthChoice),
              )
            }
          >
            {AUTH_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      {rule.authType === "basic" && (
        <Field
          id={`${id}-username`}
          label="Username"
          error={errorFor("username")}
        >
          {(control) => (
            <Input
              {...control}
              aria-label={ariaLabel("username")}
              className={inputClass}
              value={rule.username}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...rule, username: event.target.value })
              }
            />
          )}
        </Field>
      )}
      {named && (
        <Field
          id={`${id}-name`}
          label={rule.authType === "query" ? "Parameter name" : "Header name"}
          hint={
            rule.authType === "query"
              ? "For example api_key"
              : "For example X-Api-Key"
          }
          error={errorFor("authName")}
        >
          {(control) => (
            <Input
              {...control}
              aria-label={ariaLabel(
                rule.authType === "query" ? "parameter name" : "header name",
              )}
              className={inputClass}
              value={rule.headerOrParam}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...rule, headerOrParam: event.target.value })
              }
            />
          )}
        </Field>
      )}
      {(rule.authType === "template" || rule.authType === "query") && (
        <Field
          id={`${id}-template`}
          label="Value template"
          error={errorFor("template")}
        >
          {(control) => (
            <Input
              {...control}
              aria-label={ariaLabel("template")}
              placeholder={DEFAULT_TEMPLATE}
              className={inputClass}
              value={rule.template}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...rule, template: event.target.value })
              }
            />
          )}
        </Field>
      )}
    </>
  );
}

/** A rule beyond the first, with all its fields. */
function ExtraRule(
  props: Omit<RuleEditing, "extra"> & { onRemove: () => void },
) {
  const { onRemove, ...editing } = props;
  const label = `Rule ${editing.index + 1}`;
  const shown = { ...editing, extra: true };
  return (
    <li
      aria-label={label}
      className="space-y-3 rounded-md border border-border/60 p-3"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{label}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Remove ${label}`}
          disabled={editing.disabled}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <RuleHostField {...shown} />
        <RulePathAndPortFields {...shown} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <RuleSendFields {...shown} />
      </div>
    </li>
  );
}

function GithubHelper({
  onApply,
}: {
  onApply: (result: { rules: EgressRule[]; repositories: string[] }) => void;
}) {
  const id = useId();
  const [repositories, setRepositories] = useState("");
  const [uploads, setUploads] = useState(false);
  const [graphql, setGraphql] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const apply = () => {
    const result = githubRepositoryRules(repositories, { uploads, graphql });
    setErrors(result.errors);
    if (result.errors.length === 0) onApply(result);
  };

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3"
    >
      <div className="space-y-1">
        <h4 id={`${id}-heading`} className="text-sm font-medium">
          Limit to repositories
        </h4>
        <p className="text-xs text-muted-foreground">
          One repository per line, as owner/repo, or owner/* for everything an
          owner has. Applying replaces this service's rules with rules for just
          those repositories (API and git over HTTPS) and refuses every other
          path on GitHub. Other API paths, such as /user or search, stop
          working. Matching is case sensitive, so write names as they appear in
          GitHub URLs.
        </p>
      </div>
      <Textarea
        aria-label="GitHub repositories"
        placeholder={"basnijholt/agent-cli\nmindroom-ai/*"}
        rows={3}
        className="font-mono text-xs"
        value={repositories}
        onChange={(event) => setRepositories(event.target.value)}
      />
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={uploads}
          onChange={(event) => setUploads(event.target.checked)}
        />
        <span>
          Also allow uploads.github.com for these repositories (release assets)
        </span>
      </label>
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={graphql}
          onChange={(event) => setGraphql(event.target.checked)}
        />
        <span>
          Also allow GraphQL (/graphql). GraphQL reaches every repository the
          key can reach, not just the ones listed.
        </span>
      </label>
      {errors.length > 0 && (
        <Alert variant="destructive" className="p-2">
          <AlertDescription>
            <ul className="list-disc pl-4">
              {errors.map((error, index) => (
                <li key={`${index}-${error}`}>{error}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <Button type="button" size="sm" variant="outline" onClick={apply}>
        Use these repositories
      </Button>
    </section>
  );
}

export interface EgressServiceEditorProps {
  /** The service as authored, or `null` to add one. */
  service: AuthoredEgressService | null;
  /** The name of the service being edited; it cannot change. Omit it to add one. */
  name?: string;
  /** Add mode only: start with this preset, as a typed choice. */
  initialPreset?: string;
  /** Add mode only: start with this name; it counts as typed, so it is never replaced by a suggestion. */
  initialName?: string;
  context: EditorContext;
  /** Shared and unscoped agents cannot use personal accounts. */
  sharedTarget?: boolean;
  /** Names a new service cannot take. */
  takenNames?: readonly string[];
  /**
   * Variable name to the display name of the administrator's service that sets
   * it in the sandbox. A placeholder with one of these names gets a warning,
   * since the administrator's value wins. Leave it out on the dashboard.
   */
  configPlaceholders?: Readonly<Record<string, string>>;
  /** Whose store the service lives in, and the agent it is being added to, for the note under the title. */
  scope?: EgressScope;
  agentName?: string;
  /** For a `user` scope: the display names of the agents that share the store. */
  scopeAgents?: readonly string[];
  /** Fetch the server's presets when the form opens. */
  loadPresets: (signal: AbortSignal) => Promise<EgressPreset[]>;
  /**
   * Said before a save when saving has a wider effect, such as writing other
   * unsaved settings too; the user confirms once before the save goes out.
   */
  saveWarning?: string | null;
  /** Called when the form starts or stops differing from what it opened with. */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Save the service; reject with an Error whose message is shown in the form.
   * With `saveKey`, do not close the editor here: `onSaved` does that once the
   * key is saved too.
   */
  onSave: (name: string, service: AuthoredEgressService) => Promise<void>;
  /**
   * Save the API key typed in the form for the service of that name, called
   * after `onSave` succeeds and only when a key was typed. Without it the form
   * has no key field. When it rejects, the service stays saved and the form
   * says that only the key failed.
   */
  saveKey?: (key: string, name: string) => Promise<void>;
  /** Called once the service, and its key when one was typed, are saved. */
  onSaved?: () => void;
  /** Delete the service being edited; reject like `onSave`. Without it there is no delete button. */
  onDelete?: () => Promise<void>;
  onCancel: () => void;
}

/** The message of a rejection, or `fallback` when it has none. */
function reasonOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** Fields the basic form shows; a problem with any other opens More options. */
function isBasicField(field: string): boolean {
  return (
    field === "name" || /^rule:0:(host|username|authName|template)$/.test(field)
  );
}

/**
 * Form for one egress service: its preset or rules, placeholders, and limits.
 *
 * Used on the personal Connections page (the caller's own services) and on the
 * dashboard (services in config.yaml). It always hands back the authored form.
 * The basic fields come first; everything else sits under More options.
 */
export function EgressServiceEditor({
  service,
  name,
  initialPreset,
  initialName,
  context,
  sharedTarget = false,
  takenNames = [],
  configPlaceholders = {},
  scope,
  agentName,
  scopeAgents = [],
  loadPresets,
  saveWarning = null,
  onDirtyChange,
  onSave,
  saveKey,
  onSaved,
  onDelete,
  onCancel,
}: EgressServiceEditorProps) {
  const id = useId();
  const editing = name !== undefined;
  // `null` while the presets load, then the server's list (empty when it could not be loaded).
  const [presets, setPresets] = useState<EgressPreset[] | null>(null);
  const [presetsFailed, setPresetsFailed] = useState(false);
  const options: EditorOptions = { context, sharedTarget, presets };
  // Checked against the names the editor opened with: a save that is still
  // running may already have written this name into the page's own list.
  const [openedWithNames] = useState(takenNames);
  // A new service is named after its preset or host until the user types a name.
  const [nameTyped, setNameTyped] = useState(
    !editing && initialName !== undefined && initialName !== "",
  );
  const [form, setForm] = useState(() => {
    const opened = formFromService(
      name ?? initialName ?? "",
      service ?? (!editing && initialPreset ? { preset: initialPreset } : null),
    );
    return editing || nameTyped
      ? opened
      : { ...opened, name: suggestedName(opened) };
  });
  const [apiKey, setApiKey] = useState("");
  // The service as last written, so a retry after a failed key does not write it again.
  const [savedSignature, setSavedSignature] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(() => usesMoreOptions(form));
  const [attempted, setAttempted] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingSave, setConfirmingSave] = useState(false);
  const formElement = useRef<HTMLFormElement>(null);
  const loadPresetsRef = useRef(loadPresets);
  const openedWith = useRef(form);
  // What the GitHub helper wrote into the labels, which it may rewrite on the next apply.
  const helperLabels = useRef({ displayName: "", description: "" });
  const dirty = useMemo(
    () =>
      JSON.stringify(form) !== JSON.stringify(openedWith.current) ||
      apiKey !== "",
    [form, apiKey],
  );
  const nameLocked = editing || savedSignature !== null;
  const disabled = busy !== null;

  useEffect(() => {
    const controller = new AbortController();
    loadPresetsRef
      .current(controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setPresets(loaded);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setPresets([]);
        setPresetsFailed(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // After a failed save, the first field marked invalid in page order gets focus.
  useEffect(() => {
    if (focusRequest === 0) return;
    formElement.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ?.focus();
  }, [focusRequest]);

  const set = (changes: Partial<EgressServiceForm>) => {
    setConfirmingSave(false);
    setForm((previous) => {
      const next = { ...previous, ...changes };
      return nameLocked || nameTyped || "name" in changes
        ? next
        : { ...next, name: suggestedName(next) };
    });
  };
  const setRule = (index: number, rule: RuleForm) => {
    const rules = [...form.rules];
    rules[index] = rule;
    set({ rules });
  };
  const setPlaceholder = (index: number, placeholder: PlaceholderForm) =>
    set({
      placeholders: form.placeholders.map((existing, i) =>
        i === index ? placeholder : existing,
      ),
    });

  const preset = presetOf(presets, form.preset);
  const settings = { editing, takenNames: openedWithNames };
  const problems: ServiceProblem[] = attempted
    ? validateService(form, options, settings)
    : [];
  const problemAt = (field: string) =>
    problems.find((problem) => problem.field === field)?.message;
  // The size of the whole service belongs to no field, so it is the one problem told in the alert.
  const generalErrors =
    problems.length > 0
      ? problems
          .filter((problem) => problem.field === "form")
          .map((problem) => problem.message)
      : serverError
        ? [serverError]
        : [];
  const title = editing ? `Edit ${name}` : "Add service";
  const isPersonal = context === "personal";
  const showGithubHelper = looksLikeGithub(form);
  const note =
    isPersonal && agentName !== undefined
      ? scopeNote(scope, agentName, scopeAgents)
      : null;
  const primaryRule = form.rules[0] ?? emptyRule();
  const ruleEditing = (index: number, rule: RuleForm): RuleEditing => ({
    index,
    rule,
    onChange: (next) => setRule(index, next),
    errorFor: (part: RuleFieldPart) => problemAt(ruleField(index, part)),
    disabled,
    extra: index > 0,
  });

  // Another preset has its own defaults, so what the loaded service emptied on
  // purpose no longer applies to it.
  const choosePreset = (value: string) =>
    set({
      preset: value,
      replacePresetRules: false,
      rules: form.rules.length > 0 ? form.rules : [emptyRule()],
      explicitlyEmpty: NOT_EXPLICITLY_EMPTY,
    });

  const applyGithubRules = ({
    rules,
    repositories,
  }: {
    rules: EgressRule[];
    repositories: string[];
  }) => {
    // The GitHub preset sets these for the tools that read them; a custom
    // service has to name them itself, unless it already sets some.
    const addPlaceholders =
      form.preset === "" && form.placeholders.length === 0;
    const labels = githubLimitLabels(repositories);
    const filled = helperLabels.current;
    // Labels the user wrote stay; the ones the last apply wrote follow the new repositories.
    const fillDisplayName =
      form.displayName.trim() === "" || form.displayName === filled.displayName;
    const fillDescription =
      form.description.trim() === "" || form.description === filled.description;
    if (fillDisplayName) filled.displayName = labels.displayName;
    if (fillDescription) filled.description = labels.description;
    // What was generated sits under More options, so show it.
    setMoreOpen(true);
    set({
      rules: rules.map(ruleFormFrom),
      replacePresetRules: form.preset !== "",
      restrictToRules: true,
      ...(fillDisplayName ? { displayName: labels.displayName } : {}),
      ...(fillDescription ? { description: labels.description } : {}),
      ...(addPlaceholders
        ? { placeholders: GITHUB_PLACEHOLDER_NAMES.map(brokered) }
        : {}),
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setAttempted(true);
    setServerError(null);
    const found = validateService(form, options, settings);
    if (found.length > 0) {
      if (
        found.some(
          (problem) => problem.field !== "form" && !isBasicField(problem.field),
        )
      )
        setMoreOpen(true);
      setFocusRequest((count) => count + 1);
      return;
    }
    if (saveWarning && !confirmingSave) {
      setConfirmingSave(true);
      return;
    }
    setConfirmingSave(false);
    setBusy("save");
    const authored = serializeService(form, options, service);
    const signature = JSON.stringify([form.name, authored]);
    try {
      // The service goes first, and the key only after it is written.
      if (signature !== savedSignature) {
        await onSave(form.name, authored);
        setSavedSignature(signature);
      }
    } catch (cause) {
      setServerError(reasonOf(cause, "Could not save the service. Try again."));
      setBusy(null);
      return;
    }
    if (saveKey && apiKey.trim() !== "") {
      try {
        await saveKey(apiKey, form.name);
      } catch (cause) {
        const reason = reasonOf(cause, "Could not save the key.");
        setServerError(
          `The service was saved, but its key was not: ${reason}${reason.endsWith(".") ? "" : "."} Paste the key again and save to retry.`,
        );
        setBusy(null);
        return;
      }
    }
    onSaved?.();
  };

  const remove = async () => {
    if (!onDelete) return;
    setBusy("delete");
    setServerError(null);
    try {
      await onDelete();
    } catch (cause) {
      setServerError(
        reasonOf(cause, "Could not delete the service. Try again."),
      );
      setBusy(null);
      setConfirmingDelete(false);
    }
  };

  const showWebsite = usesOwnRules(form);
  const loginField = preset?.oauth_provider ? (
    <p className="text-xs text-muted-foreground">
      {sharedTarget
        ? "Accounts cannot be connected on a shared agent, so this service uses an API key."
        : `Users can connect an account (${preset.oauth_provider}) instead of an API key.`}
    </p>
  ) : (
    !preset && (
      <Field
        label="Account login (optional)"
        id={`${id}-oauth`}
        hint={
          sharedTarget
            ? "Accounts cannot be connected on a shared agent. Use an API key."
            : "The id of an OAuth provider MindRoom knows, such as github, google_drive, or atlassian. Leave empty to use an API key."
        }
        error={problemAt("oauthProvider")}
      >
        {(control) => (
          <Input
            {...control}
            className={`${inputClass} max-w-xs`}
            value={sharedTarget ? "" : form.oauthProvider}
            disabled={sharedTarget || disabled}
            onChange={(event) => set({ oauthProvider: event.target.value })}
          />
        )}
      </Field>
    )
  );

  return (
    <form
      ref={formElement}
      aria-label={title}
      noValidate
      className="space-y-5 bg-muted/20 px-5 py-4"
      onSubmit={(event) => void submit(event)}
    >
      <h3 className="font-semibold">{title}</h3>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Name"
          id={`${id}-name`}
          hint={
            editing
              ? "The name cannot be changed."
              : "Lowercase letters, digits, - and _. It cannot be changed later."
          }
          error={problemAt("name")}
        >
          {(control) => (
            <Input
              {...control}
              className={inputClass}
              value={form.name}
              disabled={nameLocked || disabled}
              onChange={(event) => {
                setNameTyped(event.target.value !== "");
                set({ name: event.target.value });
              }}
            />
          )}
        </Field>
        <Field label="Preset" id={`${id}-preset`}>
          {(control) => (
            <select
              {...control}
              className={selectClass}
              value={form.preset}
              disabled={disabled || presets === null}
              onChange={(event) => choosePreset(event.target.value)}
            >
              <option value="">
                {presets === null ? "Loading…" : "Custom"}
              </option>
              {(presets ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.display_name}
                </option>
              ))}
              {form.preset !== "" && !preset && (
                <option value={form.preset}>{form.preset}</option>
              )}
            </select>
          )}
        </Field>
      </div>
      {presetsFailed && (
        <p className="text-xs text-muted-foreground">
          The preset list could not be loaded. You can still use a custom
          service.
        </p>
      )}
      {preset && !form.replacePresetRules && (
        <p className="text-xs text-muted-foreground">
          The {preset.display_name} preset covers{" "}
          {preset.rules.map(ruleCoverage).join(", ")}.
        </p>
      )}
      {showWebsite && (
        <div className="grid gap-3 sm:grid-cols-2">
          <RuleHostField {...ruleEditing(0, primaryRule)} />
          <RuleSendFields {...ruleEditing(0, primaryRule)} />
        </div>
      )}
      {saveKey && (
        <Field
          label="API key"
          id={`${id}-key`}
          hint="Paste the key now or later"
          className="max-w-md"
        >
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="new-password"
              className={inputClass}
              value={apiKey}
              disabled={disabled}
              onChange={(event) => {
                setConfirmingSave(false);
                setApiKey(event.target.value);
              }}
            />
          )}
        </Field>
      )}
      {showGithubHelper && <GithubHelper onApply={applyGithubRules} />}

      <section className="space-y-3">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={moreOpen}
          aria-controls={`${id}-more`}
          onClick={() => setMoreOpen((open) => !open)}
        >
          More options
        </Button>
        {moreOpen && (
          <div id={`${id}-more`} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Display name"
                id={`${id}-display`}
                hint={
                  preset
                    ? `Leave empty to use ${preset.display_name}.`
                    : undefined
                }
              >
                {(control) => (
                  <Input
                    {...control}
                    className={inputClass}
                    value={form.displayName}
                    disabled={disabled}
                    onChange={(event) =>
                      set({ displayName: event.target.value })
                    }
                  />
                )}
              </Field>
              <Field label="Description" id={`${id}-description`}>
                {(control) => (
                  <Input
                    {...control}
                    className={inputClass}
                    value={form.description}
                    disabled={disabled}
                    onChange={(event) =>
                      set({ description: event.target.value })
                    }
                  />
                )}
              </Field>
            </div>

            {preset && (
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={form.replacePresetRules}
                  disabled={disabled}
                  onChange={(event) =>
                    set({
                      replacePresetRules: event.target.checked,
                      rules:
                        event.target.checked && form.rules.length === 0
                          ? [emptyRule()]
                          : form.rules,
                    })
                  }
                />
                <span>Replace the preset's rules with my own</span>
              </label>
            )}

            {showWebsite && (
              <section aria-labelledby={`${id}-rules`} className="space-y-3">
                <h4 id={`${id}-rules`} className="text-sm font-medium">
                  Paths and extra rules
                </h4>
                <div className="grid gap-3 sm:grid-cols-2">
                  <RulePathAndPortFields {...ruleEditing(0, primaryRule)} />
                </div>
                <ul className="space-y-3">
                  {form.rules.slice(1).map((rule, offset) => (
                    <ExtraRule
                      // Rules have no identity beyond their position.
                      key={offset + 1}
                      {...ruleEditing(offset + 1, rule)}
                      onRemove={() =>
                        set({
                          rules: form.rules.filter((_, i) => i !== offset + 1),
                        })
                      }
                    />
                  ))}
                </ul>
                {problemAt("rules") && (
                  <p className={errorClass}>{problemAt("rules")}</p>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    disabled || (isPersonal && form.rules.length >= MAX_RULES)
                  }
                  onClick={() => set({ rules: [...form.rules, emptyRule()] })}
                >
                  Add rule
                </Button>
              </section>
            )}

            <div className="space-y-1">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={form.restrictToRules}
                  disabled={disabled}
                  onChange={(event) =>
                    set({ restrictToRules: event.target.checked })
                  }
                />
                <span className="font-medium">
                  Refuse other paths on these hosts
                </span>
              </label>
              <p className="pl-6 text-xs text-muted-foreground">
                {restrictHelp(context, showGithubHelper)}
              </p>
            </div>

            {loginField}

            <div className="space-y-3">
              <div className="space-y-1">
                <h4 className="text-sm font-medium">Placeholder variables</h4>
                <p className="text-xs text-muted-foreground">
                  Environment variables set in the agent's sandbox so tools find
                  a key to send. Use a fixed value such as{" "}
                  {BROKERED_PLACEHOLDER}; the broker swaps in the real key.
                  {preset
                    ? form.explicitlyEmpty.placeholders
                      ? ` This service sets none, which drops the placeholders of the ${preset.display_name} preset.`
                      : ` Leave the list empty to use the placeholders of the ${preset.display_name} preset.`
                    : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  {isPersonal
                    ? "Names use capital letters, digits, and underscores, and one word between underscores must be TOKEN, KEY, SECRET, PASSWORD, PAT, AUTH, or CREDENTIAL (for example MY_API_KEY). No word may be COMMAND, CMD, FILE, DIR, PROVIDER, HELPER, OPTS, OPTIONS, or EXTENSIONS, and names cannot start with SSH_, MINDROOM_, or GIT_CONFIG_. PATH, HOME, and proxy and CA variables are reserved. Values are 1 to 256 letters, digits, or . _ : -"
                    : "Names use capital letters, digits, and underscores. PATH, HOME, proxy and CA variables, and names starting with MINDROOM_ or GIT_CONFIG_ are reserved."}
                </p>
              </div>
              {form.placeholders.map((placeholder, index) => {
                const nameError = problemAt(placeholderField(index, "name"));
                const valueError = problemAt(placeholderField(index, "value"));
                const warning = nameError
                  ? null
                  : configPlaceholderWarning(
                      placeholder.name,
                      configPlaceholders,
                    );
                const nameNoteId = `${id}-placeholder-${index}-name-note`;
                const valueNoteId = `${id}-placeholder-${index}-value-note`;
                return (
                  <div key={index} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        aria-label={`Placeholder ${index + 1} name`}
                        aria-invalid={nameError ? true : undefined}
                        aria-describedby={
                          nameError || warning ? nameNoteId : undefined
                        }
                        placeholder="MY_API_KEY"
                        className="h-9 w-56 font-mono text-xs aria-invalid:border-destructive"
                        value={placeholder.name}
                        disabled={disabled}
                        onChange={(event) =>
                          setPlaceholder(index, {
                            ...placeholder,
                            name: event.target.value,
                          })
                        }
                      />
                      <Input
                        aria-label={`Placeholder ${index + 1} value`}
                        aria-invalid={valueError ? true : undefined}
                        aria-describedby={valueError ? valueNoteId : undefined}
                        className="h-9 w-56 font-mono text-xs aria-invalid:border-destructive"
                        value={placeholder.value}
                        disabled={disabled}
                        onChange={(event) =>
                          setPlaceholder(index, {
                            ...placeholder,
                            value: event.target.value,
                          })
                        }
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove placeholder ${index + 1}`}
                        disabled={disabled}
                        onClick={() =>
                          set({
                            placeholders: form.placeholders.filter(
                              (_, i) => i !== index,
                            ),
                          })
                        }
                      >
                        Remove
                      </Button>
                    </div>
                    {nameError && (
                      <p id={nameNoteId} className={errorClass}>
                        {nameError}
                      </p>
                    )}
                    {warning && (
                      <p id={nameNoteId} className={warningClass}>
                        {warning}
                      </p>
                    )}
                    {valueError && (
                      <p id={valueNoteId} className={errorClass}>
                        {valueError}
                      </p>
                    )}
                  </div>
                );
              })}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  set({
                    placeholders: [
                      ...form.placeholders,
                      { name: "", value: BROKERED_PLACEHOLDER },
                    ],
                  })
                }
              >
                Add placeholder
              </Button>
            </div>
          </div>
        )}
      </section>

      {generalErrors.length > 0 && (
        <Alert variant="destructive" className="p-2">
          <AlertDescription>
            {generalErrors.length === 1 ? (
              generalErrors[0]
            ) : (
              <ul className="list-disc pl-4">
                {generalErrors.map((error, index) => (
                  <li key={`${index}-${error}`}>{error}</li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      {confirmingSave && saveWarning && (
        <Alert className="p-2">
          <AlertDescription>{saveWarning}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={busy !== null || presets === null}
        >
          {busy === "save" ? (
            <>
              <Loader2
                className="mr-2 h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
              Saving…
            </>
          ) : confirmingSave ? (
            "Save all changes"
          ) : (
            "Save service"
          )}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={confirmingSave ? () => setConfirmingSave(false) : onCancel}
        >
          {confirmingSave ? "Go back" : "Cancel"}
        </Button>
        {editing && onDelete && !confirmingDelete && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={busy !== null}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete service
          </Button>
        )}
        {editing && onDelete && confirmingDelete && (
          <span className="ml-auto flex flex-wrap items-center gap-2 text-xs">
            Delete {name}?{saveWarning ? ` ${saveWarning}` : ""}
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={() => void remove()}
            >
              {busy === "delete" ? "Deleting…" : "Confirm delete"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirmingDelete(false)}
            >
              Keep
            </Button>
          </span>
        )}
      </div>
    </form>
  );
}

/** Asks before the open editor's unsaved changes are thrown away for another action. */
export function DiscardEditsNotice({
  onDiscard,
  onKeep,
}: {
  onDiscard: () => void;
  onKeep: () => void;
}) {
  return (
    <Alert className="m-4 w-auto p-2">
      <AlertDescription className="flex flex-wrap items-center gap-2">
        You have unsaved changes in the open editor.
        <Button size="sm" variant="destructive" onClick={onDiscard}>
          Discard changes
        </Button>
        <Button size="sm" variant="ghost" onClick={onKeep}>
          Keep editing
        </Button>
      </AlertDescription>
    </Alert>
  );
}
