import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import egressPresets from "@/test/fixtures/egressPresets.json";
import { EgressCredentials } from "./EgressCredentials";
import { githubRepositoryRules } from "./egressServiceModel";
import type {
  AuthoredEgressService,
  EgressCredentialAgent,
  EgressCredentialService,
  EgressLogRecord,
  EgressOAuthStatus,
} from "./types";

const service = {
  name: "github",
  display_name: "GitHub",
  description: "GitHub API",
  is_shared: false,
  can_manage: true,
  configured: false,
  updated_at: null,
  active_source: null,
  key_configured: false,
  key_updated_at: null,
  oauth: null,
} satisfies EgressCredentialService;
const account: EgressOAuthStatus = {
  provider: "github",
  display_name: "GitHub",
  connected: false,
  account_label: null,
  can_connect: true,
  reset_required: false,
  service_account: false,
  unavailable_reason: null,
  shared_worker_opt_in: false,
};
const agents: EgressCredentialAgent[] = [
  {
    agent_name: "personal",
    agent_display_name: "Personal Mind",
    shared: false,
    scope: "user_agent",
    scope_agents: [],
    managers: [],
    can_manage: true,
    services: [service],
  },
  {
    agent_name: "shared_dev",
    agent_display_name: "Shared Dev",
    shared: true,
    scope: "shared",
    scope_agents: [],
    managers: [],
    can_manage: false,
    services: [{ ...service, is_shared: true, can_manage: false }],
  },
  {
    agent_name: "bare",
    agent_display_name: "Bare Agent",
    shared: false,
    scope: "user_agent",
    scope_agents: [],
    managers: [],
    can_manage: true,
    services: [],
  },
];

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

const identity = {
  matrix_user_id: "@bob:example.org",
  email: "bob@example.org",
  is_administrator: false,
};

beforeEach(() => {
  vi.mocked(fetch).mockImplementation(async (input) => {
    if (String(input) === "/api/connections/egress") return json({ agents });
    if (String(input) === "/api/connections/me") return json(identity);
    throw new Error(`Unexpected request: ${String(input)}`);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("egress credentials page", () => {
  it("renders one section per agent with its services", async () => {
    render(<EgressCredentials />);
    const personal = await screen.findByRole("region", {
      name: "Personal Mind",
    });
    expect(
      within(personal).getByRole("button", { name: "Set key for GitHub" }),
    ).toBeInTheDocument();
    const shared = screen.getByRole("region", { name: "Shared Dev" });
    expect(within(shared).getByText("Not set")).toBeInTheDocument();
    // Nobody who cannot manage the agent can change anything on it, but the log is theirs.
    expect(
      within(shared)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Recent requests"]);
    expect(screen.getAllByRole("region")).toHaveLength(3);
    expect(
      within(screen.getByRole("region", { name: "Bare Agent" })).getByText(
        "No services are configured yet.",
      ),
    ).toBeInTheDocument();
  });

  it("explains when no agent is available", async () => {
    vi.mocked(fetch).mockImplementation(async () => json({ agents: [] }));
    render(<EgressCredentials />);
    expect(
      await screen.findByText(
        "No agents with shell or python access are available to you.",
      ),
    ).toBeInTheDocument();
  });

  it("shows an error when the listing cannot be loaded", async () => {
    vi.mocked(fetch).mockImplementation(async () => json({}, 500));
    render(<EgressCredentials />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not complete the request",
    );
  });

  it("reloads the listing after a key is saved", async () => {
    let configured = false;
    vi.mocked(fetch).mockImplementation(async (_input, options) => {
      if (options?.method === "PUT") {
        configured = true;
        return new Response(null, { status: 204 });
      }
      return json({
        agents: [
          {
            ...agents[0],
            services: [
              {
                ...service,
                configured,
                key_configured: configured,
                active_source: configured ? "key" : null,
              },
            ],
          },
        ],
      });
    });
    render(<EgressCredentials />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Set key for GitHub" }),
    );
    fireEvent.change(screen.getByLabelText("GitHub API key"), {
      target: { value: "abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Replace key for GitHub" }),
      ).toBeInTheDocument(),
    );
  });

  it("reloads the listing after an account is connected and disconnected", async () => {
    let connected = false;
    const popup = {
      closed: false,
      close: vi.fn(),
      location: { href: "about:blank" },
    };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const path = String(input);
      if (path.endsWith("/connect"))
        return json({
          provider: "github",
          auth_url: "https://github.com/login/oauth/authorize",
          completion_origin: "https://portal.example.com",
        });
      if (path.endsWith("/disconnect")) {
        connected = false;
        return json({ status: "disconnected", provider: "github" });
      }
      expect(options?.method ?? "GET").toBe("GET");
      return json({
        agents: [
          {
            ...agents[0],
            services: [
              {
                ...service,
                configured: connected,
                active_source: connected ? "oauth" : null,
                oauth: {
                  ...account,
                  connected,
                  account_label: connected ? "octocat" : null,
                },
              },
            ],
          },
        ],
      });
    });
    render(<EgressCredentials />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect GitHub for GitHub" }),
    );
    await waitFor(() =>
      expect(popup.location.href).toBe(
        "https://github.com/login/oauth/authorize",
      ),
    );
    connected = true;
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://portal.example.com",
        source: popup as unknown as Window,
        data: {
          type: "mindroom:oauth-complete",
          provider: "github",
          status: "connected",
        },
      }),
    );
    expect(await screen.findByText("Connected as octocat")).toBeInTheDocument();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input]) => String(input) === "/api/connections/egress",
        ),
    ).toHaveLength(2);

    fireEvent.click(
      screen.getByRole("button", { name: "Disconnect for GitHub" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Disconnect",
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Connect GitHub for GitHub" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Connected as/)).toBeNull();
  });
});

const userService: EgressCredentialService = {
  ...service,
  name: "mine",
  display_name: "My API",
  description: "My own API",
  source: "user",
};
const configService: EgressCredentialService = {
  ...service,
  source: "config",
  rules: [{ host: "api.github.com", port: null, path_prefix: "/" }],
};

const SERVICES = "/api/connections/egress/agents/personal/services";
const KEYS = "/api/connections/egress/agents/personal";
const PRESETS = "/api/connections/egress/presets";
const presetsReady = () =>
  waitFor(() => expect(screen.getByLabelText("Preset")).toBeEnabled());

describe("egress services on the personal page", () => {
  let listing: EgressCredentialAgent[];
  let authored: Record<string, AuthoredEgressService>;
  let mutation: (
    method: string,
    path: string,
    body: unknown,
  ) => Response | Promise<Response>;
  let calls: { method: string; path: string; body: unknown }[];
  let presets: () => Response;

  beforeEach(() => {
    presets = () => json(egressPresets);
    listing = [
      {
        agent_name: "personal",
        agent_display_name: "Personal Mind",
        shared: false,
        scope: "user_agent",
        scope_agents: [],
        managers: [],
        can_manage: true,
        services: [configService, userService],
      },
    ];
    authored = { mine: { preset: "openai", restrict_to_rules: true } };
    mutation = () => new Response(null, { status: 204 });
    calls = [];
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const path = String(input);
      const method = options?.method ?? "GET";
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({ method, path, body });
      if (path === "/api/connections/egress") return json({ agents: listing });
      if (path === PRESETS) return presets();
      if (method === "GET" && path.startsWith(`${SERVICES}/`))
        return json(authored[decodeURIComponent(path.split("/").pop() ?? "")]);
      if (path.startsWith(SERVICES) || path.startsWith(`${KEYS}/`))
        return mutation(method, path, body);
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
  });

  const personal = () => screen.findByRole("region", { name: "Personal Mind" });
  const writes = () => calls.filter((call) => call.method !== "GET");

  it("adds a service and reloads the listing", async () => {
    render(<EgressCredentials />);
    fireEvent.click(
      within(await personal()).getByRole("button", {
        name: "Add service for Personal Mind",
      }),
    );
    await presetsReady();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "gh" },
    });
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "github" },
    });
    listing[0].services = [
      ...listing[0].services,
      { ...userService, name: "gh", display_name: "GitHub work" },
    ];
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));

    expect(await screen.findByLabelText("GitHub work")).toBeInTheDocument();
    expect(writes()).toEqual([
      { method: "PUT", path: `${SERVICES}/gh`, body: { preset: "github" } },
    ]);
    // The editor closes once the service is saved.
    expect(screen.queryByRole("form")).toBeNull();
    expect(
      calls.filter((call) => call.path === "/api/connections/egress"),
    ).toHaveLength(2);
  });

  describe("with the key in the same step", () => {
    const openAdd = async () => {
      fireEvent.click(
        within(await personal()).getByRole("button", {
          name: "Add service for Personal Mind",
        }),
      );
      await presetsReady();
    };
    const fillOpenAi = (key: string) => {
      fireEvent.change(screen.getByLabelText("Name"), {
        target: { value: "ai" },
      });
      fireEvent.change(screen.getByLabelText("Preset"), {
        target: { value: "openai" },
      });
      if (key)
        fireEvent.change(screen.getByLabelText("API key"), {
          target: { value: key },
        });
      fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    };
    const loads = () =>
      calls.filter((call) => call.path === "/api/connections/egress").length;

    it("saves the service, then the key, then closes the editor", async () => {
      render(<EgressCredentials />);
      await openAdd();
      fillOpenAi("sk-secret");
      await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
      expect(writes()).toEqual([
        { method: "PUT", path: `${SERVICES}/ai`, body: { preset: "openai" } },
        { method: "PUT", path: `${KEYS}/ai`, body: { secret: "sk-secret" } },
      ]);
      // The page reloaded after each write, so the row shows the key.
      expect(loads()).toBe(3);
    });

    it("saves only the service when no key is typed", async () => {
      render(<EgressCredentials />);
      await openAdd();
      fillOpenAi("");
      await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
      expect(writes()).toEqual([
        { method: "PUT", path: `${SERVICES}/ai`, body: { preset: "openai" } },
      ]);
      expect(loads()).toBe(2);
    });

    it("never writes the key when the service is refused", async () => {
      mutation = () =>
        json({ detail: "service name 'ai' is already used" }, 409);
      render(<EgressCredentials />);
      await openAdd();
      fillOpenAi("sk-secret");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "service name 'ai' is already used",
      );
      expect(writes().map((write) => write.path)).toEqual([`${SERVICES}/ai`]);
      expect(screen.getByRole("form", { name: "Add service" })).toBeVisible();
    });

    it("says when only the key failed, and keeps the saved service open for a retry", async () => {
      let keyAttempts = 0;
      mutation = (_method, path) => {
        if (!path.startsWith(SERVICES) && keyAttempts++ === 0)
          return json({ detail: "The key vault is read-only" }, 409);
        return new Response(null, { status: 204 });
      };
      render(<EgressCredentials />);
      await openAdd();
      listing[0].services = [
        ...listing[0].services,
        { ...userService, name: "ai", display_name: "OpenAI" },
      ];
      fillOpenAi("sk-secret");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "The service was saved, but its key was not: The key vault is read-only.",
      );
      // The service is listed already, and the editor stays for the retry.
      expect(await screen.findByLabelText("OpenAI")).toBeInTheDocument();
      expect(screen.getByLabelText("Name")).toBeDisabled();
      expect(screen.getByLabelText("API key")).toHaveValue("sk-secret");

      fireEvent.click(screen.getByRole("button", { name: "Save service" }));
      await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
      // The service was not written twice.
      expect(writes().map((write) => write.path)).toEqual([
        `${SERVICES}/ai`,
        `${KEYS}/ai`,
        `${KEYS}/ai`,
      ]);
    });

    it("sets a key while editing a service", async () => {
      render(<EgressCredentials />);
      fireEvent.click(
        await screen.findByRole("button", { name: "Edit service for My API" }),
      );
      await presetsReady();
      fireEvent.change(screen.getByLabelText("API key"), {
        target: { value: "sk-new" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save service" }));
      await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
      expect(writes().map((write) => write.path)).toEqual([
        `${SERVICES}/mine`,
        `${KEYS}/mine`,
      ]);
      expect(writes()[1].body).toEqual({ secret: "sk-new" });
    });
  });

  describe("the editor's notes", () => {
    const openAdd = async () => {
      fireEvent.click(
        within(await personal()).getByRole("button", {
          name: "Add service for Personal Mind",
        }),
      );
      await presetsReady();
    };

    it("warns about a placeholder an administrator's service also sets", async () => {
      listing[0].services = [
        {
          ...configService,
          placeholder_names: ["GH_TOKEN", "GITHUB_TOKEN"],
        },
        userService,
      ];
      render(<EgressCredentials />);
      await openAdd();
      fireEvent.click(screen.getByRole("button", { name: "More options" }));
      fireEvent.click(screen.getByRole("button", { name: "Add placeholder" }));
      fireEvent.change(screen.getByLabelText("Placeholder 1 name"), {
        target: { value: "GITHUB_TOKEN" },
      });
      expect(
        screen.getByText(
          "GITHUB_TOKEN is also set by GitHub from your administrator; when both are set, theirs is used.",
        ),
      ).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("Placeholder 1 name"), {
        target: { value: "MY_API_KEY" },
      });
      expect(
        screen.queryByText(/from your administrator; when both/),
      ).toBeNull();
    });

    it("does not count the user's own services as the administrator's", async () => {
      listing[0].services = [
        { ...userService, placeholder_names: ["GH_TOKEN"] },
      ];
      render(<EgressCredentials />);
      await openAdd();
      fireEvent.click(screen.getByRole("button", { name: "More options" }));
      fireEvent.click(screen.getByRole("button", { name: "Add placeholder" }));
      fireEvent.change(screen.getByLabelText("Placeholder 1 name"), {
        target: { value: "GH_TOKEN" },
      });
      expect(
        screen.queryByText(/from your administrator; when both/),
      ).toBeNull();
    });

    it("says only this agent uses a user_agent service", async () => {
      render(<EgressCredentials />);
      await openAdd();
      expect(
        screen.getByText(
          "Only your Personal Mind uses this service and its key.",
        ),
      ).toBeInTheDocument();
    });

    it("lists the agents that share a user's store", async () => {
      listing[0].scope = "user";
      listing[0].scope_agents = ["Personal Mind", "Research Mind"];
      render(<EgressCredentials />);
      await openAdd();
      expect(
        screen.getByText(
          "All your agents that share your personal workspace use this service and its key: Personal Mind, Research Mind.",
        ),
      ).toBeInTheDocument();
    });
  });

  it("refuses a name that is already listed before asking the server", async () => {
    render(<EgressCredentials />);
    fireEvent.click(
      within(await personal()).getByRole("button", {
        name: "Add service for Personal Mind",
      }),
    );
    await presetsReady();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "mine" },
    });
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "openai" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription(
      /A service named mine already exists/,
    );
    expect(writes()).toEqual([]);
  });

  it("closes the editor on cancel", async () => {
    render(<EgressCredentials />);
    fireEvent.click(
      within(await personal()).getByRole("button", {
        name: "Add service for Personal Mind",
      }),
    );
    await presetsReady();
    expect(
      screen.getByRole("form", { name: "Add service" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("edits a user service from its authored form and keeps the name", async () => {
    render(<EgressCredentials />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit service for My API" }),
    );
    const form = await screen.findByRole("form", { name: "Edit mine" });
    expect(within(form).getByLabelText("Name")).toBeDisabled();
    expect(within(form).getByLabelText("Preset")).toHaveValue("openai");
    expect(
      within(form).getByLabelText("Refuse other paths on these hosts"),
    ).toBeChecked();
    fireEvent.change(within(form).getByLabelText("Display name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save service" }));
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    expect(writes()).toEqual([
      {
        method: "PUT",
        path: `${SERVICES}/mine`,
        body: {
          preset: "openai",
          display_name: "Renamed",
          restrict_to_rules: true,
        },
      },
    ]);
  });

  it("deletes a user service after confirmation", async () => {
    render(<EgressCredentials />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete service for My API" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("deletes the service and its saved key");
    expect(writes()).toEqual([]);
    listing[0].services = [configService];
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByLabelText("My API")).toBeNull());
    expect(writes()).toEqual([
      { method: "DELETE", path: `${SERVICES}/mine`, body: undefined },
    ]);
  });

  it("deletes from inside the editor too", async () => {
    render(<EgressCredentials />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit service for My API" }),
    );
    await screen.findByRole("form", { name: "Edit mine" });
    listing[0].services = [configService];
    fireEvent.click(screen.getByRole("button", { name: "Delete service" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    expect(writes().map((call) => call.method)).toEqual(["DELETE"]);
  });

  it("shows a failed delete on the row", async () => {
    mutation = () =>
      json({ detail: "Service is not a service of your own" }, 404);
    render(<EgressCredentials />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete service for My API" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "no longer available",
    );
    expect(screen.getByLabelText("My API")).toBeInTheDocument();
  });

  it("shows the administrator's services read-only, without a badge on the row", async () => {
    render(<EgressCredentials />);
    const row = await screen.findByLabelText("GitHub");
    expect(within(row).queryByText(/administrator/)).toBeNull();
    expect(
      within(row).queryByRole("button", { name: /Edit|Delete/ }),
    ).toBeNull();
    // The key can still be set on it, as before.
    expect(
      within(row).getByRole("button", { name: "Set key for GitHub" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("My API")).queryByText(/administrator/),
    ).toBeNull();
  });

  it("offers Add service by the agent's own can_manage flag", async () => {
    listing = [
      {
        agent_name: "readonly",
        agent_display_name: "Read Only",
        shared: true,
        scope: "shared",
        scope_agents: [],
        managers: [],
        can_manage: false,
        services: [{ ...configService, is_shared: true, can_manage: false }],
      },
      {
        agent_name: "readonly_empty",
        agent_display_name: "Read Only Empty",
        shared: true,
        scope: "shared",
        scope_agents: [],
        managers: [],
        can_manage: false,
        services: [],
      },
      {
        agent_name: "managed",
        agent_display_name: "Managed",
        shared: true,
        scope: "shared",
        scope_agents: [],
        managers: [],
        can_manage: true,
        services: [{ ...userService, is_shared: true, can_manage: true }],
      },
      {
        agent_name: "empty",
        agent_display_name: "Empty",
        shared: false,
        scope: "user_agent",
        scope_agents: [],
        managers: [],
        can_manage: true,
        services: [],
      },
    ];
    render(<EgressCredentials />);
    const section = async (name: string) =>
      screen.findByRole("region", { name });
    expect(
      within(await section("Read Only")).queryByRole("button", {
        name: /Add service/,
      }),
    ).toBeNull();
    // An agent without services is told by its own flag, not guessed.
    expect(
      within(await section("Read Only Empty")).queryByRole("button", {
        name: /Add service/,
      }),
    ).toBeNull();
    const managed = await section("Managed");
    expect(
      within(managed).getByRole("button", { name: "Add service for Managed" }),
    ).toBeInTheDocument();
    expect(
      within(managed).getByRole("button", { name: "Edit service for My API" }),
    ).toBeInTheDocument();
    expect(within(managed).getByText("Shared")).toBeInTheDocument();
    expect(
      within(await section("Empty")).getByRole("button", {
        name: "Add service for Empty",
      }),
    ).toBeInTheDocument();
    expect(within(await section("Empty")).queryByText("Shared")).toBeNull();
  });

  it("turns off account login for a service on a shared agent", async () => {
    listing = [
      {
        agent_name: "personal",
        agent_display_name: "Personal Mind",
        shared: true,
        scope: "shared",
        scope_agents: [],
        managers: [],
        can_manage: true,
        services: [{ ...userService, is_shared: true, can_manage: true }],
      },
    ];
    render(<EgressCredentials />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Add service for Personal Mind",
      }),
    );
    await presetsReady();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "gh" },
    });
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "github" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({
      preset: "github",
      oauth_provider: null,
    });
  });

  const limitToRepository = async () => {
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Add service for Personal Mind",
      }),
    );
    await presetsReady();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "limited" },
    });
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "github" },
    });
    fireEvent.change(screen.getByLabelText("GitHub repositories"), {
      target: { value: "o/r" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Use these repositories" }),
    );
  };

  it("says a limit also limits the administrator's services on those hosts", async () => {
    listing[0].services = [
      {
        ...configService,
        rules: [
          { host: "api.github.com", port: null, path_prefix: "/" },
          { host: "github.com", port: null, path_prefix: "/" },
        ],
      },
    ];
    render(<EgressCredentials />);
    await limitToRepository();

    // The helper opened More options, where the restriction and its help are.
    expect(
      screen.getByLabelText("Refuse other paths on these hosts"),
    ).toBeChecked();
    expect(
      screen.getByText(
        /This also limits services from your administrator on these hosts, for this agent only\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it.each<[Partial<EgressCredentialAgent>, string]>([
    [{}, "for this agent only."],
    [
      { scope: "user", scope_agents: ["Personal Mind", "Writer"] },
      "for all your agents that share your personal workspace.",
    ],
    [{ shared: true, scope: "shared" }, "for everyone using this agent."],
    [{ shared: true, scope: "unscoped" }, "for every agent without a scope."],
  ])(
    "tells whom the restriction reaches for the agent's scope (%j)",
    async (change, audience) => {
      listing[0] = { ...listing[0], ...change };
      render(<EgressCredentials />);
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Add service for Personal Mind",
        }),
      );
      await presetsReady();
      fireEvent.click(screen.getByRole("button", { name: "More options" }));
      expect(
        screen
          .getByLabelText("Refuse other paths on these hosts")
          .closest("div"),
      ).toHaveTextContent(
        `This also limits services from your administrator on these hosts, ${audience}`,
      );
    },
  );

  it("shows a name conflict from the server", async () => {
    mutation = () =>
      json(
        {
          detail:
            "service name 'gh' is already used by a service your administrator configured",
        },
        409,
      );
    render(<EgressCredentials />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Add service for Personal Mind",
      }),
    );
    await presetsReady();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "gh" },
    });
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "github" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already used by a service your administrator configured",
    );
    // The editor stays open with the user's input.
    expect(screen.getByLabelText("Name")).toHaveValue("gh");
  });

  it("shows the size limit from the server", async () => {
    mutation = () => json({ detail: "A service can take at most 16 KiB" }, 413);
    render(<EgressCredentials />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Add service for Personal Mind",
      }),
    );
    await presetsReady();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "big" },
    });
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "openai" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A service can take at most 16 KiB",
    );
  });

  it("shows a validation message sent as a string", async () => {
    mutation = () =>
      json({ detail: "rules.0.host: host must not contain scheme" }, 422);
    render(<EgressCredentials />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Add service for Personal Mind",
      }),
    );
    await presetsReady();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "openai" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "rules.0.host: host must not contain scheme",
    );
  });

  it("shows a validation message sent as FastAPI's list without echoing the input", async () => {
    mutation = () =>
      json(
        {
          detail: [
            {
              type: "string_type",
              loc: ["body", "rules", 0, "host"],
              msg: "Input should be a valid string",
              input: "SECRET-INPUT",
            },
            { type: "missing", loc: ["body"], msg: "Field required" },
          ],
        },
        422,
      );
    render(<EgressCredentials />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Add service for Personal Mind",
      }),
    );
    await presetsReady();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "openai" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "rules.0.host: Input should be a valid string; Field required",
    );
    expect(alert).not.toHaveTextContent("SECRET-INPUT");
  });

  const trySaving = async () => {
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Add service for Personal Mind",
      }),
    );
    await presetsReady();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "openai" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
  };

  it("shows why the server refused a write", async () => {
    mutation = () => json({ detail: "Credential management is required" }, 403);
    render(<EgressCredentials />);
    await trySaving();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Credential management is required",
    );
  });

  it("falls back to a general message for a refusal without a reason", async () => {
    mutation = () => json({}, 403);
    render(<EgressCredentials />);
    await trySaving();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You are not allowed to change the services of this agent.",
    );
  });

  it("explains when a service to edit cannot be loaded", async () => {
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input) === "/api/connections/egress"
        ? json({ agents: listing })
        : json({ detail: "Service is not a service of your own" }, 404),
    );
    render(<EgressCredentials />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit service for My API" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "no longer available",
    );
    expect(screen.queryByRole("form")).toBeNull();
  });
});

describe("presets and unsaved edits on the personal page", () => {
  let listing: EgressCredentialAgent[];
  let writeResponse: () => Response | Promise<Response>;
  let calls: { method: string; path: string }[];

  beforeEach(() => {
    listing = [
      {
        agent_name: "personal",
        agent_display_name: "Personal Mind",
        shared: false,
        scope: "user_agent",
        scope_agents: [],
        managers: [],
        can_manage: true,
        services: [
          { ...userService, name: "one", display_name: "One" },
          { ...userService, name: "two", display_name: "Two" },
        ],
      },
    ];
    writeResponse = () => new Response(null, { status: 204 });
    calls = [];
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const path = String(input);
      const method = options?.method ?? "GET";
      calls.push({ method, path });
      if (path === "/api/connections/egress") return json({ agents: listing });
      if (path === PRESETS) return json(egressPresets);
      if (method === "GET") return json({ preset: "openai" });
      return writeResponse();
    });
  });

  const description = () => {
    const more = screen.getByRole("button", { name: "More options" });
    if (more.getAttribute("aria-expanded") === "false") fireEvent.click(more);
    return screen.getByLabelText("Description");
  };
  const edit = async (name: string) => {
    fireEvent.click(
      await screen.findByRole("button", { name: `Edit service for ${name}` }),
    );
    await screen.findByRole("form", { name: `Edit ${name.toLowerCase()}` });
    await presetsReady();
  };
  const presetRequests = () =>
    calls.filter((call) => call.path === PRESETS).length;

  it("fetches the presets from the personal API only when an editor opens", async () => {
    render(<EgressCredentials />);
    await screen.findByRole("button", { name: "Edit service for One" });
    expect(presetRequests()).toBe(0);

    await edit("One");
    expect(presetRequests()).toBe(1);
    expect(
      within(screen.getByLabelText("Preset"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Custom", ...egressPresets.presets.map((p) => p.display_name)]);
  });

  it("keeps Edit and Delete off while a save is running", async () => {
    let finish: (response: Response) => void = () => {};
    writeResponse = () =>
      new Promise<Response>((done) => {
        finish = done;
      });
    render(<EgressCredentials />);
    await edit("One");
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit service for Two" }),
      ).toBeDisabled(),
    );
    expect(
      screen.getByRole("button", { name: "Delete service for One" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete service for Two" }),
    ).toBeDisabled();

    finish(new Response(null, { status: 204 }));
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    expect(
      screen.getByRole("button", { name: "Edit service for Two" }),
    ).toBeEnabled();
    // The write ran to the end: nothing started after it replaced or aborted it.
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("asks before replacing an editor that has unsaved changes", async () => {
    render(<EgressCredentials />);
    await edit("One");
    fireEvent.change(description(), {
      target: { value: "typed but not saved" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Edit service for Two" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You have unsaved changes in the open editor.",
    );
    expect(screen.getByRole("form", { name: "Edit one" })).toBeInTheDocument();
    expect(calls.filter((call) => call.path.endsWith("/services/two"))).toEqual(
      [],
    );

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText(/unsaved changes in the open editor/)).toBeNull();
    expect(description()).toHaveValue("typed but not saved");

    fireEvent.click(
      screen.getByRole("button", { name: "Edit service for Two" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(
      await screen.findByRole("form", { name: "Edit two" }),
    ).toBeInTheDocument();
    expect(description()).toHaveValue("");
    expect(screen.queryByText(/unsaved changes in the open editor/)).toBeNull();
  });

  it("keeps Edit off for the service whose editor is open", async () => {
    render(<EgressCredentials />);
    await edit("One");
    // Opening it again would only offer to throw away what is typed.
    expect(
      screen.getByRole("button", { name: "Edit service for One" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Edit service for Two" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: "Edit service for One" }),
    ).toBeEnabled();
  });

  it("drops the question about another service when the editor is cancelled", async () => {
    render(<EgressCredentials />);
    await edit("One");
    fireEvent.change(description(), {
      target: { value: "typed but not saved" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Edit service for Two" }),
    );
    expect(
      screen.getByText(/unsaved changes in the open editor/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByText(/unsaved changes in the open editor/)).toBeNull();

    // A later editor starts with no question waiting.
    await edit("Two");
    expect(screen.queryByText(/unsaved changes in the open editor/)).toBeNull();
  });

  it("drops the question about another service when the editor's service is deleted", async () => {
    render(<EgressCredentials />);
    await edit("One");
    fireEvent.change(description(), {
      target: { value: "typed but not saved" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Edit service for Two" }),
    );
    listing[0].services = [listing[0].services[1]];
    fireEvent.click(screen.getByRole("button", { name: "Delete service" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    expect(screen.queryByText(/unsaved changes in the open editor/)).toBeNull();
  });

  it("opens another service straight away when nothing was changed", async () => {
    render(<EgressCredentials />);
    await edit("One");
    fireEvent.click(
      screen.getByRole("button", { name: "Edit service for Two" }),
    );
    expect(
      await screen.findByRole("form", { name: "Edit two" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/unsaved changes in the open editor/)).toBeNull();
  });

  it("does not ask again once the changes are undone", async () => {
    render(<EgressCredentials />);
    await edit("One");
    const field = description();
    fireEvent.change(field, { target: { value: "x" } });
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Edit service for Two" }),
    );
    expect(
      await screen.findByRole("form", { name: "Edit two" }),
    ).toBeInTheDocument();
  });
});

describe("what deleting a service says about its scope", () => {
  const open = async (agent: Partial<EgressCredentialAgent>) => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input) === "/api/connections/egress")
        return json({
          agents: [
            {
              agent_name: "personal",
              agent_display_name: "Personal Mind",
              shared: false,
              scope: "user_agent",
              scope_agents: [],
              managers: [],
              can_manage: true,
              services: [userService],
              ...agent,
            },
          ],
        });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<EgressCredentials />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete service for My API" }),
    );
    return (await screen.findByRole("dialog")).textContent;
  };

  it("says the agent alone loses access on a user_agent scope", async () => {
    expect(await open({})).toContain(
      "This deletes the service and its saved key. Your Personal Mind loses access through it.",
    );
  });

  it("names every agent that shares a user scope's workspace", async () => {
    expect(
      await open({
        scope: "user",
        scope_agents: ["Personal Mind", "Writer", "Scripter"],
      }),
    ).toContain(
      "This deletes the service and its saved key. All your agents that share your personal workspace lose access through it: Personal Mind, Writer, Scripter.",
    );
  });

  it.each([
    ["shared", "Everyone using Personal Mind loses access through it."],
    ["unscoped", "Every agent without a scope loses access through it."],
  ] as const)(
    "says who loses access on a %s scope",
    async (scope, consequence) => {
      const text = await open({
        shared: true,
        scope,
        scope_agents: [],
        managers: [],
        can_manage: true,
        services: [{ ...userService, is_shared: true }],
      });
      expect(text).toContain(
        `This deletes the service and its shared key. ${consequence}`,
      );
      expect(text).not.toContain("personal workspace");
    },
  );
});

describe("inactive services on the personal page", () => {
  const inactive = [
    { name: "taken", reason: "shadowed" as const },
    { name: "broken", reason: "invalid" as const },
  ];
  let listing: EgressCredentialAgent[];
  let remove: () => Response | Promise<Response>;
  let save: () => Response | Promise<Response>;
  let calls: { method: string; path: string }[];

  beforeEach(() => {
    listing = [
      {
        agent_name: "personal",
        agent_display_name: "Personal Mind",
        shared: false,
        scope: "user_agent",
        scope_agents: [],
        managers: [],
        can_manage: true,
        services: [configService, userService],
        inactive_services: inactive,
      },
    ];
    remove = () => new Response(null, { status: 204 });
    save = () => new Response(null, { status: 204 });
    calls = [];
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const path = String(input);
      const method = options?.method ?? "GET";
      calls.push({ method, path });
      if (path === "/api/connections/egress") return json({ agents: listing });
      if (method === "DELETE") return remove();
      if (method === "PUT") return save();
      if (path === PRESETS) return json(egressPresets);
      if (path.includes("/services/")) return json({ preset: "openai" });
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
  });

  const section = async () =>
    within(await screen.findByRole("region", { name: "Inactive services" }));
  const deletes = () => calls.filter((call) => call.method === "DELETE");

  it("lists each entry with its reason under the agent's services", async () => {
    render(<EgressCredentials />);
    const inactiveServices = await section();
    expect(inactiveServices.getByRole("heading")).toHaveTextContent("Inactive");
    const taken = inactiveServices.getByLabelText("Inactive service taken");
    expect(taken).toHaveTextContent(
      "your administrator provides a service with this name",
    );
    expect(taken).toHaveTextContent("Inactive");
    expect(
      inactiveServices.getByLabelText("Inactive service broken"),
    ).toHaveTextContent("no longer valid");
    // They are the agent's own entries: they sit inside its section, after its services.
    const agent = screen.getByRole("region", { name: "Personal Mind" });
    expect(agent).toContainElement(
      screen.getByRole("region", { name: "Inactive services" }),
    );
    expect(
      screen
        .getByRole("region", { name: "Inactive services" })
        .compareDocumentPosition(screen.getByLabelText("My API")) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });

  it("shows nothing for an agent without inactive entries, or from an older server", async () => {
    listing[0].inactive_services = [];
    listing.push({
      agent_name: "other",
      agent_display_name: "Other Mind",
      shared: false,
      scope: "user_agent",
      scope_agents: [],
      managers: [],
      can_manage: true,
      services: [],
    });
    render(<EgressCredentials />);
    await screen.findByRole("region", { name: "Other Mind" });
    expect(
      screen.queryByRole("region", { name: "Inactive services" }),
    ).toBeNull();
    expect(screen.queryByText("Inactive")).toBeNull();
  });

  it("deletes a shadowed entry after confirmation, saying the key stays", async () => {
    render(<EgressCredentials />);
    fireEvent.click(
      (await section()).getByRole("button", {
        name: "Delete inactive service taken",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete inactive taken?");
    expect(dialog).toHaveTextContent(
      "The administrator's service with this name stays, and so does the key saved for it.",
    );
    expect(deletes()).toEqual([]);

    listing[0].inactive_services = [inactive[1]];
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Inactive service taken")).toBeNull(),
    );
    expect(deletes()).toEqual([
      {
        method: "DELETE",
        path: "/api/connections/egress/agents/personal/services/taken",
      },
    ]);
    // The list is read again, and the other entry is still there.
    expect(
      calls.filter((call) => call.path === "/api/connections/egress"),
    ).toHaveLength(2);
    expect(
      screen.getByLabelText("Inactive service broken"),
    ).toBeInTheDocument();
  });

  it("deletes an invalid entry, saying its key goes too", async () => {
    render(<EgressCredentials />);
    fireEvent.click(
      (await section()).getByRole("button", {
        name: "Delete inactive service broken",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      "removes the invalid entry and any key saved under its name",
    );
    listing[0].inactive_services = [inactive[0]];
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Inactive service broken")).toBeNull(),
    );
    expect(deletes().map((call) => call.path)).toEqual([
      "/api/connections/egress/agents/personal/services/broken",
    ]);
  });

  it("does not delete when the confirmation is cancelled", async () => {
    render(<EgressCredentials />);
    fireEvent.click(
      (await section()).getByRole("button", {
        name: "Delete inactive service taken",
      }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(deletes()).toEqual([]);
    expect(screen.getByLabelText("Inactive service taken")).toBeInTheDocument();
  });

  it("shows why a delete failed and keeps the entry", async () => {
    remove = () =>
      json({ detail: "Service is not a service of your own" }, 404);
    render(<EgressCredentials />);
    fireEvent.click(
      (await section()).getByRole("button", {
        name: "Delete inactive service taken",
      }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    expect(
      await within(screen.getByLabelText("Inactive service taken")).findByRole(
        "alert",
      ),
    ).toHaveTextContent("no longer available");
    expect(
      screen.getByRole("button", { name: "Delete inactive service taken" }),
    ).toBeEnabled();
  });

  it("lists the entries without Delete when the caller cannot manage the agent", async () => {
    listing = [
      {
        agent_name: "personal",
        agent_display_name: "Personal Mind",
        shared: true,
        scope: "shared",
        scope_agents: [],
        managers: [],
        can_manage: false,
        services: [{ ...configService, is_shared: true, can_manage: false }],
        inactive_services: inactive,
      },
    ];
    render(<EgressCredentials />);
    const inactiveServices = await section();
    expect(
      inactiveServices.getByLabelText("Inactive service taken"),
    ).toBeInTheDocument();
    expect(inactiveServices.queryByRole("button")).toBeNull();
  });

  it("keeps Delete off while a service is being saved", async () => {
    let finish: (response: Response) => void = () => {};
    save = () =>
      new Promise<Response>((done) => {
        finish = done;
      });
    render(<EgressCredentials />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit service for My API" }),
    );
    await screen.findByRole("form", { name: "Edit mine" });
    await presetsReady();
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Delete inactive service taken" }),
      ).toBeDisabled(),
    );
    finish(new Response(null, { status: 204 }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Delete inactive service taken" }),
      ).toBeEnabled(),
    );
  });

  it("reads a reason it does not know in general terms", async () => {
    listing[0].inactive_services = [
      { name: "future", reason: "retired" as "invalid" },
    ];
    render(<EgressCredentials />);
    const row = (await section()).getByLabelText("Inactive service future");
    expect(row).toHaveTextContent("Not in use: the broker ignores this entry.");
    fireEvent.click(
      within(row).getByRole("button", {
        name: "Delete inactive service future",
      }),
    );
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "This removes the entry.",
    );
  });
});

describe("recent requests on the personal page", () => {
  const record = (changes: Partial<EgressLogRecord> = {}): EgressLogRecord => ({
    at: "2026-10-09T10:30:00+00:00",
    kind: "request",
    agent_name: "personal",
    method: "POST",
    host: "api.github.com",
    path: "/repos/acme/app/issues",
    service: "github",
    status: 201,
    code: null,
    ...changes,
  });
  let logs: () => Response;

  beforeEach(() => {
    logs = () =>
      json({
        records: [
          record(),
          record({
            at: "2026-10-09T10:00:00+00:00",
            method: "GET",
            host: "example.com",
            path: "/",
            service: null,
            status: 403,
            kind: "denied",
            code: "path_not_allowed",
          }),
          record({ method: "CONNECT", path: "", status: 200, kind: "tunnel" }),
        ],
      });
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/api/connections/egress") return json({ agents });
      if (path.startsWith("/api/connections/egress/logs")) return logs();
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  const logRequests = () =>
    vi
      .mocked(fetch)
      .mock.calls.map(([input]) => String(input))
      .filter((path) => path.startsWith("/api/connections/egress/logs"));
  const toggle = async (agentName = "Personal Mind") =>
    within(await screen.findByRole("region", { name: agentName })).getByRole(
      "button",
      {
        name: "Recent requests",
      },
    );

  it("starts collapsed and does not load anything until it is opened", async () => {
    render(<EgressCredentials />);
    expect(await toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("table")).toBeNull();
    expect(logRequests()).toEqual([]);
  });

  it("loads the caller's 50 latest requests for that agent", async () => {
    render(<EgressCredentials />);
    fireEvent.click(await toggle());
    const table = await screen.findByRole("table", {
      name: "Recent requests for personal",
    });
    expect(logRequests()).toEqual([
      "/api/connections/egress/logs?agent_name=personal&limit=50",
    ]);
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Time", "Method", "Host", "Path", "Service", "Status"]);
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4);
    const first = within(rows[1]).getAllByRole("cell");
    expect(first[0]).toHaveTextContent(
      new Date("2026-10-09T10:30:00+00:00").toLocaleString(),
    );
    expect(first.slice(1).map((cell) => cell.textContent)).toEqual([
      "POST",
      "api.github.com",
      "/repos/acme/app/issues",
      "github",
      "201",
    ]);
  });

  it("shows a refusal code, and dashes for a missing service or path", async () => {
    render(<EgressCredentials />);
    fireEvent.click(await toggle());
    const rows = within(await screen.findByRole("table")).getAllByRole("row");
    const refused = within(rows[2]).getAllByRole("cell");
    expect(refused[4]).toHaveTextContent("-");
    expect(refused[5]).toHaveTextContent("403");
    expect(refused[5]).toHaveTextContent("path_not_allowed");
    const tunnel = within(rows[3]).getAllByRole("cell");
    expect(tunnel[3]).toHaveTextContent("-");
    expect(tunnel[5]).not.toHaveTextContent("refused");
  });

  it("calls a denied request refused when the API sends no code", async () => {
    logs = () => json({ records: [record({ kind: "denied", status: 403 })] });
    render(<EgressCredentials />);
    fireEvent.click(await toggle());
    expect(
      await screen.findByText("refused", { selector: "div" }),
    ).toBeInTheDocument();
  });

  it("collapses and opens again, loading fresh rows each time", async () => {
    render(<EgressCredentials />);
    const button = await toggle();
    fireEvent.click(button);
    await screen.findByRole("table");
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(button);
    expect(screen.queryByRole("table")).toBeNull();
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    await screen.findByRole("table");
    expect(logRequests()).toHaveLength(2);
  });

  it("refreshes on request", async () => {
    render(<EgressCredentials />);
    fireEvent.click(await toggle());
    await screen.findByRole("table");
    logs = () => json({ records: [] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await screen.findByText("No requests logged yet."),
    ).toBeInTheDocument();
    expect(logRequests()).toHaveLength(2);
  });

  it("keeps each agent's log separate", async () => {
    render(<EgressCredentials />);
    fireEvent.click(await toggle("Shared Dev"));
    await screen.findByRole("table");
    expect(logRequests()).toEqual([
      "/api/connections/egress/logs?agent_name=shared_dev&limit=50",
    ]);
    expect(
      within(screen.getByRole("region", { name: "Personal Mind" })).queryByRole(
        "table",
      ),
    ).toBeNull();
  });

  it("shows why the log is unavailable", async () => {
    logs = () => json({ detail: "Egress broker is not running" }, 409);
    render(<EgressCredentials />);
    fireEvent.click(await toggle());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Egress broker is not running",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("falls back to a general message for other failures", async () => {
    logs = () => json({ detail: "Egress logs are unavailable" }, 503);
    render(<EgressCredentials />);
    fireEvent.click(await toggle());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not complete the request. Try again.",
    );
  });
});

describe("the page's header and intro", () => {
  const identityFor = (changes: Partial<typeof identity> = {}) => ({
    ...identity,
    ...changes,
  });

  it("says who is signed in and links Agents and API keys and accounts", async () => {
    render(<EgressCredentials />);
    expect(
      await screen.findByText("Signed in as @bob:example.org"),
    ).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Connections pages" });
    expect(within(nav).getByRole("link", { name: "Agents" })).toHaveAttribute(
      "href",
      "/connections",
    );
    expect(
      within(nav).getByRole("link", { name: "API keys and accounts" }),
    ).toHaveAttribute("aria-current", "page");
    expect(within(nav).queryByRole("link", { name: "Dashboard" })).toBeNull();
  });

  it("links the dashboard for administrators", async () => {
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input) === "/api/connections/me"
        ? json(
            identityFor({
              matrix_user_id: "@alice:example.org",
              is_administrator: true,
            }),
          )
        : json({ agents }),
    );
    render(<EgressCredentials />);
    expect(
      await screen.findByRole("link", { name: "Dashboard" }),
    ).toHaveAttribute("href", "/");
  });

  it("explains what the page does in the words of the spec", async () => {
    render(<EgressCredentials />);
    expect(
      await screen.findByText(
        "Connect an account or paste an API key for the services below, or add a service of your own. MindRoom stores them and adds them to your agents' requests to the matching websites. Your agents never get the keys themselves, but a website can send a key back in its response (an echo service does), so only add keys for sites you trust. Saved keys cannot be read back.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/never see them/)).toBeNull();
  });
});

describe("rows grouped by who added them", () => {
  const config = (name: string, display: string): EgressCredentialService => ({
    ...service,
    name,
    display_name: display,
    source: "config",
  });
  const own = (name: string, display: string): EgressCredentialService => ({
    ...service,
    name,
    display_name: display,
    source: "user",
  });
  const agentOf = (
    changes: Partial<EgressCredentialAgent>,
  ): EgressCredentialAgent => ({ ...agents[0], ...changes });
  const show = (listing: EgressCredentialAgent[]) => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input) === "/api/connections/me") return json(identity);
      return json({ agents: listing });
    });
    render(<EgressCredentials />);
  };
  const groupsOf = (region: HTMLElement) =>
    within(region)
      .getAllByRole("group")
      .map((group) => [
        group.getAttribute("aria-label"),
        within(group)
          .getAllByRole("listitem")
          .map((item) => item.getAttribute("aria-label")),
      ]);

  it("lists the administrator's services apart from the ones you added", async () => {
    show([
      agentOf({
        services: [
          own("mine", "My API"),
          config("github", "GitHub"),
          config("openai", "OpenAI"),
        ],
      }),
    ]);
    const region = await screen.findByRole("region", { name: "Personal Mind" });
    expect(groupsOf(region)).toEqual([
      ["From your administrator", ["GitHub", "OpenAI"]],
      ["Added by you", ["My API"]],
    ]);
    expect(
      within(region).getByRole("heading", { name: "From your administrator" }),
    ).toBeVisible();
    expect(
      within(region).getByRole("heading", { name: "Added by you" }),
    ).toBeVisible();
    expect(
      within(region).queryByText("Added by your administrator"),
    ).toBeNull();
  });

  it("names the credential managers as the source on a shared agent", async () => {
    show([
      agentOf({
        agent_name: "shared_dev",
        agent_display_name: "Shared Dev",
        shared: true,
        scope: "shared",
        managers: ["@bob:example.org"],
        services: [own("team", "Team API"), config("github", "GitHub")],
      }),
    ]);
    const region = await screen.findByRole("region", { name: "Shared Dev" });
    expect(groupsOf(region).map(([name]) => name)).toEqual([
      "From your administrator",
      "Added by its credential managers",
    ]);
  });

  it("shows only the groups that have rows", async () => {
    show([agentOf({ services: [config("github", "GitHub")] })]);
    const region = await screen.findByRole("region", { name: "Personal Mind" });
    expect(groupsOf(region).map(([name]) => name)).toEqual([
      "From your administrator",
    ]);
  });

  it("keeps the agents in the order the API sends them", async () => {
    const listing = [
      agentOf({ agent_name: "z", agent_display_name: "Zed", services: [] }),
      agentOf({ agent_name: "a", agent_display_name: "Alpha", services: [] }),
      agentOf({ agent_name: "m", agent_display_name: "Mid", services: [] }),
    ];
    show(listing);
    const names = () =>
      screen
        .getAllByRole("region")
        .map((region) => region.getAttribute("aria-labelledby"));
    await screen.findByRole("region", { name: "Zed" });
    expect(names()).toEqual([
      "egress-agent-z",
      "egress-agent-a",
      "egress-agent-m",
    ]);
  });
});

describe("who can change a shared agent's keys", () => {
  const shared = (
    changes: Partial<EgressCredentialAgent>,
  ): EgressCredentialAgent => ({
    ...agents[1],
    managers: ["@bob:example.org", "@carol:example.org"],
    ...changes,
  });
  const show = (listing: EgressCredentialAgent[]) => {
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input) === "/api/connections/me"
        ? json(identity)
        : json({ agents: listing }),
    );
    render(<EgressCredentials />);
  };

  it("tells a non-manager which managers can", async () => {
    show([shared({})]);
    const region = await screen.findByRole("region", { name: "Shared Dev" });
    expect(
      within(region).getByText(
        "Only @bob:example.org and @carol:example.org can change keys for this shared agent.",
      ),
    ).toBeVisible();
    expect(
      within(region).queryByText(/Managed by credential managers/),
    ).toBeNull();
  });

  it("falls back to administrators when no manager is named", async () => {
    show([shared({ managers: [] })]);
    expect(
      await screen.findByText(
        "Only administrators can change keys for this shared agent.",
      ),
    ).toBeVisible();
  });

  it("tells a manager they manage the keys, and that everyone shares them", async () => {
    show([
      shared({
        can_manage: true,
        services: [{ ...agents[1].services[0], can_manage: true }],
      }),
    ]);
    expect(
      await screen.findByText(
        "You manage this shared agent's keys. Everyone who uses it shares them.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Only .* can change keys/)).toBeNull();
  });

  it("says nothing of the sort on an agent that is only yours", async () => {
    show([agents[0]]);
    await screen.findByRole("region", { name: "Personal Mind" });
    expect(screen.queryByText(/shared agent's keys/)).toBeNull();
    expect(screen.queryByText(/can change keys/)).toBeNull();
  });

  it("tells a viewer why their personal account is refused, by role", async () => {
    const refused = {
      ...service,
      is_shared: true,
      can_manage: false,
      oauth: {
        ...account,
        can_connect: false,
        unavailable_reason: "shared_sandbox" as const,
      },
    };
    show([shared({ services: [refused] })]);
    expect(
      await screen.findByText(
        "Personal GitHub accounts can't be used by shared agents. Ask @bob:example.org and @carol:example.org to add a team API key.",
      ),
    ).toBeVisible();
    cleanup();
    show([
      shared({
        can_manage: true,
        services: [{ ...refused, can_manage: true }],
      }),
    ]);
    expect(
      await screen.findByText(
        "Personal GitHub accounts can't be used by shared agents. Add a team API key instead.",
      ),
    ).toBeVisible();
  });

  it("asks before connecting a shared account and uses the agent's name", async () => {
    vi.spyOn(window, "open").mockReturnValue({
      closed: false,
      close: vi.fn(),
      location: { href: "about:blank" },
    } as unknown as Window);
    const google = {
      ...service,
      name: "gmail",
      display_name: "Gmail",
      is_shared: true,
      can_manage: true,
      oauth: { ...account, provider: "google", display_name: "Google" },
    };
    show([shared({ can_manage: true, services: [google] })]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Google for Gmail" }),
    );
    expect(
      within(
        await screen.findByRole("dialog", {
          name: "Connect a shared account?",
        }),
      ).getByText(
        "Everyone who uses Shared Dev will act as the Google account you pick. Use a team account, not your personal one.",
      ),
    ).toBeVisible();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => String(input).endsWith("/connect")),
    ).toHaveLength(0);
  });
});

describe("limiting a GitHub service to repositories", () => {
  let listing: EgressCredentialAgent[];
  const githubRules = [
    { host: "api.github.com", port: null, path_prefix: "/" },
    { host: "github.com", port: null, path_prefix: "/" },
  ];
  const limited = (
    name: string,
    repositories: string,
  ): EgressCredentialService => ({
    ...service,
    name,
    display_name: `GitHub (${repositories})`,
    description: "",
    source: "user",
    rules: githubRepositoryRules(repositories, {
      uploads: false,
      graphql: false,
    }).rules.map((rule) => ({
      host: rule.host,
      port: null,
      path_prefix: rule.path_prefix ?? "/",
    })),
  });

  beforeEach(() => {
    listing = [
      {
        ...agents[0],
        services: [{ ...service, source: "config", rules: githubRules }],
      },
    ];
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/api/connections/me") return json(identity);
      if (path === "/api/connections/egress") return json({ agents: listing });
      if (path === "/api/connections/egress/presets")
        return json(egressPresets);
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  it("opens the editor to add a GitHub service named github-limited", async () => {
    render(<EgressCredentials />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Limit to repositories for GitHub",
      }),
    );
    await presetsReady();
    expect(screen.getByLabelText("Name")).toHaveValue("github-limited");
    expect(screen.getByLabelText("Preset")).toHaveValue("github");
    expect(screen.getByRole("button", { name: "Save service" })).toBeVisible();
    // The editor is open, so a second one is not started.
    expect(
      screen.getByRole("button", { name: "Limit to repositories for GitHub" }),
    ).toBeDisabled();
  });

  it("takes the next free name when github-limited is already there", async () => {
    listing[0].services.push(limited("github-limited", "a/b"));
    render(<EgressCredentials />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Limit to repositories for GitHub",
      }),
    );
    await presetsReady();
    expect(screen.getByLabelText("Name")).toHaveValue("github-limited-2");
  });

  it("offers it only to someone who can manage the agent", async () => {
    listing[0] = {
      ...listing[0],
      can_manage: false,
      services: [
        { ...service, source: "config", rules: githubRules, can_manage: false },
      ],
    };
    render(<EgressCredentials />);
    await screen.findByRole("region", { name: "Personal Mind" });
    expect(screen.queryByText("Limit to repositories")).toBeNull();
  });

  it("shows what a limited service is limited to", async () => {
    listing[0].services.push(limited("gh-a", "basnijholt/agent-cli"));
    render(<EgressCredentials />);
    const row = await screen.findByLabelText("GitHub (basnijholt/agent-cli)");
    expect(
      within(row).getByText("Limited to basnijholt/agent-cli"),
    ).toBeVisible();
  });
});

describe("recent requests: wording and wrapping", () => {
  beforeEach(() => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/api/connections/me") return json(identity);
      if (path === "/api/connections/egress") return json({ agents });
      return json({
        records: [
          {
            at: "2026-10-09T10:30:00+00:00",
            kind: "tunnel",
            agent_name: "personal",
            method: "CONNECT",
            host: "example.com",
            path: "",
            service: null,
            status: 200,
            code: null,
          },
          {
            at: "2026-10-09T10:00:00+00:00",
            kind: "denied",
            agent_name: "personal",
            method: "GET",
            host: "api.github.com",
            path: "/repos/a/b",
            service: "github",
            status: 403,
            code: "credential_not_configured",
          },
          {
            at: "2026-10-09T09:00:00+00:00",
            kind: "denied",
            agent_name: "personal",
            method: "CONNECT",
            host: "blocked.example",
            path: "",
            service: null,
            status: 403,
            code: "host_not_allowed",
          },
        ],
      });
    });
  });

  const openLog = async () => {
    fireEvent.click(
      within(
        await screen.findByRole("region", { name: "Personal Mind" }),
      ).getByRole("button", { name: "Recent requests" }),
    );
    return screen.findByRole("table", { name: "Recent requests for personal" });
  };

  it("says a relayed CONNECT passed through with no key added", async () => {
    render(<EgressCredentials />);
    const rows = within(await openLog()).getAllByRole("row");
    expect(within(rows[1]).getAllByRole("cell")[4]).toHaveTextContent(
      "Passed through (no key added)",
    );
    // A refused CONNECT was not passed through, and a request with a service names it.
    expect(within(rows[2]).getAllByRole("cell")[4]).toHaveTextContent("github");
    expect(within(rows[3]).getAllByRole("cell")[4]).not.toHaveTextContent(
      "Passed through",
    );
  });

  it("explains in a caption that other sites pass straight through and that administrators can see the requests", async () => {
    render(<EgressCredentials />);
    const table = await openLog();
    expect(table.querySelector("caption")).toHaveTextContent(
      "Requests to sites without a service pass straight through; MindRoom sees only the host. Administrators can also see these requests (method, host, and path).",
    );
  });

  it("lets a refusal code wrap after each underscore and never mid-word", async () => {
    render(<EgressCredentials />);
    const table = await openLog();
    const code = within(table)
      .getByText("credential_not_configured")
      .closest("div")!;
    expect(code.className).not.toContain("break-all");
    expect(code.textContent).toBe("credential_not_configured");
    expect(code.querySelectorAll("wbr")).toHaveLength(2);
    // The break opportunities sit right after the underscores.
    expect(code.innerHTML).toBe("credential_<wbr>not_<wbr>configured");
  });
});
