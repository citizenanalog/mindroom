import { formatList } from "./accountCopy";
import type {
  AuthoredEgressService,
  EgressAuth,
  EgressAuthType,
  EgressCredentialService,
  EgressPreset,
  EgressRule,
  EgressScope,
} from "./types";

/**
 * The editor's data model, apart from any rendering: the form state, how it
 * maps to and from a service as authored, what stops it from being saved and
 * which field shows each problem, the GitHub repository rules, and the small
 * texts that depend on the form.
 */

/** Where the editor runs: the personal page, or the dashboard writing config.yaml. */
export type EditorContext = "personal" | "operator";

export interface EditorOptions {
  context: EditorContext;
  /** Shared and unscoped agents cannot use personal accounts, so OAuth is off. */
  sharedTarget: boolean;
  /** The server's presets; `null` while they load, which a shared target treats as "may carry a login". */
  presets: readonly EgressPreset[] | null;
}

export const DEFAULT_TEMPLATE = "{secret}";
export const BROKERED_PLACEHOLDER = "mindroom-brokered";
export const MAX_RULES = 50;
const MAX_SERVICE_BYTES = 16 * 1024;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Headers that frame the message, route it, or authenticate to the proxy belong to the broker.
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
  "keep-alive",
]);
const PLACEHOLDER_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
// The names the broker sets itself, which no service may use as a placeholder
// (the lowercase proxy variables cannot match the name pattern anyway).
const RESERVED_PLACEHOLDER_NAMES = new Set([
  "PATH",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NODE_USE_ENV_PROXY",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "NODE_EXTRA_CA_CERTS",
]);
const RESERVED_PLACEHOLDER_PREFIXES = ["MINDROOM_", "GIT_CONFIG_"];
// Services of a personal scope may only set credential-like placeholders with
// plain values. These mirror `_placeholder_error` in
// src/mindroom/egress_broker/user_services.py, with its words in its order.
const PERSONAL_PLACEHOLDER_NAME = /^[A-Z][A-Z0-9_]*$/;
const PERSONAL_PLACEHOLDER_VALUE = /^[A-Za-z0-9._:-]{1,256}$/;
const PERSONAL_PLACEHOLDER_WORDS = [
  "TOKEN",
  "KEY",
  "SECRET",
  "PASSWORD",
  "PAT",
  "AUTH",
  "CREDENTIAL",
];
// Tools read variables with these words, or starting with SSH_, as programs or
// paths to run or load, so a service of one's own cannot set them.
const PERSONAL_PLACEHOLDER_REFUSED_WORDS = [
  "COMMAND",
  "CMD",
  "FILE",
  "DIR",
  "PROVIDER",
  "HELPER",
  "OPTS",
  "OPTIONS",
  "EXTENSIONS",
];
const PERSONAL_PLACEHOLDER_REFUSED_PREFIX = "SSH_";

const GITHUB_API_HOST = "api.github.com";
const GITHUB_WEB_HOST = "github.com";
const GITHUB_UPLOADS_HOST = "uploads.github.com";
const GITHUB_HOSTS = [GITHUB_API_HOST, GITHUB_WEB_HOST, GITHUB_UPLOADS_HOST];
const GITHUB_REPOSITORY_LINE =
  /^([A-Za-z0-9][A-Za-z0-9-]*)\/(\*|[A-Za-z0-9._-]+)$/;
const GITHUB_MAX_OWNER_LENGTH = 39;
const GITHUB_MAX_REPOSITORY_LENGTH = 100;

/**
 * How a rule sends the key, as the form offers it. A custom template is header
 * auth with a value template, which the wire format does not tell apart.
 */
export type RuleAuthChoice = EgressAuthType | "template";

export const AUTH_CHOICES: readonly { value: RuleAuthChoice; label: string }[] =
  [
    { value: "bearer", label: "Bearer token" },
    { value: "header", label: "Header" },
    { value: "basic", label: "Basic" },
    { value: "query", label: "Query parameter" },
    { value: "template", label: "Custom template" },
  ];

export interface RuleForm {
  host: string;
  port: string;
  pathPrefix: string;
  authType: RuleAuthChoice;
  username: string;
  headerOrParam: string;
  template: string;
}

export interface PlaceholderForm {
  name: string;
  value: string;
}

/**
 * Fields the loaded service set to an empty value on purpose. A preset service
 * can drop the preset's placeholders with `placeholder_env: {}`, so saving the
 * form unchanged has to write that back instead of leaving the key out.
 */
interface ExplicitlyEmpty {
  displayName: "" | null | undefined;
  description: boolean;
  placeholders: boolean;
}

/** No field emptied on purpose: what a new service, or one that picked another preset, starts with. */
export const NOT_EXPLICITLY_EMPTY: ExplicitlyEmpty = {
  displayName: undefined,
  description: false,
  placeholders: false,
};

/** What the editor shows; `serializeService` turns it into the authored service. */
export interface EgressServiceForm {
  name: string;
  /** Empty for a custom service. */
  preset: string;
  displayName: string;
  description: string;
  /** With a preset: replace its rules by the ones below. */
  replacePresetRules: boolean;
  rules: RuleForm[];
  placeholders: PlaceholderForm[];
  restrictToRules: boolean;
  /** A service that only limits paths: no key, account, or placeholders, and rules that never pick a credential. */
  restrictOnly: boolean;
  oauthProvider: string;
  explicitlyEmpty: ExplicitlyEmpty;
}

export function emptyRule(): RuleForm {
  return {
    host: "",
    port: "",
    pathPrefix: "",
    authType: "bearer",
    username: "",
    headerOrParam: "",
    template: "",
  };
}

function hasCustomTemplate(template: string | undefined): boolean {
  return (
    template !== undefined && template !== "" && template !== DEFAULT_TEMPLATE
  );
}

export function ruleFormFrom(rule: EgressRule): RuleForm {
  // A rule of a service that only limits paths has no auth; the form shows the default.
  const auth = rule.auth ?? { type: "bearer" as const };
  return {
    host: rule.host,
    port: rule.port === undefined ? "" : String(rule.port),
    pathPrefix: rule.path_prefix ?? "",
    authType:
      auth.type === "header" && hasCustomTemplate(auth.template)
        ? "template"
        : auth.type,
    username: auth.username ?? "",
    headerOrParam: auth.name ?? "",
    template: auth.template ?? "",
  };
}

/** Build the form for an authored service, or an empty custom service for `null`. */
export function formFromService(
  name: string,
  service: AuthoredEgressService | null,
): EgressServiceForm {
  const preset = service?.preset ?? "";
  const rules = (service?.rules ?? []).map(ruleFormFrom);
  const replacePresetRules = preset !== "" && rules.length > 0;
  const displayName = service?.display_name;
  return {
    name,
    preset,
    displayName: displayName ?? "",
    description: service?.description ?? "",
    replacePresetRules,
    rules:
      preset === "" && rules.length === 0 && !service?.restrict_only
        ? [emptyRule()]
        : rules,
    placeholders: Object.entries(service?.placeholder_env ?? {}).map(
      ([placeholderName, value]) => ({ name: placeholderName, value }),
    ),
    restrictToRules: service?.restrict_to_rules ?? false,
    restrictOnly: service?.restrict_only ?? false,
    oauthProvider: service?.oauth_provider ?? "",
    explicitlyEmpty: {
      displayName:
        displayName === null || displayName === "" ? displayName : undefined,
      description: service?.description === "",
      placeholders:
        service?.placeholder_env !== undefined &&
        Object.keys(service.placeholder_env).length === 0,
    },
  };
}

export function presetOf(
  presets: readonly EgressPreset[] | null,
  id: string,
): EgressPreset | undefined {
  return presets?.find((preset) => preset.id === id);
}

export function usesOwnRules(form: EgressServiceForm): boolean {
  return form.preset === "" || form.replacePresetRules;
}

/** Switch how a rule sends the key; plain Header sends the key as it is, so it drops a custom template. */
export function applyAuthChoice(
  rule: RuleForm,
  authType: RuleAuthChoice,
): RuleForm {
  return {
    ...rule,
    authType,
    template: authType === "header" ? "" : rule.template,
  };
}

function ruleToAuthored(rule: RuleForm): EgressRule {
  const type = rule.authType === "template" ? "header" : rule.authType;
  const auth: EgressAuth = { type };
  if (type === "basic") auth.username = rule.username.trim();
  if (type === "header" || type === "query") {
    auth.name = rule.headerOrParam.trim();
    if (hasCustomTemplate(rule.template)) auth.template = rule.template;
  }
  const authored: EgressRule = { host: rule.host.trim().toLowerCase(), auth };
  if (rule.port.trim() !== "") authored.port = Number(rule.port);
  const pathPrefix = rule.pathPrefix.trim();
  if (pathPrefix !== "" && pathPrefix !== "/")
    authored.path_prefix = pathPrefix;
  return authored;
}

/**
 * The display name a new custom service gets while the form leaves it empty:
 * its website, as the person typed it, not the title-cased name the server
 * would derive. A preset keeps its own, which the server supplies, and so does
 * a service whose display name was emptied on purpose.
 */
function defaultDisplayName(form: EgressServiceForm): string {
  if (form.preset !== "" || form.explicitlyEmpty.displayName !== undefined)
    return "";
  return form.rules[0]?.host.trim().toLowerCase() ?? "";
}

/**
 * Turn the form into the service as authored.
 *
 * A preset service keeps `{preset: id}` and only the fields the user set,
 * because the server expands the preset and later preset updates still apply.
 * `initial` supplies what the form cannot show: the operator-only
 * `oauth_on_shared_workers`, and an OAuth provider override on the same preset.
 * Fields the loaded service emptied on purpose stay empty, so an unchanged
 * save writes the service back as it was.
 */
export function serializeService(
  form: EgressServiceForm,
  options: EditorOptions,
  initial: AuthoredEgressService | null = null,
): AuthoredEgressService {
  const authored: AuthoredEgressService = {};
  // A service that only limits paths has rules of its own, whatever preset the form once held.
  if (form.preset && !form.restrictOnly) authored.preset = form.preset;
  // A service that is edited keeps the display name it has, or none.
  const displayName =
    form.displayName.trim() ||
    (initial === null ? defaultDisplayName(form) : "");
  if (displayName) authored.display_name = displayName;
  else if (form.explicitlyEmpty.displayName !== undefined)
    authored.display_name = form.explicitlyEmpty.displayName;
  if (form.description.trim()) authored.description = form.description.trim();
  else if (form.explicitlyEmpty.description) authored.description = "";
  if (form.restrictOnly) {
    // It sends no key, so its rules carry no auth and there is no login or
    // placeholder to write; the restriction is what it is for.
    authored.rules = form.rules.map((rule) => {
      const { auth: _auth, ...withoutAuth } = ruleToAuthored(rule);
      return withoutAuth;
    });
    authored.restrict_to_rules = true;
    authored.restrict_only = true;
    return authored;
  }
  if (usesOwnRules(form)) authored.rules = form.rules.map(ruleToAuthored);
  const placeholders = form.placeholders.filter(
    (placeholder) => placeholder.name.trim() !== "",
  );
  if (placeholders.length > 0)
    authored.placeholder_env = Object.fromEntries(
      placeholders.map((placeholder) => [
        placeholder.name.trim(),
        placeholder.value,
      ]),
    );
  else if (form.explicitlyEmpty.placeholders) authored.placeholder_env = {};
  if (form.preset === "") {
    if (!options.sharedTarget && form.oauthProvider.trim())
      authored.oauth_provider = form.oauthProvider.trim();
  } else if (options.sharedTarget && presetHasLogin(form.preset, options)) {
    // A shared agent cannot use personal accounts, so the preset's login is dropped.
    authored.oauth_provider = null;
  } else if (
    initial?.oauth_provider !== undefined &&
    form.preset === (initial.preset ?? "")
  ) {
    // An override written for this preset; another preset has its own login.
    authored.oauth_provider = initial.oauth_provider;
  }
  if (form.restrictToRules) authored.restrict_to_rules = true;
  if (
    options.context === "operator" &&
    initial?.oauth_on_shared_workers !== undefined
  )
    authored.oauth_on_shared_workers = initial.oauth_on_shared_workers;
  return authored;
}

/** Whether a preset carries an account login; unknown while the presets are not loaded, so assume it may. */
export function presetHasLogin(
  presetId: string,
  options: Pick<EditorOptions, "presets">,
): boolean {
  if (options.presets === null) return true;
  return presetOf(options.presets, presetId)?.oauth_provider != null;
}

/**
 * What the Website field keeps of what was typed or pasted: the host, without
 * a scheme and cut at the first `/`, `?`, or `#`, and the path that was cut off
 * (up to a `?` or `#`), which belongs in the Path prefix. A copied URL thus
 * becomes its host plus a prefix.
 */
export function splitHostInput(value: string): { host: string; path: string } {
  const scheme = value.indexOf("://");
  const rest = scheme === -1 ? value : value.slice(scheme + 3);
  const end = rest.search(/[/?#]/);
  if (end === -1) return { host: rest, path: "" };
  const path = rest[end] === "/" ? rest.slice(end).split(/[?#]/)[0] : "";
  return { host: rest.slice(0, end), path };
}

function hostError(host: string): string | null {
  const value = host.trim().toLowerCase();
  if (!value) return "Host is required";
  if (value.includes(":"))
    return "Host must not contain a port (use the port field)";
  if (value.startsWith("*.")) {
    const parts = value.split(".");
    if (parts.filter((part) => part === "*").length > 1)
      return "Host can only have one wildcard label";
    if (parts.length < 3)
      return "Wildcard host must have at least one domain part after *.";
  } else if (value.includes("*")) {
    return "Wildcard must be a single leading *. label";
  }
  return null;
}

function templateError(template: string, required: boolean): string | null {
  if (template === "" && !required) return null;
  return template.split(DEFAULT_TEMPLATE).length - 1 === 1
    ? null
    : "Template must contain {secret} exactly once";
}

/** The part of a rule a problem belongs to, so the editor can show it by that field. */
export type RuleFieldPart =
  "host" | "pathPrefix" | "port" | "username" | "authName" | "template";

/** The id of the field that shows a problem with a rule. */
export function ruleField(index: number, part: RuleFieldPart): string {
  return `rule:${index}:${part}`;
}

/** The id of the field that shows a problem with a placeholder row. */
export function placeholderField(
  index: number,
  part: "name" | "value",
): string {
  return `placeholder:${index}:${part}`;
}

/**
 * The parts of the first rule the basic form shows: the website, how the key is
 * sent, and what that way needs. Path prefix and port sit under More options.
 */
export const BASIC_RULE_PARTS: readonly RuleFieldPart[] = [
  "host",
  "username",
  "authName",
  "template",
];

const BASIC_FIELDS: ReadonlySet<string> = new Set([
  "name",
  ...BASIC_RULE_PARTS.map((part) => ruleField(0, part)),
]);

/** Whether the basic form shows the field of a problem; any other opens More options. */
export function isBasicField(field: string): boolean {
  return BASIC_FIELDS.has(field);
}

/**
 * What stops a form from being saved, and where to say so. `field` is `name`,
 * `rules`, `oauthProvider`, a `ruleField`, or a `placeholderField`; `form`
 * means the service as a whole, which no single field shows.
 */
export interface ServiceProblem {
  field: string;
  message: string;
}

function ruleProblems(rule: RuleForm, index: number): ServiceProblem[] {
  const problems: ServiceProblem[] = [];
  const add = (part: RuleFieldPart, message: string | null) => {
    if (message) problems.push({ field: ruleField(index, part), message });
  };
  add("host", hostError(rule.host));
  const pathPrefix = rule.pathPrefix.trim();
  if (pathPrefix !== "" && !pathPrefix.startsWith("/"))
    add("pathPrefix", "Path prefix must start with /");
  const port = rule.port.trim();
  if (port !== "") {
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65535)
      add("port", "Port must be a number from 1 to 65535");
  }
  if (rule.authType === "basic" && !rule.username.trim())
    add("username", "Basic auth needs a username");
  if (rule.authType === "header" || rule.authType === "template") {
    const name = rule.headerOrParam.trim();
    if (!name) add("authName", "Header auth needs a header name");
    else if (!HEADER_NAME_PATTERN.test(name))
      add("authName", "Header name must be a valid HTTP header name");
    else if (RESERVED_HEADERS.has(name.toLowerCase()))
      add("authName", `Header name ${name} is reserved for the broker`);
  }
  if (rule.authType === "query" && !rule.headerOrParam.trim())
    add("authName", "Query auth needs a parameter name");
  if (
    rule.authType === "header" ||
    rule.authType === "query" ||
    rule.authType === "template"
  )
    add("template", templateError(rule.template, rule.authType === "template"));
  return problems;
}

/** Why no service may use this valid placeholder name, or null; the server refuses these in every scope. */
function reservedPlaceholderError(name: string): string | null {
  if (RESERVED_PLACEHOLDER_NAMES.has(name))
    return `Placeholder name ${name} is reserved`;
  const prefix = RESERVED_PLACEHOLDER_PREFIXES.find((reserved) =>
    name.startsWith(reserved),
  );
  return prefix
    ? `Placeholder name ${name} starts with reserved prefix ${prefix}`
    : null;
}

/** Join words as `A, B, or C`. */
function wordList(words: readonly string[]): string {
  return `${words.slice(0, -1).join(", ")}, or ${words[words.length - 1]}`;
}

function personalPlaceholderNameError(name: string): string {
  return `${name} is not allowed as a placeholder: name a credential, such as MY_API_KEY, with ${wordList(PERSONAL_PLACEHOLDER_WORDS)} as one of its words.`;
}

/** The texts mirror the server's, which never quotes a value. */
function personalPlaceholderError(
  name: string,
  value: string,
): { part: "name" | "value"; message: string } | null {
  const words = name.split("_");
  if (
    !PERSONAL_PLACEHOLDER_NAME.test(name) ||
    !PERSONAL_PLACEHOLDER_WORDS.some((word) => words.includes(word))
  )
    return { part: "name", message: personalPlaceholderNameError(name) };
  if (
    name.startsWith(PERSONAL_PLACEHOLDER_REFUSED_PREFIX) ||
    PERSONAL_PLACEHOLDER_REFUSED_WORDS.some((word) => words.includes(word))
  )
    return {
      part: "name",
      message: `${name} is not allowed: tools read names with ${wordList(PERSONAL_PLACEHOLDER_REFUSED_WORDS)}, or starting with ${PERSONAL_PLACEHOLDER_REFUSED_PREFIX}, as programs or paths.`,
    };
  if (!PERSONAL_PLACEHOLDER_VALUE.test(value))
    return {
      part: "value",
      message: `The value of ${name} must be 1 to 256 letters, digits, or . _ : -`,
    };
  return null;
}

/**
 * The size the server counts for a service: its JSON with every character
 * outside printable ASCII written as a 6 byte `\uXXXX` escape, which is how
 * Python's `json.dumps` writes it. The server measures its own dump of the
 * validated service, so a few bytes of difference remain possible at the edge.
 */
function serverJsonSize(value: unknown): number {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, "\\u0000").length;
}

function nameProblem(
  name: string,
  settings: { takenNames: readonly string[] },
): string | null {
  if (name === "") return "Name is required";
  if (!NAME_PATTERN.test(name))
    return "Name must start with a lowercase letter or digit and use only lowercase letters, digits, - and _ (63 characters at most)";
  if (/_oauth(_client)?$/.test(name))
    return "Name must not end in _oauth or _oauth_client";
  if (settings.takenNames.includes(name))
    return `A service named ${name} already exists`;
  return null;
}

/** Return what stops the form from being saved, in reading order; empty when it can be. */
export function validateService(
  form: EgressServiceForm,
  options: EditorOptions,
  settings: { editing: boolean; takenNames: readonly string[] },
): ServiceProblem[] {
  const problems: ServiceProblem[] = [];
  if (!settings.editing) {
    const message = nameProblem(form.name, settings);
    if (message) problems.push({ field: "name", message });
  }
  if (form.restrictOnly) {
    // The repository helper writes the rules and tells when there are none,
    // and the server checks them again, but a long list can still pass the
    // limits on a service's size. The form has no field for those, so they
    // are told in its alert.
    if (form.rules.length === 0)
      problems.push({
        field: "rules",
        message: "Enter at least one repository, such as owner/repo",
      });
    if (options.context === "personal" && form.rules.length > MAX_RULES)
      problems.push({
        field: "form",
        message: `A service can have at most ${MAX_RULES} rules`,
      });
    problems.push(...sizeProblems(form, options, problems));
    return problems;
  }
  if (
    form.preset === "" &&
    !options.sharedTarget &&
    form.oauthProvider.trim() &&
    !PROVIDER_PATTERN.test(form.oauthProvider.trim())
  )
    problems.push({
      field: "oauthProvider",
      message:
        "Account login must be a provider id such as github or google_drive (lowercase letters, digits, - and _)",
    });
  if (usesOwnRules(form)) {
    if (form.rules.length === 0)
      problems.push({ field: "rules", message: "Add at least one rule" });
    if (options.context === "personal" && form.rules.length > MAX_RULES)
      problems.push({
        field: "rules",
        message: `A service can have at most ${MAX_RULES} rules`,
      });
    form.rules.forEach((rule, index) =>
      problems.push(...ruleProblems(rule, index)),
    );
  }
  const seen = new Set<string>();
  form.placeholders.forEach((placeholder, index) => {
    const name = placeholder.name.trim();
    // A row without a name is an unused row, whatever its value.
    if (name === "") return;
    const add = (part: "name" | "value", message: string) =>
      problems.push({ field: placeholderField(index, part), message });
    if (!PLACEHOLDER_NAME_PATTERN.test(name)) {
      // A personal user hears what the server would say, not a pattern.
      add(
        "name",
        options.context === "personal"
          ? personalPlaceholderNameError(name)
          : `Placeholder name ${name} must match ^[A-Z_][A-Z0-9_]*$`,
      );
      return;
    }
    const reservedProblem = reservedPlaceholderError(name);
    if (reservedProblem) {
      add("name", reservedProblem);
      return;
    }
    if (seen.has(name)) add("name", `Placeholder ${name} is listed twice`);
    seen.add(name);
    const personalProblem =
      options.context === "personal"
        ? personalPlaceholderError(name, placeholder.value)
        : null;
    if (personalProblem) add(personalProblem.part, personalProblem.message);
  });
  problems.push(...sizeProblems(form, options, problems));
  return problems;
}

/** The size problem of a personal service, measured only once nothing else is wrong with it. */
function sizeProblems(
  form: EgressServiceForm,
  options: EditorOptions,
  found: readonly ServiceProblem[],
): ServiceProblem[] {
  return options.context === "personal" &&
    found.length === 0 &&
    serverJsonSize(serializeService(form, options)) > MAX_SERVICE_BYTES
    ? [
        {
          field: "form",
          message: `A service can take at most ${MAX_SERVICE_BYTES / 1024} KiB`,
        },
      ]
    : [];
}

/**
 * Rules that let a service reach only the listed GitHub repositories.
 *
 * Each line is `owner/repo`, or `owner/*` for everything the owner has. A
 * repository gets `api.github.com` `/repos/owner/repo` and `github.com`
 * `/owner/repo` and `/owner/repo.git`; an owner gets the same under a trailing
 * slash, which matches every path below it. `uploads.github.com` (release
 * assets, limited to the same repositories) and `/graphql` (every repository
 * the key can reach) are added only when asked for.
 */
export function githubRepositoryRules(
  input: string,
  options: { uploads: boolean; graphql: boolean },
): { rules: EgressRule[]; errors: string[]; repositories: string[] } {
  const bearer: EgressAuth = { type: "bearer" };
  const git: EgressAuth = { type: "basic", username: "x-access-token" };
  const errors: string[] = [];
  const targets = new Map<string, { owner: string; repo: string }>();
  for (const line of input.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const match = GITHUB_REPOSITORY_LINE.exec(text);
    // GitHub never has a repository named `.git`, so a pasted clone name loses its suffix.
    const repo = match?.[2].replace(/\.git$/, "");
    if (!match || !repo || repo === "." || repo === "..") {
      errors.push(`${text} is not owner/repo or owner/*`);
      continue;
    }
    if (
      match[1].length > GITHUB_MAX_OWNER_LENGTH ||
      repo.length > GITHUB_MAX_REPOSITORY_LENGTH
    ) {
      errors.push(
        `${text} is too long: GitHub owners have at most ${GITHUB_MAX_OWNER_LENGTH} characters and repositories ${GITHUB_MAX_REPOSITORY_LENGTH}`,
      );
      continue;
    }
    targets.set(`${match[1]}/${repo}`, { owner: match[1], repo });
  }
  if (targets.size === 0 && errors.length === 0)
    errors.push("Enter at least one repository, such as owner/repo");
  if (errors.length > 0) return { rules: [], errors, repositories: [] };
  const rules: EgressRule[] = [];
  for (const { owner, repo } of targets.values()) {
    if (repo === "*") {
      rules.push(
        {
          host: GITHUB_API_HOST,
          path_prefix: `/repos/${owner}/`,
          auth: bearer,
        },
        { host: GITHUB_WEB_HOST, path_prefix: `/${owner}/`, auth: git },
      );
      if (options.uploads)
        rules.push({
          host: GITHUB_UPLOADS_HOST,
          path_prefix: `/repos/${owner}/`,
          auth: bearer,
        });
      continue;
    }
    rules.push(
      {
        host: GITHUB_API_HOST,
        path_prefix: `/repos/${owner}/${repo}`,
        auth: bearer,
      },
      { host: GITHUB_WEB_HOST, path_prefix: `/${owner}/${repo}`, auth: git },
      {
        host: GITHUB_WEB_HOST,
        path_prefix: `/${owner}/${repo}.git`,
        auth: git,
      },
    );
    if (options.uploads)
      rules.push({
        host: GITHUB_UPLOADS_HOST,
        path_prefix: `/repos/${owner}/${repo}`,
        auth: bearer,
      });
  }
  if (options.graphql)
    rules.push({
      host: GITHUB_API_HOST,
      path_prefix: "/graphql",
      auth: bearer,
    });
  return { rules, errors, repositories: [...targets.keys()] };
}

/**
 * Rules for a limit in place on the listed GitHub repositories. They always
 * cover `uploads.github.com` too: a limit narrows only the hosts it has rules
 * for, so without them the administrator's `uploads.github.com` rule would
 * keep reaching every repository with the user's key or account.
 */
export function githubLimitRules(
  input: string,
  options: { graphql: boolean },
): { rules: EgressRule[]; errors: string[]; repositories: string[] } {
  return githubRepositoryRules(input, {
    uploads: true,
    graphql: options.graphql,
  });
}

/** The display name and description for a service limited to these repositories. */
export function githubLimitLabels(repositories: readonly string[]): {
  displayName: string;
  description: string;
} {
  const repos = repositories.join(", ");
  return {
    displayName: `GitHub (${repos})`,
    description: `Limited to ${repos}`,
  };
}

/** Whether to offer the GitHub helper: the GitHub preset, or the service's own rules on a GitHub host. */
export function looksLikeGithub(form: EgressServiceForm): boolean {
  if (form.preset === "github") return true;
  if (!usesOwnRules(form)) return false;
  return form.rules.some((rule) =>
    GITHUB_HOSTS.includes(rule.host.trim().toLowerCase()),
  );
}

const MAX_NAME_LENGTH = 63;

/**
 * The name a new service gets until the user types one: the preset's id, or
 * the first label of the first rule's host (`httpbin.org` gives `httpbin`).
 * When `takenNames` has it, the first free `{base}-2` or `{base}-3` instead;
 * with all three taken it stays the base, so saving names the clash.
 */
export function suggestedName(
  form: EgressServiceForm,
  takenNames: readonly string[] = [],
): string {
  let base = form.preset;
  if (!base) {
    const host = (form.rules[0]?.host ?? "").trim().toLowerCase();
    const label = host.replace(/^\*\./, "").split(/[.:/]/)[0];
    base = label
      .replace(/[^a-z0-9_-]/g, "")
      .replace(/^[-_]+/, "")
      .slice(0, MAX_NAME_LENGTH);
  }
  if (base === "") return "";
  for (const suffix of ["", "-2", "-3"]) {
    const candidate = `${base.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!takenNames.includes(candidate)) return candidate;
  }
  return base;
}

/** What to tell the user about a placeholder that an administrator's service also sets, or null. */
export function configPlaceholderWarning(
  name: string,
  configPlaceholders: Readonly<Record<string, string>>,
): string | null {
  const variable = name.trim();
  if (!Object.prototype.hasOwnProperty.call(configPlaceholders, variable))
    return null;
  return `${variable} is also set by ${configPlaceholders[variable]} from your administrator; when both are set, theirs is used.`;
}

/**
 * What to tell the user about the placeholders their preset sets that an
 * administrator's service also sets, one text per variable in the preset's
 * order. The preset's placeholders apply only while the service lists none of
 * its own and has not dropped them on purpose.
 */
export function presetPlaceholderWarnings(
  form: EgressServiceForm,
  preset: EgressPreset | undefined,
  configPlaceholders: Readonly<Record<string, string>>,
): string[] {
  if (
    !preset ||
    form.preset !== preset.id ||
    form.placeholders.length > 0 ||
    form.explicitlyEmpty.placeholders
  )
    return [];
  return Object.keys(preset.placeholder_env).flatMap((variable) => {
    const warning = configPlaceholderWarning(variable, configPlaceholders);
    return warning === null ? [] : [warning];
  });
}

/** Map each variable to the display name of the administrator's service that sets it, from a listing. */
export function configPlaceholderOwners(
  services: readonly Pick<
    EgressCredentialService,
    "source" | "display_name" | "placeholder_names"
  >[],
): Record<string, string> {
  const owners: Record<string, string> = {};
  for (const service of services) {
    if (service.source !== "config") continue;
    for (const name of service.placeholder_names ?? [])
      if (!Object.prototype.hasOwnProperty.call(owners, name))
        owners[name] = service.display_name;
  }
  return owners;
}

/**
 * What to tell the user when another service of the agent already sends a key
 * to a website this form covers: one text per such service, with all the
 * hosts it shares. Services that only limit paths send no key, and the service
 * being edited does not compete with itself.
 */
export function overlapWarnings(
  form: EgressServiceForm,
  preset: EgressPreset | undefined,
  others: readonly Pick<
    EgressCredentialService,
    "name" | "display_name" | "rules" | "restrict_only"
  >[],
  editingName: string | undefined,
): string[] {
  const covered = new Set(
    (usesOwnRules(form) ? form.rules : (preset?.rules ?? []))
      .map((rule) => rule.host.trim().toLowerCase())
      .filter((host) => host !== ""),
  );
  if (covered.size === 0) return [];
  return others.flatMap((other) => {
    if (other.restrict_only === true || other.name === editingName) return [];
    const shared = [
      ...new Set(
        (other.rules ?? [])
          .filter((rule) => rule.auth_type !== null)
          .map((rule) => rule.host.toLowerCase())
          .filter((host) => covered.has(host)),
      ),
    ];
    return shared.length > 0
      ? [
          `${other.display_name} already sends a key to ${formatList(shared)} for this agent. The most specific path wins, and equal paths go to the service listed first.`,
        ]
      : [];
  });
}

/** Who uses a personal service, for the note under the form's title; null where nothing needs saying. */
export function scopeNote(
  scope: EgressScope | undefined,
  agent: string,
  scopeAgents: readonly string[],
): string | null {
  if (scope === "user_agent")
    return `Only your ${agent} uses this service and its key.`;
  if (scope === "user") {
    const agents = scopeAgents.length > 0 ? scopeAgents : [agent];
    return `All your agents that share your personal workspace use this service and its key: ${agents.join(", ")}.`;
  }
  return null;
}

/** Whether the form sets anything the basic fields do not show, so the editor opens More options. */
export function usesMoreOptions(form: EgressServiceForm): boolean {
  const first = form.rules[0];
  return (
    form.displayName.trim() !== "" ||
    form.description.trim() !== "" ||
    form.replacePresetRules ||
    form.rules.length > 1 ||
    (usesOwnRules(form) &&
      first !== undefined &&
      (first.pathPrefix.trim() !== "" || first.port.trim() !== "")) ||
    form.restrictToRules ||
    form.oauthProvider.trim() !== "" ||
    form.placeholders.length > 0
  );
}
