import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type EditorContext,
  type EditorOptions,
  type EgressServiceForm,
  type RuleFieldPart,
  type RuleForm,
  NOT_EXPLICITLY_EMPTY,
  emptyRule,
  formFromService,
  looksLikeGithub,
  presetOf,
  ruleField,
  scopeNote,
  suggestedName,
  usesMoreOptions,
  usesOwnRules,
} from "./egressServiceModel";
import { githubHelperChanges, GithubHelper } from "./EgressGithubHelper";
import type { HelperLabels } from "./EgressGithubHelper";
import { MoreOptions } from "./EgressMoreOptions";
import {
  Field,
  RuleHostField,
  RuleSendFields,
  type RuleEditing,
  inputClass,
  selectClass,
} from "./EgressRuleFields";
import { useServiceSubmit } from "./useServiceSubmit";
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
      : { ...opened, name: suggestedName(opened, openedWithNames) };
  });
  const [apiKey, setApiKey] = useState("");
  const [moreOpen, setMoreOpen] = useState(() => usesMoreOptions(form));
  const loadPresetsRef = useRef(loadPresets);
  const openedWith = useRef(form);
  const helperLabels = useRef<HelperLabels>({
    displayName: "",
    description: "",
  });
  const settings = { editing, takenNames: openedWithNames };
  const {
    formRef,
    problems,
    busy,
    serverError,
    confirmingSave,
    setConfirmingSave,
    confirmingDelete,
    setConfirmingDelete,
    saved,
    submit,
    remove,
  } = useServiceSubmit({
    form,
    options,
    settings,
    service,
    apiKey,
    saveWarning,
    onSave,
    saveKey,
    onSaved,
    onDelete,
    openMoreOptions: () => setMoreOpen(true),
  });
  const dirty = useMemo(
    () =>
      JSON.stringify(form) !== JSON.stringify(openedWith.current) ||
      apiKey !== "",
    [form, apiKey],
  );
  const nameLocked = editing || saved;
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

  const set = (changes: Partial<EgressServiceForm>) => {
    setConfirmingSave(false);
    setForm((previous) => {
      const next = { ...previous, ...changes };
      return nameLocked || nameTyped || "name" in changes
        ? next
        : { ...next, name: suggestedName(next, openedWithNames) };
    });
  };
  const setRule = (index: number, rule: RuleForm) => {
    const rules = [...form.rules];
    rules[index] = rule;
    set({ rules });
  };

  const preset = presetOf(presets, form.preset);
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
  const showGithubHelper = looksLikeGithub(form);
  const note =
    context === "personal" && agentName !== undefined
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

  const applyGithubRules = (result: {
    rules: EgressRule[];
    repositories: string[];
  }) => {
    const { changes, written } = githubHelperChanges(
      form,
      result,
      helperLabels.current,
    );
    helperLabels.current = written;
    // The helper fixed the name along with the rules, so a later edit of the host does not rename it.
    if (form.name !== "") setNameTyped(true);
    // What was generated sits under More options, so show it.
    setMoreOpen(true);
    set(changes);
  };

  return (
    <form
      ref={formRef}
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
      {usesOwnRules(form) && (
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
          <MoreOptions
            id={`${id}-more`}
            form={form}
            set={set}
            problemAt={problemAt}
            disabled={disabled}
            context={context}
            sharedTarget={sharedTarget}
            preset={preset}
            onGithub={showGithubHelper}
            configPlaceholders={configPlaceholders}
            ruleEditing={ruleEditing}
          />
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
