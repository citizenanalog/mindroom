import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { administratorLimitNote } from "./accountCopy";
import {
  type EditorContext,
  type EgressServiceForm,
  type RuleForm,
  emptyRule,
  usesOwnRules,
} from "./egressServiceForm";
import { MAX_RULES } from "./egressServiceValidation";
import {
  ExtraRule,
  Field,
  RulePathAndPortFields,
  type RuleEditing,
  errorClass,
  inputClass,
  selectClass,
} from "./EgressRuleFields";
import { PlaceholderRows } from "./EgressPlaceholderRows";
import type {
  EgressOAuthProviderOption,
  EgressPreset,
  EgressScope,
} from "./types";

// What "Refuse other paths" does, in the order spec 12.4 gives it. The second
// sentence is about a user's own services, so the dashboard leaves it out. The
// restriction applies to everyone the store serves, so it says who that is.
const RESTRICT_HELP = {
  refusal:
    "Requests to these hosts whose path matches none of your rules are refused (path_not_allowed) instead of being sent without a key.",
  boundary:
    "The real boundary is the key itself, so scope it as narrowly as the website allows.",
  github:
    "GraphQL (/graphql) is refused unless listed, and a listed GraphQL rule reaches every repository the key can reach. Use a fine-grained token or a GitHub App installed on selected repositories.",
};

function restrictHelp(
  context: EditorContext,
  scope: EgressScope | undefined,
  onGithub: boolean,
): string {
  return [
    RESTRICT_HELP.refusal,
    // Without the scope there is no saying whom the limit reaches.
    context === "personal" && scope !== undefined
      ? administratorLimitNote(scope)
      : null,
    RESTRICT_HELP.boundary,
    onGithub ? RESTRICT_HELP.github : null,
  ]
    .filter((sentence) => sentence !== null)
    .join(" ");
}

/**
 * Everything the basic form leaves out: display name and description, the
 * preset's rules, paths and extra rules, the restriction, the account login,
 * and the placeholders.
 */
export function MoreOptions({
  id,
  form,
  set,
  problemAt,
  disabled,
  context,
  scope,
  sharedTarget,
  preset,
  providers,
  onGithub,
  configPlaceholders,
  ruleEditing,
  newService,
}: {
  /** The id of the section, which the toggle controls. */
  id: string;
  form: EgressServiceForm;
  set: (changes: Partial<EgressServiceForm>) => void;
  problemAt: (field: string) => string | undefined;
  disabled: boolean;
  context: EditorContext;
  /** Whose store the service lives in, for whom its restriction also limits the administrator's services. */
  scope: EgressScope | undefined;
  /** Shared and unscoped agents cannot use personal accounts. */
  sharedTarget: boolean;
  preset: EgressPreset | undefined;
  /** The account logins a custom service can use. */
  providers: readonly EgressOAuthProviderOption[];
  /** The service is on GitHub, so the help adds what GraphQL does. */
  onGithub: boolean;
  configPlaceholders: Readonly<Record<string, string>>;
  ruleEditing: (index: number, rule: RuleForm) => RuleEditing;
  /** The service is being added, so an empty display name is saved as its host; an edited one keeps none. */
  newService: boolean;
}) {
  const isPersonal = context === "personal";
  const primaryRule = form.rules[0] ?? emptyRule();
  const primaryHost = primaryRule.host.trim().toLowerCase();
  const displayNameHint = preset
    ? `Leave empty to use ${preset.display_name}.`
    : primaryHost && newService
      ? `Leave empty to use ${primaryHost}.`
      : undefined;
  const rulesProblem = problemAt("rules");
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
            : "Users can connect an account of this kind instead of an API key. Leave it empty to use an API key."
        }
        error={problemAt("oauthProvider")}
      >
        {(control) => (
          <select
            {...control}
            className={`${selectClass} max-w-xs`}
            value={sharedTarget ? "" : form.oauthProvider}
            disabled={sharedTarget || disabled}
            onChange={(event) => set({ oauthProvider: event.target.value })}
          >
            <option value="">No account login</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.display_name}
              </option>
            ))}
            {/* A login the service already has that the server does not list stays selectable. */}
            {form.oauthProvider !== "" &&
              !providers.some(
                (provider) => provider.id === form.oauthProvider,
              ) && (
                <option value={form.oauthProvider}>{form.oauthProvider}</option>
              )}
          </select>
        )}
      </Field>
    )
  );

  return (
    <div id={id} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Display name" id={`${id}-display`} hint={displayNameHint}>
          {(control) => (
            <Input
              {...control}
              className={inputClass}
              value={form.displayName}
              disabled={disabled}
              onChange={(event) => set({ displayName: event.target.value })}
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
              onChange={(event) => set({ description: event.target.value })}
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

      {usesOwnRules(form) && (
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
          {rulesProblem && (
            // No field holds this problem, so the message takes the focus.
            <p tabIndex={-1} data-problem-focus="" className={errorClass}>
              {rulesProblem}
            </p>
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
            onChange={(event) => set({ restrictToRules: event.target.checked })}
          />
          <span className="font-medium">Refuse other paths on these hosts</span>
        </label>
        <p className="pl-6 text-xs text-muted-foreground">
          {restrictHelp(context, scope, onGithub)}
        </p>
      </div>

      {loginField}

      <PlaceholderRows
        form={form}
        set={set}
        problemAt={problemAt}
        disabled={disabled}
        context={context}
        preset={preset}
        configPlaceholders={configPlaceholders}
      />
    </div>
  );
}
