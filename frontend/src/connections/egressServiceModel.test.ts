import { describe, expect, it } from "vitest";
import egressPresets from "@/test/fixtures/egressPresets.json";
import {
  BASIC_RULE_PARTS,
  type EditorOptions,
  type EgressServiceForm,
  applyAuthChoice,
  configPlaceholderOwners,
  configPlaceholderWarning,
  emptyRule,
  formFromService,
  githubLimitLabels,
  githubRepositoryRules,
  isBasicField,
  looksLikeGithub,
  overlapWarnings,
  placeholderField,
  presetPlaceholderWarnings,
  ruleField,
  scopeNote,
  serializeService,
  stripHostInput,
  suggestedName,
  usesMoreOptions,
  validateService,
} from "./egressServiceModel";
import type { AuthoredEgressService, EgressPreset, EgressRule } from "./types";

type Options = EditorOptions;

const presets = egressPresets.presets as EgressPreset[];
const personal: Options = { context: "personal", sharedTarget: false, presets };
const sharedPersonal: Options = {
  context: "personal",
  sharedTarget: true,
  presets,
};
const operator: Options = { context: "operator", sharedTarget: false, presets };
const newService = { editing: false, takenNames: [] as string[] };

const bearerRule: EgressRule = {
  host: "api.example.com",
  auth: { type: "bearer" },
};

const serialize = (
  service: AuthoredEgressService,
  options: Options = personal,
  name = "svc",
) => serializeService(formFromService(name, service), options, service);

const problemsFor = (
  service: AuthoredEgressService | null,
  changes: Partial<EgressServiceForm> = {},
  options: Options = personal,
  settings: { editing: boolean; takenNames: string[] } = newService,
) =>
  validateService(
    { ...formFromService("svc", service), ...changes },
    options,
    settings,
  );

const errorsFor = (
  service: AuthoredEgressService | null,
  changes: Partial<EgressServiceForm> = {},
  options: Options = personal,
  settings: { editing: boolean; takenNames: string[] } = newService,
) =>
  problemsFor(service, changes, options, settings).map(
    (problem) => problem.message,
  );

describe("serializing a service", () => {
  it("writes a custom service with only the fields that matter", () => {
    expect(
      serialize({
        display_name: "Example",
        description: " Example API ",
        rules: [
          {
            host: " API.Example.com ",
            port: 8443,
            path_prefix: "/v1/",
            auth: { type: "bearer" },
          },
          { host: "git.example.com", path_prefix: "/", auth: basicAuth("x") },
          {
            host: "b.example.com",
            auth: { type: "header", name: "x-api-key", template: "{secret}" },
          },
          {
            host: "c.example.com",
            auth: { type: "query", name: "key", template: "k={secret}" },
          },
        ],
        placeholder_env: { EXAMPLE_API_KEY: "mindroom-brokered" },
        oauth_provider: "github",
      }),
    ).toEqual({
      display_name: "Example",
      description: "Example API",
      rules: [
        {
          host: "api.example.com",
          port: 8443,
          path_prefix: "/v1/",
          auth: { type: "bearer" },
        },
        { host: "git.example.com", auth: { type: "basic", username: "x" } },
        { host: "b.example.com", auth: { type: "header", name: "x-api-key" } },
        {
          host: "c.example.com",
          auth: { type: "query", name: "key", template: "k={secret}" },
        },
      ],
      placeholder_env: { EXAMPLE_API_KEY: "mindroom-brokered" },
      oauth_provider: "github",
    });
  });

  it("keeps a preset as the preset, without its expanded fields", () => {
    expect(serialize({ preset: "github" })).toEqual({ preset: "github" });
    expect(serialize({ preset: "openai" }, operator)).toEqual({
      preset: "openai",
    });
  });

  it("adds only what the user changed to a preset", () => {
    expect(serialize({ preset: "github", restrict_to_rules: true })).toEqual({
      preset: "github",
      restrict_to_rules: true,
    });
    expect(
      serialize({ preset: "github", display_name: "GitHub work" }),
    ).toEqual({
      preset: "github",
      display_name: "GitHub work",
    });
    expect(serialize({ preset: "github", rules: [bearerRule] })).toEqual({
      preset: "github",
      rules: [bearerRule],
    });
  });

  it("never writes restrict_to_rules false", () => {
    expect(
      serialize({ rules: [bearerRule], restrict_to_rules: false }),
    ).toEqual({
      rules: [bearerRule],
    });
  });

  it("drops the preset's account login on a shared agent", () => {
    expect(serialize({ preset: "github" }, sharedPersonal)).toEqual({
      preset: "github",
      oauth_provider: null,
    });
    // Presets without a login need nothing, and personal agents keep it.
    expect(serialize({ preset: "openai" }, sharedPersonal)).toEqual({
      preset: "openai",
    });
    expect(serialize({ preset: "github" })).toEqual({ preset: "github" });
  });

  it("never writes an account login for a custom service on a shared agent", () => {
    expect(
      serialize(
        { rules: [bearerRule], oauth_provider: "github" },
        sharedPersonal,
      ),
    ).toEqual({
      rules: [bearerRule],
    });
  });

  it("keeps an operator's oauth_on_shared_workers and never sends it from the personal page", () => {
    const service = {
      preset: "github",
      oauth_on_shared_workers: true,
    } satisfies AuthoredEgressService;
    expect(serialize(service, operator)).toEqual(service);
    expect(serialize(service, personal)).toEqual({ preset: "github" });
  });

  it("keeps an explicit OAuth override of a preset", () => {
    expect(
      serialize({ preset: "github", oauth_provider: null }, operator),
    ).toEqual({
      preset: "github",
      oauth_provider: null,
    });
  });

  it("round-trips an authored service through the form", () => {
    const service: AuthoredEgressService = {
      preset: "github",
      restrict_to_rules: true,
      rules: [
        {
          host: "api.github.com",
          path_prefix: "/repos/o/r",
          auth: { type: "bearer" },
        },
      ],
      placeholder_env: { GH_TOKEN: "mindroom-brokered" },
    };
    expect(serialize(service, operator)).toEqual(service);
  });
});

function basicAuth(username: string) {
  return { type: "basic", username } as const;
}

describe("validating a service", () => {
  it("accepts a preset alone and a valid custom service", () => {
    expect(errorsFor({ preset: "github" })).toEqual([]);
    expect(errorsFor(null, { name: "svc", rules: [validRule()] })).toEqual([]);
  });

  it("checks the name of a new service only", () => {
    expect(errorsFor({ preset: "github" }, { name: "" })).toEqual([
      "Name is required",
    ]);
    expect(errorsFor({ preset: "github" }, { name: "  " })[0]).toContain(
      "Name must start",
    );
    expect(errorsFor({ preset: "github" }, { name: "Has Caps" })[0]).toContain(
      "Name must start",
    );
    expect(errorsFor({ preset: "github" }, { name: "_hidden" })[0]).toContain(
      "Name must start",
    );
    expect(errorsFor({ preset: "github" }, { name: "x_oauth" })).toEqual([
      "Name must not end in _oauth or _oauth_client",
    ]);
    expect(
      errorsFor({ preset: "github" }, { name: "github" }, personal, {
        editing: false,
        takenNames: ["github"],
      }),
    ).toEqual(["A service named github already exists"]);
    // An existing service keeps its name, even one that is taken by itself.
    expect(
      errorsFor({ preset: "github" }, { name: "github" }, personal, {
        editing: true,
        takenNames: ["github"],
      }),
    ).toEqual([]);
  });

  it("requires a rule unless a preset supplies them", () => {
    expect(errorsFor(null, { rules: [] })).toEqual(["Add at least one rule"]);
    expect(
      errorsFor({ preset: "github" }, { replacePresetRules: true, rules: [] }),
    ).toEqual(["Add at least one rule"]);
    expect(errorsFor({ preset: "github" }, { rules: [] })).toEqual([]);
  });

  it.each([
    ["", "Host is required"],
    [
      "https://api.example.com",
      "Enter only the host, without https:// or a path",
    ],
    ["api.example.com:8443", "Host must not contain a port"],
    ["api.example.com/v1", "Enter only the host, without https:// or a path"],
    ["*.*.example.com", "Host can only have one wildcard label"],
    ["*.com", "Wildcard host must have at least one domain part"],
    ["api.*.com", "Wildcard must be a single leading *. label"],
  ])("rejects the host %j", (host, message) => {
    const errors = errorsFor(null, { rules: [{ ...validRule(), host }] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(message);
  });

  it("accepts a wildcard host and an IP-less plain host", () => {
    expect(
      errorsFor(null, { rules: [{ ...validRule(), host: "*.example.com" }] }),
    ).toEqual([]);
  });

  it("checks path prefix and port", () => {
    expect(
      errorsFor(null, { rules: [{ ...validRule(), pathPrefix: "v1" }] }),
    ).toEqual(["Path prefix must start with /"]);
    for (const port of ["0", "70000", "abc", "1.5"])
      expect(errorsFor(null, { rules: [{ ...validRule(), port }] })).toEqual([
        "Port must be a number from 1 to 65535",
      ]);
    expect(
      errorsFor(null, { rules: [{ ...validRule(), port: "8443" }] }),
    ).toEqual([]);
  });

  it("checks the fields each auth type needs", () => {
    const check = (changes: object) =>
      errorsFor(null, { rules: [{ ...validRule(), ...changes }] });
    expect(check({ authType: "basic", username: " " })).toEqual([
      "Basic auth needs a username",
    ]);
    expect(check({ authType: "header" })).toEqual([
      "Header auth needs a header name",
    ]);
    expect(check({ authType: "header", headerOrParam: "bad header" })).toEqual([
      "Header name must be a valid HTTP header name",
    ]);
    expect(check({ authType: "query" })).toEqual([
      "Query auth needs a parameter name",
    ]);
    expect(
      check({ authType: "header", headerOrParam: "x-key", template: "token" }),
    ).toEqual(["Template must contain {secret} exactly once"]);
    expect(
      check({
        authType: "query",
        headerOrParam: "key",
        template: "{secret}{secret}",
      }),
    ).toEqual(["Template must contain {secret} exactly once"]);
    expect(
      check({
        authType: "header",
        headerOrParam: "Authorization",
        template: "Bearer {secret}",
      }),
    ).toEqual([]);
  });

  it("numbers the rule that has the problem", () => {
    expect(
      errorsFor(null, { rules: [validRule(), { ...validRule(), host: "" }] }),
    ).toEqual(["Host is required"]);
  });

  it("limits a personal service to 50 rules but not an operator service", () => {
    const rules = Array.from({ length: 51 }, validRule);
    expect(errorsFor(null, { rules })).toEqual([
      "A service can have at most 50 rules",
    ]);
    expect(errorsFor(null, { rules }, operator)).toEqual([]);
  });

  it("limits a personal service to 16 KiB", () => {
    const description = "x".repeat(17 * 1024);
    expect(errorsFor(null, { rules: [validRule()], description })).toEqual([
      "A service can take at most 16 KiB",
    ]);
    expect(
      errorsFor(null, { rules: [validRule()], description }, operator),
    ).toEqual([]);
  });

  it("applies the personal placeholder rules to personal services only", () => {
    const placeholders = (name: string, value = "mindroom-brokered") => ({
      placeholders: [{ name, value }],
    });
    expect(errorsFor({ preset: "github" }, placeholders("MY_API_KEY"))).toEqual(
      [],
    );
    expect(errorsFor({ preset: "github" }, placeholders("LD_PRELOAD"))[0]).toBe(
      "LD_PRELOAD is not allowed as a placeholder: name a credential, such as MY_API_KEY, with TOKEN, KEY, SECRET, PASSWORD, PAT, AUTH, or CREDENTIAL as one of its words.",
    );
    // A credential word has to be a whole part: PYTHONPATH only contains PAT.
    expect(
      errorsFor({ preset: "github" }, placeholders("PYTHONPATH")),
    ).toHaveLength(1);
    expect(errorsFor({ preset: "github" }, placeholders("MY_PAT"))).toEqual([]);
    expect(
      errorsFor(
        { preset: "github" },
        placeholders("MY_API_KEY", "has space"),
      )[0],
    ).toBe(
      "The value of MY_API_KEY must be 1 to 256 letters, digits, or . _ : -",
    );
    expect(
      errorsFor({ preset: "github" }, placeholders("MY_API_KEY", "")),
    ).toHaveLength(1);
    // The operator may use any valid variable name and any value.
    expect(
      errorsFor(
        { preset: "github" },
        placeholders("LD_PRELOAD", "a b"),
        operator,
      ),
    ).toEqual([]);
  });

  describe("placeholder names the server refuses", () => {
    const placeholder = (name: string, value = "mindroom-brokered") => ({
      placeholders: [{ name, value }],
    });
    const personalErrors = (name: string) =>
      errorsFor({ preset: "github" }, placeholder(name));
    const operatorErrors = (name: string) =>
      errorsFor({ preset: "github" }, placeholder(name), operator);

    it.each([
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
    ])("reserves %s for the broker in every context", (name) => {
      expect(operatorErrors(name)).toEqual([
        `Placeholder name ${name} is reserved`,
      ]);
      // One reason is enough: a personal service is not also told about its words.
      expect(personalErrors(name)).toEqual([
        `Placeholder name ${name} is reserved`,
      ]);
    });

    it.each([
      ["MINDROOM_API_KEY", "MINDROOM_"],
      ["GIT_CONFIG_KEY_0", "GIT_CONFIG_"],
    ])("reserves the prefix of %s in every context", (name, prefix) => {
      const message = `Placeholder name ${name} starts with reserved prefix ${prefix}`;
      expect(operatorErrors(name)).toEqual([message]);
      expect(personalErrors(name)).toEqual([message]);
    });

    it.each([
      "SSH_AUTH_SOCK",
      "SSH_TOKEN",
      "RESTIC_PASSWORD_COMMAND",
      "SOPS_AGE_KEY_CMD",
      "MY_KEY_FILE",
      "TOOL_TOKEN_DIR",
      "GIT_CREDENTIAL_HELPER",
      "MY_API_KEY_PROVIDER",
      "MY_KEY_OPTS",
      "MY_KEY_OPTIONS",
      "MY_KEY_EXTENSIONS",
    ])("refuses %s on a personal service only", (name) => {
      const errors = personalErrors(name);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe(
        `${name} is not allowed: tools read names with COMMAND, CMD, FILE, DIR, PROVIDER, HELPER, OPTS, OPTIONS, or EXTENSIONS, or starting with SSH_, as programs or paths.`,
      );
      expect(operatorErrors(name)).toEqual([]);
    });

    it("refuses whole words only, and SSH_ only at the start", () => {
      for (const name of [
        "MY_FILES_KEY",
        "COMMANDER_TOKEN",
        "MY_SSH_KEY",
        "SSHKEY_TOKEN",
        "MY_DIRECTORY_KEY",
        "OPTIONAL_TOKEN",
      ])
        expect(personalErrors(name)).toEqual([]);
    });

    it("keeps the credential word rule ahead of the refused words", () => {
      // LD_PRELOAD has no credential word, so that is what the user hears.
      expect(personalErrors("LD_PRELOAD")[0]).toContain("name a credential");
      expect(personalErrors("SSH_AGENT_PID")[0]).toContain("name a credential");
    });
  });

  it("measures a personal service the way the server does, in ASCII escapes", () => {
    // Python's json.dumps writes each character outside printable ASCII as a
    // 6 byte \uXXXX escape, and an emoji as two of them.
    const serverSize = (service: AuthoredEgressService) =>
      JSON.stringify(service).replace(
        /[^\x20-\x7e]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ).length;
    const limit = 16 * 1024;
    const form = (description: string) => ({
      ...formFromService("svc", null),
      rules: [validRule()],
      description,
    });
    const sizeWith = (description: string) =>
      serverSize(serializeService(form(description), personal));
    const fits = (description: string) =>
      validateService(form(description), personal, newService).map(
        (problem) => problem.message,
      );
    // How many of `char`, each costing `cost` bytes, make the service exactly 16 KiB or just over.
    const largest = (char: string, cost: number) =>
      Math.floor((limit - (sizeWith(char) - cost)) / cost);

    // The sizes the server's `_json_size` reports for the same service, which
    // a new service writes with its website as the display name.
    expect(sizeWith("a")).toBe(114);
    expect(sizeWith("\u00e9")).toBe(119);
    expect(sizeWith("\u{1F600}")).toBe(125);
    expect(sizeWith("\u007f")).toBe(119);

    const plain = largest("a", 1);
    expect(sizeWith("a".repeat(plain))).toBe(limit);
    expect(fits("a".repeat(plain))).toEqual([]);
    expect(fits("a".repeat(plain + 1))).toEqual([
      "A service can take at most 16 KiB",
    ]);

    // 2 bytes in UTF-8 but 6 in the server's count: UTF-8 would let this through.
    const accented = largest("\u00e9", 6);
    expect(fits("\u00e9".repeat(accented))).toEqual([]);
    expect(fits("\u00e9".repeat(accented + 1))).toEqual([
      "A service can take at most 16 KiB",
    ]);
    expect(
      new TextEncoder().encode(
        JSON.stringify(
          serializeService(form("\u00e9".repeat(accented + 1)), personal),
        ),
      ).length,
    ).toBeLessThan(limit);

    // An emoji is a surrogate pair: 12 bytes. DEL is not escaped by JSON.stringify but is by the server: 6.
    const emoji = largest("\u{1F600}", 12);
    expect(fits("\u{1F600}".repeat(emoji))).toEqual([]);
    expect(fits("\u{1F600}".repeat(emoji + 1))).toHaveLength(1);
    const del = largest("\u007f", 6);
    expect(fits("\u007f".repeat(del))).toEqual([]);
    expect(fits("\u007f".repeat(del + 1))).toHaveLength(1);
  });

  it("rejects badly shaped and repeated placeholder names, and skips blank rows", () => {
    const rows = (...names: string[]) => ({
      placeholders: names.map((name) => ({ name, value: "mindroom-brokered" })),
    });
    expect(errorsFor({ preset: "github" }, rows("my_key"), operator)).toEqual([
      "Placeholder name my_key must match ^[A-Z_][A-Z0-9_]*$",
    ]);
    expect(
      errorsFor({ preset: "github" }, rows("A_KEY", "A_KEY"), operator),
    ).toEqual(["Placeholder A_KEY is listed twice"]);
    expect(
      errorsFor(
        { preset: "github" },
        { placeholders: [{ name: "", value: "" }] },
        operator,
      ),
    ).toEqual([]);
    expect(
      serializeService(
        {
          ...formFromService("svc", { preset: "github" }),
          placeholders: [{ name: " ", value: "" }],
        },
        operator,
      ),
    ).toEqual({ preset: "github" });
  });
});

function validRule() {
  return {
    host: "api.example.com",
    port: "",
    pathPrefix: "",
    authType: "bearer" as const,
    username: "",
    headerOrParam: "",
    template: "",
  };
}

describe("GitHub repository rules", () => {
  const none = { uploads: false, graphql: false };

  it("generates the API and git rules for one repository", () => {
    expect(githubRepositoryRules("basnijholt/agent-cli", none)).toEqual({
      errors: [],
      repositories: ["basnijholt/agent-cli"],
      rules: [
        {
          host: "api.github.com",
          path_prefix: "/repos/basnijholt/agent-cli",
          auth: { type: "bearer" },
        },
        {
          host: "github.com",
          path_prefix: "/basnijholt/agent-cli",
          auth: { type: "basic", username: "x-access-token" },
        },
        {
          host: "github.com",
          path_prefix: "/basnijholt/agent-cli.git",
          auth: { type: "basic", username: "x-access-token" },
        },
      ],
    });
  });

  it("makes an owner-wide rule with a trailing slash for owner/*", () => {
    expect(githubRepositoryRules("mindroom-ai/*", none)).toEqual({
      errors: [],
      repositories: ["mindroom-ai/*"],
      rules: [
        {
          host: "api.github.com",
          path_prefix: "/repos/mindroom-ai/",
          auth: { type: "bearer" },
        },
        {
          host: "github.com",
          path_prefix: "/mindroom-ai/",
          auth: { type: "basic", username: "x-access-token" },
        },
      ],
    });
  });

  it("adds uploads.github.com for the same repositories only when ticked", () => {
    const hosts = (uploads: boolean, input: string) =>
      githubRepositoryRules(input, { uploads, graphql: false }).rules.filter(
        (rule) => rule.host === "uploads.github.com",
      );
    expect(hosts(false, "o/r")).toEqual([]);
    expect(hosts(true, "o/r")).toEqual([
      {
        host: "uploads.github.com",
        path_prefix: "/repos/o/r",
        auth: { type: "bearer" },
      },
    ]);
    expect(hosts(true, "o/*")).toEqual([
      {
        host: "uploads.github.com",
        path_prefix: "/repos/o/",
        auth: { type: "bearer" },
      },
    ]);
  });

  it("adds /graphql once, only when ticked", () => {
    const graphql = (tick: boolean) =>
      githubRepositoryRules("a/b\nc/*", {
        uploads: false,
        graphql: tick,
      }).rules.filter((rule) => rule.path_prefix === "/graphql");
    expect(graphql(false)).toEqual([]);
    expect(graphql(true)).toEqual([
      {
        host: "api.github.com",
        path_prefix: "/graphql",
        auth: { type: "bearer" },
      },
    ]);
  });

  it("combines several lines with both ticks", () => {
    const { rules } = githubRepositoryRules("a/b\nc/*", {
      uploads: true,
      graphql: true,
    });
    expect(rules.map((rule) => `${rule.host}${rule.path_prefix}`)).toEqual([
      "api.github.com/repos/a/b",
      "github.com/a/b",
      "github.com/a/b.git",
      "uploads.github.com/repos/a/b",
      "api.github.com/repos/c/",
      "github.com/c/",
      "uploads.github.com/repos/c/",
      "api.github.com/graphql",
    ]);
  });

  it("ignores blank lines and repeats, trims, and drops a .git suffix", () => {
    const { rules, errors, repositories } = githubRepositoryRules(
      "\n  o/r  \r\no/r\no/r.git\n\n",
      none,
    );
    expect(errors).toEqual([]);
    expect(rules).toHaveLength(3);
    expect(rules[0].path_prefix).toBe("/repos/o/r");
    expect(repositories).toEqual(["o/r"]);
  });

  it("names each line that is not owner/repo or owner/*", () => {
    expect(
      githubRepositoryRules(
        "https://github.com/o/r\nowner\no/r/extra\no/..\n",
        none,
      ),
    ).toEqual({
      rules: [],
      repositories: [],
      errors: [
        "https://github.com/o/r is not owner/repo or owner/*",
        "owner is not owner/repo or owner/*",
        "o/r/extra is not owner/repo or owner/*",
        "o/.. is not owner/repo or owner/*",
      ],
    });
    expect(githubRepositoryRules("  \n", none).errors).toEqual([
      "Enter at least one repository, such as owner/repo",
    ]);
  });
});

describe("an unchanged save writes the service back as it was", () => {
  it("keeps placeholders a preset service dropped on purpose", () => {
    const service = { preset: "github", placeholder_env: {} };
    expect(serialize(service, operator)).toEqual(service);
    expect(serialize(service, personal)).toEqual(service);
  });

  it("keeps an empty description and an empty or null display name", () => {
    for (const service of [
      { preset: "github", description: "" },
      { preset: "github", display_name: "" },
      { preset: "github", display_name: null },
      { rules: [bearerRule], description: "", placeholder_env: {} },
    ] satisfies AuthoredEgressService[])
      expect(serialize(service, operator)).toEqual(service);
  });

  it("leaves the keys out when the service never had them", () => {
    expect(serialize({ preset: "github" }, operator)).toEqual({
      preset: "github",
    });
  });

  it("writes what the user typed over an empty value", () => {
    const form = formFromService("svc", {
      preset: "github",
      description: "",
      placeholder_env: {},
    });
    expect(
      serializeService(
        {
          ...form,
          description: "Work",
          placeholders: [{ name: "GH_TOKEN", value: "x" }],
        },
        operator,
      ),
    ).toEqual({
      preset: "github",
      description: "Work",
      placeholder_env: { GH_TOKEN: "x" },
    });
  });

  it("drops a value the user cleared instead of writing it as empty", () => {
    const form = formFromService("svc", {
      preset: "github",
      display_name: "Work GitHub",
      description: "Mine",
      placeholder_env: { GH_TOKEN: "x" },
    });
    expect(
      serializeService(
        { ...form, displayName: "", description: "", placeholders: [] },
        operator,
      ),
    ).toEqual({ preset: "github" });
  });

  it.each<[string, AuthoredEgressService]>([
    [
      "bearer with a port and path",
      {
        rules: [
          {
            host: "api.example.com",
            port: 8443,
            path_prefix: "/v1/",
            auth: { type: "bearer" },
          },
        ],
      },
    ],
    [
      "basic with a username",
      {
        rules: [
          {
            host: "git.example.com",
            auth: { type: "basic", username: "x-access-token" },
          },
        ],
      },
    ],
    [
      "header with a template",
      {
        rules: [
          {
            host: "api.example.com",
            auth: {
              type: "header",
              name: "Authorization",
              template: "Bearer {secret}",
            },
          },
        ],
      },
    ],
    [
      "header with the default template left out",
      {
        rules: [
          {
            host: "api.example.com",
            auth: { type: "header", name: "x-api-key" },
          },
        ],
      },
    ],
    [
      "query with a template",
      {
        rules: [
          {
            host: "api.example.com",
            auth: { type: "query", name: "key", template: "k={secret}" },
          },
        ],
      },
    ],
    [
      "one rule of each kind",
      {
        description: "Mixed",
        restrict_to_rules: true,
        rules: [
          { host: "a.example.com", auth: { type: "bearer" } },
          {
            host: "*.b.example.com",
            port: 443,
            auth: { type: "basic", username: "u" },
          },
          {
            host: "c.example.com",
            path_prefix: "/c",
            auth: { type: "query", name: "q" },
          },
        ],
        placeholder_env: { EXAMPLE_API_KEY: "mindroom-brokered" },
      },
    ],
  ])("round-trips %s", (_name, service) => {
    expect(serialize(service, operator)).toEqual(service);
    expect(serialize(service, personal)).toEqual(service);
  });
});

describe("the account login a preset service keeps", () => {
  it("keeps an override written for the same preset", () => {
    expect(
      serialize({ preset: "github", oauth_provider: null }, operator),
    ).toEqual({
      preset: "github",
      oauth_provider: null,
    });
  });

  it("does not carry it over to another preset", () => {
    const form = {
      ...formFromService("svc", { preset: "github", oauth_provider: null }),
      preset: "atlassian",
    };
    expect(
      serializeService(form, operator, {
        preset: "github",
        oauth_provider: null,
      }),
    ).toEqual({ preset: "atlassian" });
  });

  it("does not carry it from a preset onto a custom service", () => {
    const form = {
      ...formFromService("svc", { preset: "github", oauth_provider: null }),
      preset: "",
    };
    expect(
      serializeService(form, operator, {
        preset: "github",
        oauth_provider: null,
      }),
    ).toEqual({ rules: [] });
  });

  it("drops every preset's login on a shared target while the presets are still loading", () => {
    const loading: Options = { ...sharedPersonal, presets: null };
    expect(serialize({ preset: "openai" }, loading)).toEqual({
      preset: "openai",
      oauth_provider: null,
    });
  });
});

describe("rows and fields the model ignores or checks", () => {
  it("skips a placeholder row without a name, whatever its value", () => {
    const form = {
      ...formFromService("svc", { preset: "github" }),
      placeholders: [{ name: "", value: "mindroom-brokered" }],
    };
    expect(validateService(form, personal, newService)).toEqual([]);
    expect(serializeService(form, personal)).toEqual({ preset: "github" });
  });

  it("requires an account login to look like a provider id", () => {
    for (const oauthProvider of ["GitHub", "git hub", "-x", "a/b"])
      expect(errorsFor(null, { rules: [validRule()], oauthProvider })).toEqual([
        "Account login must be a provider id such as github or google_drive (lowercase letters, digits, - and _)",
      ]);
    expect(
      errorsFor(null, { rules: [validRule()], oauthProvider: "google_drive" }),
    ).toEqual([]);
    // A shared agent sends no login, so a stale value cannot block the save.
    expect(
      errorsFor(
        null,
        { rules: [validRule()], oauthProvider: "GitHub" },
        sharedPersonal,
      ),
    ).toEqual([]);
  });

  it.each([
    "Host",
    "content-length",
    "Transfer-Encoding",
    "proxy-authorization",
  ])("refuses the broker's header %s", (name) => {
    expect(
      errorsFor(null, {
        rules: [{ ...validRule(), authType: "header", headerOrParam: name }],
      }),
    ).toEqual([`Header name ${name} is reserved for the broker`]);
  });

  it("caps GitHub owner and repository names", () => {
    const owner = "o".repeat(40);
    const repo = "r".repeat(101);
    const none = { uploads: false, graphql: false };
    expect(githubRepositoryRules(`${owner}/r`, none).errors).toEqual([
      `${owner}/r is too long: GitHub owners have at most 39 characters and repositories 100`,
    ]);
    expect(githubRepositoryRules(`o/${repo}`, none).errors).toHaveLength(1);
    expect(
      githubRepositoryRules(`${"o".repeat(39)}/${"r".repeat(100)}`, none)
        .errors,
    ).toEqual([]);
    expect(githubRepositoryRules(`${owner}/*`, none).errors).toHaveLength(1);
  });
});

describe("where each problem is shown", () => {
  const rule = (changes: object) => ({ ...validRule(), ...changes });
  const fields = (changes: Partial<EgressServiceForm>) =>
    problemsFor(null, changes).map((problem) => problem.field);

  it("builds one id per rule field and placeholder field", () => {
    expect(ruleField(2, "host")).toBe("rule:2:host");
    expect(placeholderField(0, "value")).toBe("placeholder:0:value");
  });

  it("ties a problem to the field that shows it", () => {
    expect(problemsFor({ preset: "github" }, { name: "" })).toEqual([
      { field: "name", message: "Name is required" },
    ]);
    expect(fields({ rules: [rule({ host: "" })] })).toEqual(["rule:0:host"]);
    expect(fields({ rules: [validRule(), rule({ host: "" })] })).toEqual([
      "rule:1:host",
    ]);
    expect(fields({ rules: [rule({ pathPrefix: "v1" })] })).toEqual([
      "rule:0:pathPrefix",
    ]);
    expect(fields({ rules: [rule({ port: "0" })] })).toEqual(["rule:0:port"]);
    expect(fields({ rules: [rule({ authType: "basic" })] })).toEqual([
      "rule:0:username",
    ]);
    expect(fields({ rules: [rule({ authType: "header" })] })).toEqual([
      "rule:0:authName",
    ]);
    expect(fields({ rules: [rule({ authType: "query" })] })).toEqual([
      "rule:0:authName",
    ]);
    expect(
      fields({
        rules: [
          rule({ authType: "header", headerOrParam: "x", template: "none" }),
        ],
      }),
    ).toEqual(["rule:0:template"]);
    expect(fields({ rules: [] })).toEqual(["rules"]);
    expect(fields({ rules: [validRule()], oauthProvider: "Git Hub" })).toEqual([
      "oauthProvider",
    ]);
  });

  it("ties a placeholder problem to its name or its value", () => {
    const rows = (...placeholders: [string, string][]) => ({
      rules: [validRule()],
      placeholders: placeholders.map(([name, value]) => ({ name, value })),
    });
    expect(fields(rows(["LD_PRELOAD", "x"]))).toEqual(["placeholder:0:name"]);
    expect(fields(rows(["MY_API_KEY", "has space"]))).toEqual([
      "placeholder:0:value",
    ]);
    expect(
      fields(rows(["MY_API_KEY", "a"], ["MY_API_KEY", "b"], ["x", "y"])),
    ).toEqual(["placeholder:1:name", "placeholder:2:name"]);
  });

  it("keeps the size problem for the form as a whole", () => {
    expect(
      problemsFor(null, {
        rules: [validRule()],
        description: "x".repeat(17 * 1024),
      }),
    ).toEqual([
      { field: "form", message: "A service can take at most 16 KiB" },
    ]);
  });

  it("gives a lowercase personal placeholder the server's wording, not a pattern", () => {
    expect(
      errorsFor(
        { preset: "github" },
        {
          placeholders: [{ name: "my_key", value: "x" }],
        },
      ),
    ).toEqual([
      "my_key is not allowed as a placeholder: name a credential, such as MY_API_KEY, with TOKEN, KEY, SECRET, PASSWORD, PAT, AUTH, or CREDENTIAL as one of its words.",
    ]);
  });
});

describe("the way the key is sent", () => {
  const header = (template?: string): AuthoredEgressService => ({
    rules: [
      {
        host: "api.example.com",
        auth: { type: "header", name: "Authorization", template },
      },
    ],
  });

  it("shows a header with a custom template as a custom template", () => {
    expect(
      formFromService("svc", header("Token {secret}")).rules[0],
    ).toMatchObject({
      authType: "template",
      headerOrParam: "Authorization",
    });
    expect(formFromService("svc", header()).rules[0].authType).toBe("header");
    expect(formFromService("svc", header("{secret}")).rules[0].authType).toBe(
      "header",
    );
  });

  it("writes a custom template as header auth with its template", () => {
    const service = header("Token {secret}");
    expect(serialize(service)).toEqual(service);
  });

  it("drops a custom template when the user chooses Header", () => {
    const custom = formFromService("svc", header("Token {secret}")).rules[0];
    expect(applyAuthChoice(custom, "header")).toMatchObject({
      authType: "header",
      template: "",
    });
    expect(applyAuthChoice(custom, "bearer").authType).toBe("bearer");
    expect(applyAuthChoice(emptyRule(), "template").authType).toBe("template");
  });

  it("asks a custom template for its template, with the key once", () => {
    const custom = (template: string) => ({
      rules: [
        {
          ...validRule(),
          authType: "template" as const,
          headerOrParam: "Authorization",
          template,
        },
      ],
    });
    expect(errorsFor(null, custom(""))).toEqual([
      "Template must contain {secret} exactly once",
    ]);
    expect(errorsFor(null, custom("Token"))).toEqual([
      "Template must contain {secret} exactly once",
    ]);
    expect(errorsFor(null, custom("Token {secret}"))).toEqual([]);
    expect(
      problemsFor(null, custom("")).map((problem) => problem.field),
    ).toEqual(["rule:0:template"]);
  });

  it("needs a header name for a custom template too", () => {
    expect(
      errorsFor(null, {
        rules: [
          { ...validRule(), authType: "template", template: "Token {secret}" },
        ],
      }),
    ).toEqual(["Header auth needs a header name"]);
  });
});

describe("suggesting a name", () => {
  const form = (
    preset: string,
    host: string,
    changes: Partial<EgressServiceForm> = {},
  ) => ({
    ...formFromService("", null),
    preset,
    rules: [{ ...validRule(), host }],
    ...changes,
  });

  it("uses the preset id, then the host's first label", () => {
    expect(suggestedName(form("github", ""))).toBe("github");
    expect(suggestedName(form("google_drive", "ignored.example.com"))).toBe(
      "google_drive",
    );
    expect(suggestedName(form("", "httpbin.org"))).toBe("httpbin");
    expect(suggestedName(form("", " API.Example.com "))).toBe("api");
  });

  it("skips a wildcard and drops what a name cannot hold", () => {
    expect(suggestedName(form("", "*.example.com"))).toBe("example");
    expect(suggestedName(form("", "my_host-1.example.com"))).toBe("my_host-1");
    expect(suggestedName(form("", "localhost:8080"))).toBe("localhost");
    expect(suggestedName(form("", "-odd.example.com"))).toBe("odd");
    expect(suggestedName(form("", "*"))).toBe("");
  });

  it("suggests nothing without a preset or a host", () => {
    expect(suggestedName(form("", ""))).toBe("");
    expect(suggestedName({ ...form("", ""), rules: [] })).toBe("");
  });
});

describe("a placeholder the administrator also sets", () => {
  const config = { GH_TOKEN: "GitHub" };

  it("warns with the service's display name", () => {
    expect(configPlaceholderWarning("GH_TOKEN", config)).toBe(
      "GH_TOKEN is also set by GitHub from your administrator; when both are set, theirs is used.",
    );
    expect(configPlaceholderWarning(" GH_TOKEN ", config)).toContain(
      "GH_TOKEN is also set by GitHub",
    );
  });

  it("stays quiet for any other name, including inherited object keys", () => {
    expect(configPlaceholderWarning("MY_API_KEY", config)).toBeNull();
    expect(configPlaceholderWarning("", config)).toBeNull();
    expect(configPlaceholderWarning("constructor", config)).toBeNull();
  });
});

describe("finding who sets a placeholder in a listing", () => {
  const listed = (
    source: "config" | "user" | undefined,
    display_name: string,
    placeholder_names?: string[],
  ) => ({ source, display_name, placeholder_names });

  it("maps each variable to the administrator's service that sets it", () => {
    expect(
      configPlaceholderOwners([
        listed("config", "GitHub", ["GH_TOKEN", "GITHUB_TOKEN"]),
        listed("config", "Other", ["GH_TOKEN", "OTHER_KEY"]),
      ]),
    ).toEqual({
      GH_TOKEN: "GitHub",
      GITHUB_TOKEN: "GitHub",
      OTHER_KEY: "Other",
    });
  });

  it("ignores the user's own services and services that list none", () => {
    expect(
      configPlaceholderOwners([
        listed("user", "Mine", ["MY_KEY"]),
        listed(undefined, "Old", ["OLD_KEY"]),
        listed("config", "Plain"),
      ]),
    ).toEqual({});
  });

  it("keeps a variable named like an inherited object key", () => {
    expect(
      configPlaceholderOwners([listed("config", "Odd", ["constructor"])]),
    ).toEqual({
      constructor: "Odd",
    });
  });
});

describe("the note on whose service this is", () => {
  it("names the agent that owns a user_agent service", () => {
    expect(scopeNote("user_agent", "Code", ["Code"])).toBe(
      "Only your Code uses this service and its key.",
    );
  });

  it("lists the agents that share a user's workspace", () => {
    expect(scopeNote("user", "Code", ["Code", "Research", "Notes"])).toBe(
      "All your agents that share your personal workspace use this service and its key: Code, Research, Notes.",
    );
    expect(scopeNote("user", "Code", [])).toBe(
      "All your agents that share your personal workspace use this service and its key: Code.",
    );
  });

  it("says nothing for shared, unscoped, or unknown scopes", () => {
    expect(scopeNote("shared", "Team", [])).toBeNull();
    expect(scopeNote("unscoped", "Team", [])).toBeNull();
    expect(scopeNote(undefined, "Team", [])).toBeNull();
  });
});

describe("offering the GitHub helper", () => {
  const withHost = (
    host: string,
    changes: Partial<EgressServiceForm> = {},
  ) => ({
    ...formFromService("svc", null),
    rules: [{ ...validRule(), host }],
    ...changes,
  });

  it("is for the GitHub preset and for rules on a GitHub host", () => {
    expect(looksLikeGithub(formFromService("svc", { preset: "github" }))).toBe(
      true,
    );
    for (const host of ["github.com", "api.github.com", "uploads.github.com"])
      expect(looksLikeGithub(withHost(host))).toBe(true);
    expect(looksLikeGithub(withHost(" API.GitHub.com "))).toBe(true);
  });

  it("is hidden for other hosts and for an empty host", () => {
    expect(looksLikeGithub(withHost("httpbin.org"))).toBe(false);
    expect(looksLikeGithub(withHost(""))).toBe(false);
    expect(looksLikeGithub(withHost("gist.github.com"))).toBe(false);
  });

  it("looks at the rules only while the service uses its own", () => {
    const kept = withHost("github.com", { preset: "openai" });
    expect(looksLikeGithub(kept)).toBe(false);
    expect(looksLikeGithub({ ...kept, replacePresetRules: true })).toBe(true);
    expect(
      looksLikeGithub({ ...withHost("httpbin.org"), preset: "github" }),
    ).toBe(true);
  });
});

describe("labels from the repositories a service is limited to", () => {
  it("names them in the display name and the description", () => {
    expect(githubLimitLabels(["o/a"])).toEqual({
      displayName: "GitHub (o/a)",
      description: "Limited to o/a",
    });
    expect(githubLimitLabels(["o/a", "o/b", "p/*"])).toEqual({
      displayName: "GitHub (o/a, o/b, p/*)",
      description: "Limited to o/a, o/b, p/*",
    });
  });

  it("collects each repository once, without a .git suffix", () => {
    expect(
      githubRepositoryRules("o/a\no/b.git\no/a\np/*", {
        uploads: false,
        graphql: false,
      }).repositories,
    ).toEqual(["o/a", "o/b", "p/*"]);
  });
});

describe("knowing when the form uses more than the basic fields", () => {
  const blank = formFromService("svc", null);

  it("is false for a new service and for a bare preset", () => {
    expect(usesMoreOptions(blank)).toBe(false);
    expect(usesMoreOptions(formFromService("svc", { preset: "github" }))).toBe(
      false,
    );
  });

  it.each<[string, Partial<EgressServiceForm>]>([
    ["a display name", { displayName: "Mine" }],
    ["a description", { description: "Mine" }],
    ["a path prefix", { rules: [{ ...validRule(), pathPrefix: "/v1" }] }],
    ["a port", { rules: [{ ...validRule(), port: "8443" }] }],
    ["a second rule", { rules: [validRule(), validRule()] }],
    ["replaced preset rules", { preset: "openai", replacePresetRules: true }],
    ["the restriction", { restrictToRules: true }],
    ["an account login", { oauthProvider: "github" }],
    ["a placeholder", { placeholders: [{ name: "A_KEY", value: "x" }] }],
  ])("is true with %s", (_name, changes) => {
    expect(usesMoreOptions({ ...blank, ...changes })).toBe(true);
  });
});

describe("suggesting a free name", () => {
  const form = (preset: string, host = "") => ({
    ...formFromService("", null),
    preset,
    rules: [{ ...validRule(), host }],
  });

  it("takes the first of base, base-2, and base-3 that is free", () => {
    expect(suggestedName(form("github"), [])).toBe("github");
    expect(suggestedName(form("github"), ["openai"])).toBe("github");
    expect(suggestedName(form("github"), ["github"])).toBe("github-2");
    expect(suggestedName(form("github"), ["github", "github-2"])).toBe(
      "github-3",
    );
    // A later gap does not matter: the order is base, -2, -3.
    expect(
      suggestedName(form("", "httpbin.org"), ["httpbin", "httpbin-3"]),
    ).toBe("httpbin-2");
  });

  it("falls back to the base, so the clash is named, when all three are taken", () => {
    expect(
      suggestedName(form("github"), ["github", "github-2", "github-3"]),
    ).toBe("github");
  });

  it("keeps the suffix inside the 63 characters a name may have", () => {
    const base = "a".repeat(63);
    const name = suggestedName(form("", `${base}.example.com`), [base]);
    expect(name).toBe(`${"a".repeat(61)}-2`);
    expect(name).toHaveLength(63);
  });

  it("suggests nothing, and no suffix, without a base", () => {
    expect(suggestedName(form("", ""), [""])).toBe("");
  });
});

describe("a placeholder the preset sets that an administrator's service also sets", () => {
  const github = presets.find((preset) => preset.id === "github");
  const config = { GH_TOKEN: "GitHub", GITHUB_TOKEN: "Work GitHub" };
  const warnings = (
    changes: Partial<EgressServiceForm>,
    owners: Record<string, string> = config,
  ) =>
    presetPlaceholderWarnings(
      { ...formFromService("svc", { preset: "github" }), ...changes },
      github,
      owners,
    );

  it("warns for each variable the preset sets, in the preset's order", () => {
    expect(warnings({})).toEqual([
      "GH_TOKEN is also set by GitHub from your administrator; when both are set, theirs is used.",
      "GITHUB_TOKEN is also set by Work GitHub from your administrator; when both are set, theirs is used.",
    ]);
    expect(warnings({}, { GITHUB_TOKEN: "GitHub" })).toHaveLength(1);
    expect(warnings({}, {})).toEqual([]);
  });

  it("says nothing once the service lists its own placeholders or drops the preset's", () => {
    expect(
      warnings({ placeholders: [{ name: "MY_API_KEY", value: "x" }] }),
    ).toEqual([]);
    expect(
      warnings({
        explicitlyEmpty: {
          ...formFromService("svc", null).explicitlyEmpty,
          placeholders: true,
        },
      }),
    ).toEqual([]);
  });

  it("says nothing without a preset or while the presets load", () => {
    const custom = formFromService("svc", null);
    expect(presetPlaceholderWarnings(custom, github, config)).toEqual([]);
    expect(
      presetPlaceholderWarnings(
        formFromService("svc", { preset: "github" }),
        undefined,
        config,
      ),
    ).toEqual([]);
  });
});

describe("which problems the basic fields show", () => {
  it("lists the name and the first rule's host and way of sending", () => {
    expect(BASIC_RULE_PARTS).toEqual([
      "host",
      "username",
      "authName",
      "template",
    ]);
    for (const field of [
      "name",
      ...BASIC_RULE_PARTS.map((part) => ruleField(0, part)),
    ])
      expect(isBasicField(field)).toBe(true);
  });

  it("leaves everything else to More options", () => {
    for (const field of [
      ruleField(0, "pathPrefix"),
      ruleField(0, "port"),
      ruleField(1, "host"),
      ruleField(1, "authName"),
      "rules",
      "oauthProvider",
      "form",
      placeholderField(0, "name"),
    ])
      expect(isBasicField(field)).toBe(false);
  });
});

describe("the display name a new custom service gets", () => {
  const add = (service: AuthoredEgressService, options: Options = personal) =>
    serializeService(formFromService("svc", service), options);

  it("is the first rule's host, lowercased, and not a title-cased name", () => {
    expect(
      add({ rules: [{ ...bearerRule, host: "Echo-Test.example.com" }] }),
    ).toMatchObject({ display_name: "echo-test.example.com" });
  });

  it("gives way to a display name that is typed", () => {
    expect(
      add({ display_name: "Echo", rules: [bearerRule] }).display_name,
    ).toBe("Echo");
  });

  it("is left to the server for a preset, and for a service that is edited", () => {
    expect(add({ preset: "openai" })).toEqual({ preset: "openai" });
    expect(serialize({ rules: [bearerRule] })).toEqual({ rules: [bearerRule] });
  });

  it("is left alone for a display name emptied on purpose", () => {
    expect(
      add({ display_name: null, rules: [bearerRule] }).display_name,
    ).toBeNull();
    expect(add({ display_name: "", rules: [bearerRule] }).display_name).toBe(
      "",
    );
  });

  it("is written on the dashboard too", () => {
    expect(add({ rules: [bearerRule] }, operator).display_name).toBe(
      "api.example.com",
    );
  });
});

describe("what the Website field keeps", () => {
  it.each([
    ["httpbin.org", "httpbin.org"],
    ["https://httpbin.org", "httpbin.org"],
    ["http://httpbin.org/anything", "httpbin.org"],
    ["https://httpbin.org/a?b=1#c", "httpbin.org"],
    ["httpbin.org/anything", "httpbin.org"],
    ["httpbin.org?x=1", "httpbin.org"],
    ["https://api.example.com:8443/v1", "api.example.com:8443"],
    ["*.example.com/x", "*.example.com"],
    ["https://", ""],
    ["https:/", "https:"],
    ["", ""],
  ])("turns %j into %j", (typed, kept) => {
    expect(stripHostInput(typed)).toBe(kept);
  });
});

describe("a service that only limits paths", () => {
  const limit: AuthoredEgressService = {
    display_name: "GitHub (a/b)",
    description: "Limited to a/b",
    rules: githubRepositoryRules("a/b", { uploads: false, graphql: false })
      .rules,
    restrict_to_rules: true,
    restrict_only: true,
  };

  it("round-trips through the form, with restrict_only and the restriction on", () => {
    const form = formFromService("github-limited", limit);
    expect(form.restrictOnly).toBe(true);
    expect(form.restrictToRules).toBe(true);
    expect(serializeService(form, personal, limit)).toEqual(limit);
  });

  it("writes no login, placeholders, or preset, whatever the form holds", () => {
    const form = {
      ...formFromService("github-limited", limit),
      oauthProvider: "github",
      placeholders: [{ name: "GH_TOKEN", value: "mindroom-brokered" }],
      preset: "github",
    };
    expect(serializeService(form, personal, limit)).toEqual(limit);
    const written = serializeService(form, personal, limit);
    expect(written).not.toHaveProperty("oauth_provider");
    expect(written).not.toHaveProperty("placeholder_env");
  });

  it("starts a new one with no rules, and needs repositories to be saved", () => {
    const form = {
      ...formFromService("github-limited", null),
      restrictOnly: true,
      rules: [],
    };
    expect(validateService(form, personal, newService)).toEqual([
      {
        field: "rules",
        message: "Enter at least one repository, such as owner/repo",
      },
    ]);
  });

  it("checks only the name otherwise, since the helper wrote the rules", () => {
    const form = { ...formFromService("Bad Name", limit) };
    expect(
      validateService(form, personal, newService).map((p) => p.field),
    ).toEqual(["name"]);
    expect(
      validateService(formFromService("github-limited", limit), personal, {
        editing: true,
        takenNames: ["github-limited"],
      }),
    ).toEqual([]);
  });

  it("does not make the other forms restrict-only", () => {
    expect(formFromService("svc", { rules: [bearerRule] }).restrictOnly).toBe(
      false,
    );
    expect(
      serializeService(
        formFromService("svc", { rules: [bearerRule] }),
        personal,
      ),
    ).not.toHaveProperty("restrict_only");
  });
});

describe("services of the agent that already send a key to a website", () => {
  const rule = (host: string, auth_type: string | null = "bearer") => ({
    host,
    port: null,
    path_prefix: "/",
    auth_type: auth_type as "bearer" | null,
    auth_name: null,
  });
  const listed = (
    name: string,
    display_name: string,
    rules: ReturnType<typeof rule>[],
    restrict_only = false,
  ) => ({ name, display_name, rules, restrict_only });
  const form = (service: AuthoredEgressService | null = null) =>
    formFromService("svc", service ?? { rules: [bearerRule] });

  it("names each such service once with the websites they share", () => {
    expect(
      overlapWarnings(
        formFromService("svc", {
          rules: [
            { host: "API.github.com", auth: { type: "bearer" } },
            { host: "github.com", auth: { type: "basic", username: "x" } },
          ],
        }),
        undefined,
        [
          listed("github", "GitHub", [
            rule("api.github.com"),
            rule("github.com", "basic"),
            rule("uploads.github.com"),
          ]),
          listed("other", "Other", [rule("other.example.com")]),
        ],
        undefined,
      ),
    ).toEqual([
      "GitHub already sends a key to api.github.com and github.com for this agent. The most specific path wins, and equal paths go to the service listed first.",
    ]);
  });

  it("reads a preset's websites when the form uses the preset's rules", () => {
    const github = presets.find((preset) => preset.id === "github");
    expect(
      overlapWarnings(
        formFromService("svc", { preset: "github" }),
        github,
        [listed("mine", "Mine", [rule("uploads.github.com")])],
        undefined,
      ),
    ).toEqual([
      "Mine already sends a key to uploads.github.com for this agent. The most specific path wins, and equal paths go to the service listed first.",
    ]);
    expect(
      overlapWarnings(
        formFromService("svc", { preset: "github" }),
        undefined,
        [listed("mine", "Mine", [rule("uploads.github.com")])],
        undefined,
      ),
    ).toEqual([]);
  });

  it("skips a service that only limits paths, one that sends no key, the one being edited, and an empty host", () => {
    const others = [
      listed("limit", "Limit", [rule("api.example.com")], true),
      listed("nokey", "NoKey", [rule("api.example.com", null)]),
      listed("self", "Self", [rule("api.example.com")]),
    ];
    expect(overlapWarnings(form(), undefined, others, "self")).toEqual([]);
    expect(
      overlapWarnings(
        formFromService("svc", {
          rules: [{ host: " ", auth: { type: "bearer" } }],
        }),
        undefined,
        [listed("a", "A", [rule("")])],
        undefined,
      ),
    ).toEqual([]);
  });

  it("does not compare services whose listing has no rules", () => {
    expect(
      overlapWarnings(
        form(),
        undefined,
        [{ name: "old", display_name: "Old", rules: undefined }],
        undefined,
      ),
    ).toEqual([]);
  });
});
