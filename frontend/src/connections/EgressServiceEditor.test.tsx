import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import egressPresets from "@/test/fixtures/egressPresets.json";
import {
  DiscardEditsNotice,
  EgressServiceEditor,
  type EgressServiceEditorProps,
} from "./EgressServiceEditor";
import type { EgressPreset, EgressRule } from "./types";

// The JSON fixture types each placeholder_env by its own keys.
const presets = egressPresets.presets as EgressPreset[];

const bearerRule: EgressRule = {
  host: "api.example.com",
  auth: { type: "bearer" },
};

const baseProps = () => ({
  service: null,
  context: "personal" as const,
  loadPresets: vi.fn(async () => presets),
  onSave: vi.fn(async () => undefined),
  onCancel: vi.fn(),
});

/** Render the editor and wait until the server's presets are in the dropdown. */
async function renderEditor(props: Partial<EgressServiceEditorProps> = {}) {
  const merged = { ...baseProps(), ...props };
  render(<EgressServiceEditor {...merged} />);
  await waitFor(() => expect(screen.getByLabelText("Preset")).toBeEnabled());
  return { onSave: merged.onSave, onCancel: merged.onCancel };
}

/** Open the section that holds everything but the basic fields. */
const openMoreOptions = () =>
  fireEvent.click(screen.getByRole("button", { name: "More options" }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the editor form", () => {
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const save = () =>
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));

  it("saves a custom service in its authored form", async () => {
    const { onSave } = await renderEditor();
    type("Name", "example");
    type("Website", "API.example.com");
    fireEvent.change(screen.getByLabelText("Send the key as"), {
      target: { value: "header" },
    });
    type("Header name", "X-Api-Key");
    openMoreOptions();
    type("Display name", "Example");
    type("Path prefix", "/v1/");
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith("example", {
      display_name: "Example",
      rules: [
        {
          host: "api.example.com",
          path_prefix: "/v1/",
          auth: { type: "header", name: "X-Api-Key" },
        },
      ],
    });
  });

  it.each<[string, string, Record<string, string>, object]>([
    [
      "template",
      "Custom template",
      { "Header name": "Authorization", "Value template": "Token {secret}" },
      {
        type: "header",
        name: "Authorization",
        template: "Token {secret}",
      },
    ],
    [
      "query",
      "Query parameter",
      { "Parameter name": "api_key" },
      { type: "query", name: "api_key" },
    ],
    ["basic", "Basic", { Username: "bot" }, { type: "basic", username: "bot" }],
  ])(
    "sends the key as %s with its own fields",
    async (choice, _label, fields, auth) => {
      const { onSave } = await renderEditor();
      type("Name", "example");
      type("Website", "api.example.com");
      fireEvent.change(screen.getByLabelText("Send the key as"), {
        target: { value: choice },
      });
      for (const [label, value] of Object.entries(fields)) type(label, value);
      save();
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(onSave).toHaveBeenCalledWith("example", {
        rules: [{ host: "api.example.com", auth }],
      });
    },
  );

  it("offers the five ways to send the key", async () => {
    await renderEditor();
    expect(
      within(screen.getByLabelText("Send the key as"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Bearer token",
      "Header",
      "Basic",
      "Query parameter",
      "Custom template",
    ]);
  });

  it("says that an empty value template sends the key as is", async () => {
    await renderEditor();
    fireEvent.change(screen.getByLabelText("Send the key as"), {
      target: { value: "template" },
    });
    expect(screen.getByLabelText("Value template")).toHaveAccessibleDescription(
      "Leave empty to send the key as is.",
    );
    // A query parameter has the same optional template.
    fireEvent.change(screen.getByLabelText("Send the key as"), {
      target: { value: "query" },
    });
    expect(screen.getByLabelText("Value template")).toHaveAccessibleDescription(
      "Leave empty to send the key as is.",
    );
  });

  it("says that placeholders are only set while the service has a key or account", async () => {
    await renderEditor();
    openMoreOptions();
    expect(
      screen.getByText(
        /Placeholders are set only while this service has a key or a connected account\./,
      ),
    ).toBeVisible();
  });

  it("drops a custom template when the user chooses plain Header", async () => {
    const { onSave } = await renderEditor({
      name: "svc",
      service: {
        rules: [
          {
            host: "api.example.com",
            auth: { type: "header", name: "X-Key", template: "Key {secret}" },
          },
        ],
      },
    });
    expect(screen.getByLabelText("Send the key as")).toHaveValue("template");
    fireEvent.change(screen.getByLabelText("Send the key as"), {
      target: { value: "header" },
    });
    expect(screen.queryByLabelText("Value template")).toBeNull();
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(vi.mocked(onSave).mock.calls[0][1].rules?.[0].auth).toEqual({
      type: "header",
      name: "X-Key",
    });
  });

  it("adds, fills, and removes extra rules", async () => {
    const { onSave } = await renderEditor();
    type("Name", "two");
    type("Website", "a.example.com");
    openMoreOptions();
    // The first rule is the basic fields, so it has no Remove button.
    expect(screen.queryByRole("button", { name: "Remove Rule 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    type("Rule 2 host", "b.example.com");
    fireEvent.change(screen.getByLabelText("Rule 2 auth type"), {
      target: { value: "basic" },
    });
    type("Rule 2 username", "bot");
    type("Rule 3 host", "c.example.com");
    type("Rule 3 path prefix", "/v1");
    type("Rule 3 port", "8443");
    fireEvent.click(screen.getByRole("button", { name: "Remove Rule 3" }));
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("two", {
      rules: [
        { host: "a.example.com", auth: { type: "bearer" } },
        { host: "b.example.com", auth: { type: "basic", username: "bot" } },
      ],
    });
  });

  it("saves a preset alone as just the preset", async () => {
    const { onSave } = await renderEditor();
    type("Name", "github");
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "github" },
    });
    expect(
      screen.getByText(
        "The GitHub preset covers api.github.com, uploads.github.com, github.com.",
      ),
    ).toBeInTheDocument();
    // The preset supplies the rules, so no rule fields are shown.
    expect(screen.queryByLabelText("Website")).toBeNull();
    expect(screen.queryByLabelText("Send the key as")).toBeNull();
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("github", { preset: "github" });
  });

  it("saves a preset with restrict_to_rules without expanding it", async () => {
    const { onSave } = await renderEditor();
    type("Name", "github");
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "github" },
    });
    openMoreOptions();
    fireEvent.click(screen.getByLabelText("Refuse other paths on these hosts"));
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("github", {
      preset: "github",
      restrict_to_rules: true,
    });
  });

  it("lets the user replace a preset's rules with their own", async () => {
    const { onSave } = await renderEditor();
    type("Name", "ai");
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "openai" },
    });
    openMoreOptions();
    fireEvent.click(
      screen.getByLabelText("Replace the preset's rules with my own"),
    );
    type("Website", "proxy.example.com");
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("ai", {
      preset: "openai",
      rules: [{ host: "proxy.example.com", auth: { type: "bearer" } }],
    });
  });

  it("rejects a name that is already taken, beside the name", async () => {
    const { onSave } = await renderEditor({ takenNames: ["github"] });
    type("Name", "github");
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "github" },
    });
    save();
    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription(
      /A service named github already exists/,
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows the service's own error and stays open", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("service name 'x' is already used by your administrator");
    });
    await renderEditor({ onSave });
    type("Name", "x");
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "openai" },
    });
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already used by your administrator",
    );
    expect(screen.getByRole("button", { name: "Save service" })).toBeEnabled();
  });

  it("cannot rename the service it edits", async () => {
    await renderEditor({ name: "github", service: { preset: "github" } });
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByLabelText("Name")).toHaveValue("github");
    expect(screen.getByLabelText("Preset")).toHaveValue("github");
    expect(
      screen.getByRole("form", { name: "Edit github" }),
    ).toBeInTheDocument();
  });

  it("keeps a preset this page does not know", async () => {
    await renderEditor({ name: "future", service: { preset: "future_api" } });
    expect(screen.getByLabelText("Preset")).toHaveValue("future_api");
  });

  it("shows the placeholder rules as hints under More options", async () => {
    await renderEditor();
    expect(screen.queryByText(/must be TOKEN, KEY/)).toBeNull();
    openMoreOptions();
    expect(
      screen.getByText(
        /one word between underscores must be TOKEN, KEY, SECRET, PASSWORD, PAT, AUTH, or CREDENTIAL/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Use a fixed value such as mindroom-brokered/),
    ).toBeInTheDocument();
  });

  it("lists the words and prefixes a personal placeholder name cannot use", async () => {
    await renderEditor();
    openMoreOptions();
    const hint = screen.getByText(/one word between underscores must be/);
    expect(hint).toHaveTextContent(
      "No word may be COMMAND, CMD, FILE, DIR, PROVIDER, HELPER, OPTS, OPTIONS, or EXTENSIONS",
    );
    expect(hint).toHaveTextContent(
      "names cannot start with SSH_, MINDROOM_, or GIT_CONFIG_",
    );
    expect(hint).toHaveTextContent(
      "PATH, HOME, and proxy and CA variables are reserved",
    );
  });

  it("refuses a placeholder the server would, and says why", async () => {
    const { onSave } = await renderEditor();
    type("Name", "svc");
    type("Website", "a.example.com");
    openMoreOptions();
    fireEvent.click(screen.getByRole("button", { name: "Add placeholder" }));
    type("Placeholder 1 name", "SSH_AUTH_SOCK");
    save();
    expect(
      screen.getByLabelText("Placeholder 1 name"),
    ).toHaveAccessibleDescription(
      "SSH_AUTH_SOCK is not allowed: tools read names with COMMAND, CMD, FILE, DIR, PROVIDER, HELPER, OPTS, OPTIONS, or EXTENSIONS, or starting with SSH_, as programs or paths.",
    );
    type("Placeholder 1 name", "my_key");
    expect(
      screen.getByLabelText("Placeholder 1 name"),
    ).toHaveAccessibleDescription(
      "my_key is not allowed as a placeholder: name a credential, such as MY_API_KEY, with TOKEN, KEY, SECRET, PASSWORD, PAT, AUTH, or CREDENTIAL as one of its words.",
    );
    type("Placeholder 1 name", "MINDROOM_API_KEY");
    expect(
      screen.getByLabelText("Placeholder 1 name"),
    ).toHaveAccessibleDescription(
      "Placeholder name MINDROOM_API_KEY starts with reserved prefix MINDROOM_",
    );
    type("Placeholder 1 name", "MY_API_KEY");
    type("Placeholder 1 value", "has space");
    expect(
      screen.getByLabelText("Placeholder 1 value"),
    ).toHaveAccessibleDescription(
      "The value of MY_API_KEY must be 1 to 256 letters, digits, or . _ : -",
    );
    expect(screen.getByLabelText("Placeholder 1 name")).not.toHaveAttribute(
      "aria-invalid",
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows the operator's placeholder rules instead on the dashboard", async () => {
    await renderEditor({ context: "operator" });
    openMoreOptions();
    expect(
      screen.getByText(/MINDROOM_ or GIT_CONFIG_ are reserved/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/must be TOKEN, KEY/)).toBeNull();
  });

  it("adds a placeholder with the brokered value and saves it", async () => {
    const { onSave } = await renderEditor();
    type("Name", "svc");
    type("Website", "a.example.com");
    openMoreOptions();
    fireEvent.click(screen.getByRole("button", { name: "Add placeholder" }));
    expect(screen.getByLabelText("Placeholder 1 value")).toHaveValue(
      "mindroom-brokered",
    );
    type("Placeholder 1 name", "SVC_API_KEY");
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("svc", {
      rules: [{ host: "a.example.com", auth: { type: "bearer" } }],
      placeholder_env: { SVC_API_KEY: "mindroom-brokered" },
    });
  });

  it("opens More options when the service already uses one", async () => {
    await renderEditor({
      name: "svc",
      service: { preset: "github", placeholder_env: { GH_TOKEN: "x" } },
    });
    expect(screen.getByLabelText("Placeholder 1 name")).toHaveValue("GH_TOKEN");
    expect(
      screen.getByRole("button", { name: "More options" }),
    ).toHaveAttribute("aria-expanded", "true");
    cleanup();
    await renderEditor({
      name: "svc",
      service: { preset: "github", restrict_to_rules: true },
    });
    expect(
      screen.getByLabelText("Refuse other paths on these hosts"),
    ).toBeChecked();
    cleanup();
    await renderEditor({ name: "svc", service: { preset: "github" } });
    expect(
      screen.getByRole("button", { name: "More options" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("disables the account login on a shared agent", async () => {
    const { onSave } = await renderEditor({ sharedTarget: true });
    openMoreOptions();
    expect(screen.getByLabelText("Account login (optional)")).toBeDisabled();
    expect(
      screen.getByText(
        "Accounts cannot be connected on a shared agent. Use an API key.",
      ),
    ).toBeInTheDocument();
    type("Name", "github");
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "github" },
    });
    expect(
      screen.getByText(
        /Accounts cannot be connected on a shared agent, so this service uses an API key/,
      ),
    ).toBeInTheDocument();
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("github", {
      preset: "github",
      oauth_provider: null,
    });
  });

  it("offers the account login on a personal agent", async () => {
    const { onSave } = await renderEditor();
    type("Name", "svc");
    type("Website", "a.example.com");
    openMoreOptions();
    type("Account login (optional)", "atlassian");
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("svc", {
      rules: [{ host: "a.example.com", auth: { type: "bearer" } }],
      oauth_provider: "atlassian",
    });
  });

  it("keeps oauth_on_shared_workers when an operator edits a service", async () => {
    const { onSave } = await renderEditor({
      context: "operator",
      name: "github",
      service: { preset: "github", oauth_on_shared_workers: true },
    });
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("github", {
      preset: "github",
      oauth_on_shared_workers: true,
    });
  });

  it("confirms before deleting and shows a failure", async () => {
    const onDelete = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Could not delete it"))
      .mockResolvedValue(undefined);
    await renderEditor({
      name: "github",
      service: { preset: "github" },
      onDelete,
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete service" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(
      screen.getByRole("button", { name: "Delete service" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete service" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not delete it",
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete service" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(2));
  });

  it("has no delete button for a new service", async () => {
    await renderEditor({ onDelete: vi.fn() });
    expect(screen.queryByRole("button", { name: "Delete service" })).toBeNull();
  });

  it("cancels without saving", async () => {
    const { onSave, onCancel } = await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("the GitHub helper in the editor", () => {
  const renderGithub = (props: Partial<EgressServiceEditorProps> = {}) =>
    renderEditor({ service: { preset: "github" }, name: "github", ...props });
  const enter = (value: string) =>
    fireEvent.change(screen.getByLabelText("GitHub repositories"), {
      target: { value },
    });
  const apply = () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Use these repositories" }),
    );
  const save = () =>
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));

  it("replaces the preset's rules and turns on the restriction", async () => {
    const { onSave } = await renderGithub();
    enter("basnijholt/agent-cli");
    apply();
    // The generated rules show: the first in the basic fields, the rest under More options.
    expect(screen.getByLabelText("Website")).toHaveValue("api.github.com");
    // The extra rules have a path prefix too: the first one in page order is rule 1's.
    expect(screen.getAllByLabelText("Path prefix")[0]).toHaveValue(
      "/repos/basnijholt/agent-cli",
    );
    expect(screen.getByLabelText("Rule 3 path prefix")).toHaveValue(
      "/basnijholt/agent-cli.git",
    );
    expect(screen.getByLabelText("Rule 2 auth type")).toHaveValue("basic");
    expect(screen.getByLabelText("Rule 2 username")).toHaveValue(
      "x-access-token",
    );
    expect(
      screen.getByLabelText("Refuse other paths on these hosts"),
    ).toBeChecked();
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("github", {
      preset: "github",
      display_name: "GitHub (basnijholt/agent-cli)",
      description: "Limited to basnijholt/agent-cli",
      restrict_to_rules: true,
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

  it("says what applying does to the rules, in the words of the spec", async () => {
    await renderGithub();
    expect(
      screen.getByText(
        "One repository per line, as owner/repo, or owner/* for everything an owner has. Applying replaces the rules above with rules for just those repositories (API and git over HTTPS) and refuses every other path on api.github.com and github.com. Other API paths, such as /user or search, stop working. Matching is case sensitive, so write names as they appear in GitHub URLs.",
      ),
    ).toBeVisible();
  });

  it("makes owner-wide rules and leaves uploads and GraphQL off by default", async () => {
    await renderGithub();
    expect(
      screen.getByLabelText(/Also allow uploads.github.com/),
    ).not.toBeChecked();
    expect(screen.getByLabelText(/Also allow GraphQL/)).not.toBeChecked();
    enter("mindroom-ai/*");
    apply();
    expect(screen.getAllByLabelText("Path prefix")[0]).toHaveValue(
      "/repos/mindroom-ai/",
    );
    expect(screen.getByLabelText("Rule 2 path prefix")).toHaveValue(
      "/mindroom-ai/",
    );
    expect(screen.queryByLabelText("Rule 3 host")).toBeNull();
  });

  it("adds uploads and GraphQL rules when ticked", async () => {
    await renderGithub();
    fireEvent.click(screen.getByLabelText(/Also allow uploads.github.com/));
    fireEvent.click(screen.getByLabelText(/Also allow GraphQL/));
    enter("o/r");
    apply();
    expect(screen.getByLabelText("Rule 4 host")).toHaveValue(
      "uploads.github.com",
    );
    expect(screen.getByLabelText("Rule 4 path prefix")).toHaveValue(
      "/repos/o/r",
    );
    expect(screen.getByLabelText("Rule 5 path prefix")).toHaveValue("/graphql");
  });

  it("names the lines it cannot use and changes nothing", async () => {
    await renderGithub();
    enter("not a repo");
    apply();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "not a repo is not owner/repo or owner/*",
    );
    expect(screen.queryByLabelText("Website")).toBeNull();
  });

  it("only appears for the GitHub preset or a GitHub host", async () => {
    const helper = () => screen.queryByText("Limit to repositories");
    // A new custom service has no host yet.
    await renderEditor({ name: undefined, service: null });
    expect(helper()).toBeNull();
    fireEvent.change(screen.getByLabelText("Website"), {
      target: { value: "httpbin.org" },
    });
    expect(helper()).toBeNull();
    for (const host of ["github.com", "api.github.com", "uploads.github.com"]) {
      fireEvent.change(screen.getByLabelText("Website"), {
        target: { value: host },
      });
      expect(helper()).toBeInTheDocument();
    }
    fireEvent.change(screen.getByLabelText("Website"), {
      target: { value: "" },
    });
    expect(helper()).toBeNull();
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "github" },
    });
    expect(helper()).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "openai" },
    });
    expect(helper()).toBeNull();
    cleanup();
    await renderEditor({ name: "code", service: { rules: [bearerRule] } });
    expect(helper()).toBeNull();
  });

  it("sits with the basic fields, not under More options", async () => {
    await renderGithub();
    expect(screen.getByText("Limit to repositories")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "More options" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("fills the display name and the description when they are empty", async () => {
    const { onSave } = await renderGithub({ name: undefined, service: null });
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "github" },
    });
    enter("o/a");
    apply();
    expect(screen.getByLabelText("Display name")).toHaveValue("GitHub (o/a)");
    expect(screen.getByLabelText("Description")).toHaveValue("Limited to o/a");
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(vi.mocked(onSave).mock.calls[0][1]).toMatchObject({
      display_name: "GitHub (o/a)",
      description: "Limited to o/a",
    });
  });

  it("lists every repository in the labels and keeps what the user already typed", async () => {
    await renderGithub();
    openMoreOptions();
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Work GitHub" },
    });
    enter("o/a\no/b\np/*");
    apply();
    expect(screen.getByLabelText("Display name")).toHaveValue("Work GitHub");
    expect(screen.getByLabelText("Description")).toHaveValue(
      "Limited to o/a, o/b, p/*",
    );
  });

  it("leaves the labels alone when the repositories are not valid", async () => {
    await renderGithub();
    enter("not a repo");
    apply();
    openMoreOptions();
    expect(screen.getByLabelText("Display name")).toHaveValue("");
    expect(screen.getByLabelText("Description")).toHaveValue("");
  });
});

describe("the help beside refusing other paths", () => {
  const REFUSAL =
    "Requests to these hosts whose path matches none of your rules are refused (path_not_allowed) instead of being sent without a key.";
  const BOUNDARY =
    "The real boundary is the key itself, so scope it as narrowly as the website allows.";
  const LIMIT_FOR = {
    user_agent: "this agent only",
    user: "all your agents that share your personal workspace",
    shared: "everyone using this agent",
    unscoped: "everyone using this agent",
  } as const;
  const limit = (scope: keyof typeof LIMIT_FOR) =>
    `This also limits services from your administrator on these hosts, for ${LIMIT_FOR[scope]}.`;
  const helpFor = (scope: keyof typeof LIMIT_FOR) =>
    `${REFUSAL} ${limit(scope)} ${BOUNDARY}`;
  const HELP = helpFor("user_agent");
  const GITHUB_HELP =
    "GraphQL (/graphql) is refused unless listed, and a listed GraphQL rule reaches every repository the key can reach. Use a fine-grained token or a GitHub App installed on selected repositories.";
  const restrictHelp = () =>
    screen
      .getByLabelText("Refuse other paths on these hosts")
      .closest("div") as HTMLElement;

  it("is generic for a service on any other host", async () => {
    await renderEditor({
      scope: "user_agent",
      name: "web",
      service: { rules: [{ host: "httpbin.org", auth: { type: "bearer" } }] },
    });
    openMoreOptions();
    expect(restrictHelp()).toHaveTextContent(HELP);
    expect(restrictHelp()).not.toHaveTextContent("GraphQL");
    expect(restrictHelp()).not.toHaveTextContent("fine-grained");
  });

  it("adds the GraphQL sentence on a GitHub host", async () => {
    await renderEditor({
      scope: "user_agent",
      name: "code",
      service: { preset: "github" },
    });
    openMoreOptions();
    expect(restrictHelp()).toHaveTextContent(`${HELP} ${GITHUB_HELP}`);
    cleanup();
    await renderEditor({
      scope: "user_agent",
      name: "code",
      service: {
        rules: [{ host: "api.github.com", auth: { type: "bearer" } }],
      },
    });
    openMoreOptions();
    expect(restrictHelp()).toHaveTextContent(GITHUB_HELP);
  });

  it("follows the host as it is typed", async () => {
    await renderEditor();
    openMoreOptions();
    expect(restrictHelp()).not.toHaveTextContent("GraphQL");
    fireEvent.change(screen.getByLabelText("Website"), {
      target: { value: "api.github.com" },
    });
    expect(restrictHelp()).toHaveTextContent("GraphQL");
  });

  it.each(Object.keys(LIMIT_FOR) as (keyof typeof LIMIT_FOR)[])(
    "says whom the limit on the administrator's services reaches on a %s scope",
    async (scope) => {
      await renderEditor({ scope });
      openMoreOptions();
      expect(restrictHelp()).toHaveTextContent(helpFor(scope));
      // The old note about a broader rule of another service is gone.
      expect(screen.queryByRole("note")).toBeNull();
      expect(screen.queryByText(/A broader rule of/)).toBeNull();
    },
  );

  it("names only the agent for a user_agent scope, never the whole workspace", async () => {
    await renderEditor({ scope: "user_agent" });
    openMoreOptions();
    expect(restrictHelp()).toHaveTextContent("for this agent only.");
    expect(restrictHelp()).not.toHaveTextContent("personal workspace");
    expect(restrictHelp()).not.toHaveTextContent("everyone");
  });

  it("makes no claim about whom the limit reaches when the scope is not known", async () => {
    await renderEditor();
    openMoreOptions();
    expect(restrictHelp()).toHaveTextContent(`${REFUSAL} ${BOUNDARY}`);
    expect(restrictHelp()).not.toHaveTextContent("from your administrator");
  });

  it("leaves that sentence out on the dashboard, where the administrator edits config.yaml", async () => {
    await renderEditor({ context: "operator" });
    openMoreOptions();
    expect(restrictHelp()).toHaveTextContent(
      "Requests to these hosts whose path matches none of your rules are refused (path_not_allowed) instead of being sent without a key. The real boundary is the key itself, so scope it as narrowly as the website allows.",
    );
    expect(restrictHelp()).not.toHaveTextContent("from your administrator");
  });
});

describe("loading the presets", () => {
  it("offers what the server returns, by display name", async () => {
    await renderEditor({
      loadPresets: vi.fn(async () => [
        {
          id: "internal",
          display_name: "Internal API",
          description: "",
          oauth_provider: null,
          rules: [
            {
              host: "api.internal.example.com",
              port: 8443,
              path_prefix: "/v1/",
            },
          ],
          placeholder_env: {},
        },
      ]),
    });
    expect(
      within(screen.getByLabelText("Preset"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Custom", "Internal API"]);
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "internal" },
    });
    expect(
      screen.getByText(
        "The Internal API preset covers api.internal.example.com:8443/v1/.",
      ),
    ).toBeInTheDocument();
  });

  it("waits for the presets before the form can be saved", async () => {
    let resolve: (presets: EgressPreset[]) => void = () => {};
    const loadPresets = vi.fn(
      () =>
        new Promise<EgressPreset[]>((done) => {
          resolve = done;
        }),
    );
    render(<EgressServiceEditor {...baseProps()} loadPresets={loadPresets} />);
    expect(screen.getByLabelText("Preset")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save service" })).toBeDisabled();
    resolve(presets);
    await waitFor(() => expect(screen.getByLabelText("Preset")).toBeEnabled());
    expect(screen.getByRole("button", { name: "Save service" })).toBeEnabled();
    expect(loadPresets).toHaveBeenCalledTimes(1);
  });

  it("falls back to a custom service when they cannot be loaded", async () => {
    const onSave = vi.fn(async () => undefined);
    await renderEditor({
      loadPresets: vi.fn(async () => {
        throw new Error("nope");
      }),
      onSave,
    });
    expect(
      screen.getByText(/The preset list could not be loaded/),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "own" },
    });
    fireEvent.change(screen.getByLabelText("Website"), {
      target: { value: "a.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("own", {
      rules: [{ host: "a.example.com", auth: { type: "bearer" } }],
    });
  });

  it("keeps a preset the server no longer lists", async () => {
    await renderEditor({
      name: "old",
      service: { preset: "retired" },
      loadPresets: vi.fn(async () => []),
    });
    expect(screen.getByLabelText("Preset")).toHaveValue("retired");
  });
});

describe("saving with a wider effect", () => {
  const saveWarning = "This also saves your other unsaved settings changes.";
  const filled = async (props: Partial<EgressServiceEditorProps> = {}) => {
    const rendered = await renderEditor({ saveWarning, ...props });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "svc" },
    });
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "openai" },
    });
    return rendered;
  };
  const save = () =>
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));

  it("asks once before saving, then saves", async () => {
    const { onSave } = await filled();
    save();
    expect(screen.getByRole("alert")).toHaveTextContent(saveWarning);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save all changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith("svc", { preset: "openai" });
  });

  it("goes back without saving", async () => {
    const { onSave } = await filled();
    save();
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.queryByText(saveWarning)).toBeNull();
    expect(screen.getByRole("button", { name: "Save service" })).toBeEnabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("asks again after the form changes", async () => {
    const { onSave } = await filled();
    save();
    openMoreOptions();
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "changed" },
    });
    expect(screen.queryByText(saveWarning)).toBeNull();
    save();
    expect(screen.getByText(saveWarning)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not ask for an invalid form", async () => {
    await renderEditor({ saveWarning });
    save();
    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription(
      /Name is required/,
    );
    expect(screen.queryByText(saveWarning)).toBeNull();
  });

  it("saves straight away without a warning", async () => {
    const { onSave } = await filled({ saveWarning: null });
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
  });

  it("repeats the warning when asking to delete", async () => {
    await renderEditor({
      name: "github",
      service: { preset: "github" },
      onDelete: vi.fn(),
      saveWarning,
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete service" }));
    expect(
      screen.getByText(`Delete github? ${saveWarning}`),
    ).toBeInTheDocument();
  });
});

describe("reporting unsaved changes", () => {
  it("tells the parent when the form differs from what it opened with", async () => {
    const onDirtyChange = vi.fn();
    await renderEditor({
      name: "github",
      service: { preset: "github" },
      onDirtyChange,
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    openMoreOptions();
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "x" },
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "" },
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("says it is clean again when it closes", async () => {
    const onDirtyChange = vi.fn();
    await renderEditor({ onDirtyChange });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    cleanup();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});

describe("a service with values emptied on purpose", () => {
  it("shows what the empty list means and saves it back unchanged", async () => {
    const { onSave } = await renderEditor({
      name: "github",
      service: { preset: "github", placeholder_env: {}, description: "" },
    });
    expect(screen.queryByLabelText("Placeholder 1 name")).toBeNull();
    openMoreOptions();
    expect(
      screen.getByText(
        /This service sets none, which drops the placeholders of the GitHub preset/,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("github", {
      preset: "github",
      description: "",
      placeholder_env: {},
    });
  });

  it("offers the preset's placeholders when the service has not set any", async () => {
    await renderEditor({ name: "github", service: { preset: "github" } });
    openMoreOptions();
    expect(
      screen.getByText(
        /Leave the list empty to use the placeholders of the GitHub preset/,
      ),
    ).toBeInTheDocument();
  });
});

describe("choosing another preset", () => {
  it("forgets what the loaded service emptied on purpose", async () => {
    const { onSave } = await renderEditor({
      name: "mine",
      service: {
        preset: "openai",
        display_name: null,
        description: "",
        placeholder_env: {},
      },
    });
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "github" },
    });
    openMoreOptions();
    // The GitHub preset has placeholders of its own, so the list is not "none".
    expect(
      screen.getByText(
        /Leave the list empty to use the placeholders of the GitHub preset/,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("mine", { preset: "github" });
  });
});

describe("the GitHub helper on a custom service", () => {
  const enter = (value: string) =>
    fireEvent.change(screen.getByLabelText("GitHub repositories"), {
      target: { value },
    });
  const apply = () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Use these repositories" }),
    );
  const rulesFor = (repository: string) => [
    {
      host: "api.github.com",
      path_prefix: `/repos/${repository}`,
      auth: { type: "bearer" },
    },
    {
      host: "github.com",
      path_prefix: `/${repository}`,
      auth: { type: "basic", username: "x-access-token" },
    },
    {
      host: "github.com",
      path_prefix: `/${repository}.git`,
      auth: { type: "basic", username: "x-access-token" },
    },
  ];

  it("adds the GH_TOKEN and GITHUB_TOKEN placeholders and shows them", async () => {
    const { onSave } = await renderEditor();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "code" },
    });
    fireEvent.change(screen.getByLabelText("Website"), {
      target: { value: "api.github.com" },
    });
    expect(screen.queryByLabelText("Placeholder 1 name")).toBeNull();
    enter("o/r");
    apply();

    // More options opens so the user sees what was added.
    expect(screen.getByLabelText("Placeholder 1 name")).toHaveValue("GH_TOKEN");
    expect(screen.getByLabelText("Placeholder 1 value")).toHaveValue(
      "mindroom-brokered",
    );
    expect(screen.getByLabelText("Placeholder 2 name")).toHaveValue(
      "GITHUB_TOKEN",
    );
    expect(screen.getByLabelText("Placeholder 2 value")).toHaveValue(
      "mindroom-brokered",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("code", {
      display_name: "GitHub (o/r)",
      description: "Limited to o/r",
      rules: rulesFor("o/r"),
      restrict_to_rules: true,
      placeholder_env: {
        GH_TOKEN: "mindroom-brokered",
        GITHUB_TOKEN: "mindroom-brokered",
      },
    });
  });

  it("leaves the placeholders a service already has alone", async () => {
    const { onSave } = await renderEditor({
      name: "code",
      service: {
        rules: [{ host: "api.github.com", auth: { type: "bearer" } }],
        placeholder_env: { MY_GITHUB_TOKEN: "mindroom-brokered" },
      },
    });
    enter("o/r");
    apply();
    expect(screen.getByLabelText("Placeholder 1 name")).toHaveValue(
      "MY_GITHUB_TOKEN",
    );
    expect(screen.queryByLabelText("Placeholder 2 name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("code", {
      display_name: "GitHub (o/r)",
      description: "Limited to o/r",
      rules: rulesFor("o/r"),
      restrict_to_rules: true,
      placeholder_env: { MY_GITHUB_TOKEN: "mindroom-brokered" },
    });
  });

  it("adds them only once when the repositories are applied again", async () => {
    await renderEditor();
    fireEvent.change(screen.getByLabelText("Website"), {
      target: { value: "api.github.com" },
    });
    enter("o/r");
    apply();
    enter("o/other");
    apply();
    expect(screen.getByLabelText("Placeholder 2 name")).toHaveValue(
      "GITHUB_TOKEN",
    );
    expect(screen.queryByLabelText("Placeholder 3 name")).toBeNull();
  });

  it("renames the labels it filled when applied again, but never ones the user typed", async () => {
    await renderEditor();
    fireEvent.change(screen.getByLabelText("Website"), {
      target: { value: "api.github.com" },
    });
    enter("o/r");
    apply();
    enter("o/other");
    apply();
    expect(screen.getByLabelText("Display name")).toHaveValue(
      "GitHub (o/other)",
    );
    expect(screen.getByLabelText("Description")).toHaveValue(
      "Limited to o/other",
    );
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "My own words" },
    });
    enter("o/third");
    apply();
    expect(screen.getByLabelText("Display name")).toHaveValue(
      "GitHub (o/third)",
    );
    expect(screen.getByLabelText("Description")).toHaveValue("My own words");
  });

  it("adds none to a preset service, which brings its own", async () => {
    const { onSave } = await renderEditor({
      name: "github",
      service: { preset: "github" },
    });
    enter("o/r");
    apply();
    expect(screen.queryByLabelText("Placeholder 1 name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(vi.mocked(onSave).mock.calls[0][1]).not.toHaveProperty(
      "placeholder_env",
    );
  });
});

describe("a form after a failed save", () => {
  it("keeps the input, clears the error with the next try, and saves the later edits", async () => {
    const onSave = vi
      .fn<(name: string, service: object) => Promise<void>>()
      .mockRejectedValueOnce(new Error("The server said no"))
      .mockResolvedValue(undefined);
    await renderEditor({ onSave });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "svc" },
    });
    fireEvent.change(screen.getByLabelText("Website"), {
      target: { value: "a.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The server said no",
    );
    expect(screen.getByLabelText("Name")).toHaveValue("svc");
    expect(screen.getByLabelText("Website")).toHaveValue("a.example.com");
    expect(screen.getByRole("button", { name: "Save service" })).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Website"), {
      target: { value: "b.example.com" },
    });
    openMoreOptions();
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.change(screen.getByLabelText("Rule 2 host"), {
      target: { value: "c.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith("svc", {
      rules: [
        { host: "b.example.com", auth: { type: "bearer" } },
        { host: "c.example.com", auth: { type: "bearer" } },
      ],
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a validation problem found after the server error instead of saving", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("The server said no");
    });
    await renderEditor({ onSave });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "svc" },
    });
    fireEvent.change(screen.getByLabelText("Website"), {
      target: { value: "a.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    await screen.findByText("The server said no");

    fireEvent.change(screen.getByLabelText("Website"), {
      target: { value: "https://a.example.com" },
    });
    expect(screen.getByLabelText("Website")).toHaveAccessibleDescription(
      /Host must not contain a scheme/,
    );
    // The server's answer gives way to what the form itself can see.
    expect(screen.queryByText("The server said no")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe("the account login field", () => {
  it("refuses a value that is not a provider id", async () => {
    const { onSave } = await renderEditor();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "svc" },
    });
    fireEvent.change(screen.getByLabelText("Website"), {
      target: { value: "a.example.com" },
    });
    openMoreOptions();
    fireEvent.change(screen.getByLabelText("Account login (optional)"), {
      target: { value: "Git Hub" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    expect(
      screen.getByLabelText("Account login (optional)"),
    ).toHaveAccessibleDescription(/Account login must be a provider id/);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("the basic form", () => {
  const before = (first: HTMLElement, second: HTMLElement) =>
    Boolean(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  const MORE_FIELDS = [
    "Display name",
    "Description",
    "Path prefix",
    "Port",
    "Refuse other paths on these hosts",
    "Account login (optional)",
  ];

  it("shows the basic fields first and the others under More options", async () => {
    await renderEditor({ saveKey: vi.fn(async () => undefined) });
    const basic = ["Name", "Preset", "Website", "Send the key as", "API key"];
    const fields = basic.map((label) => screen.getByLabelText(label));
    fields.slice(1).forEach((field, index) => {
      expect(before(fields[index], field)).toBe(true);
    });
    const more = screen.getByRole("button", { name: "More options" });
    for (const field of fields) expect(before(field, more)).toBe(true);
    expect(more).toHaveAttribute("aria-expanded", "false");
    for (const label of MORE_FIELDS)
      expect(screen.queryByLabelText(label)).toBeNull();
    expect(screen.queryByText("Placeholder variables")).toBeNull();

    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    for (const label of MORE_FIELDS)
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByText("Placeholder variables")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add rule" }),
    ).toBeInTheDocument();
    // Everything under More options comes after the toggle.
    for (const label of MORE_FIELDS)
      expect(before(more, screen.getByLabelText(label))).toBe(true);

    fireEvent.click(more);
    expect(screen.queryByLabelText("Display name")).toBeNull();
  });

  it("asks for a header name only when the key goes in a header", async () => {
    await renderEditor();
    expect(screen.queryByLabelText("Header name")).toBeNull();
    fireEvent.change(screen.getByLabelText("Send the key as"), {
      target: { value: "header" },
    });
    expect(screen.getByLabelText("Header name")).toBeInTheDocument();
  });

  it("explains the header name with an example and does not prefill one", async () => {
    await renderEditor();
    fireEvent.change(screen.getByLabelText("Send the key as"), {
      target: { value: "header" },
    });
    const field = screen.getByLabelText("Header name");
    expect(field).toHaveAccessibleDescription("For example X-Api-Key");
    expect(field).not.toHaveAttribute("placeholder");
    expect(field).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Send the key as"), {
      target: { value: "query" },
    });
    expect(screen.getByLabelText("Parameter name")).not.toHaveAttribute(
      "placeholder",
    );
  });

  it("keeps the first rule's host, path, port, and way of sending in step", async () => {
    await renderEditor({
      name: "svc",
      service: {
        rules: [
          {
            host: "api.example.com",
            port: 8443,
            path_prefix: "/v1/",
            auth: { type: "basic", username: "bot" },
          },
        ],
      },
    });
    expect(screen.getByLabelText("Website")).toHaveValue("api.example.com");
    expect(screen.getByLabelText("Send the key as")).toHaveValue("basic");
    expect(screen.getByLabelText("Username")).toHaveValue("bot");
    // It has path and port, so More options is already open.
    expect(screen.getByLabelText("Path prefix")).toHaveValue("/v1/");
    expect(screen.getByLabelText("Port")).toHaveValue("8443");
  });
});

describe("the name of a new service", () => {
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it("follows the preset id and then the host's first label until the user types one", async () => {
    await renderEditor();
    type("Website", "httpbin.org");
    expect(screen.getByLabelText("Name")).toHaveValue("httpbin");
    type("Website", "api.example.com");
    expect(screen.getByLabelText("Name")).toHaveValue("api");
    type("Preset", "github");
    expect(screen.getByLabelText("Name")).toHaveValue("github");
    type("Preset", "");
    expect(screen.getByLabelText("Name")).toHaveValue("api");
    type("Preset", "google_drive");
    expect(screen.getByLabelText("Name")).toHaveValue("google_drive");

    type("Name", "mine");
    type("Preset", "openai");
    expect(screen.getByLabelText("Name")).toHaveValue("mine");
    type("Preset", "");
    type("Website", "other.example.com");
    expect(screen.getByLabelText("Name")).toHaveValue("mine");
  });

  it("follows again after the user empties the name", async () => {
    await renderEditor();
    type("Name", "mine");
    type("Name", "");
    type("Website", "httpbin.org");
    expect(screen.getByLabelText("Name")).toHaveValue("httpbin");
  });

  it("saves the suggested name", async () => {
    const { onSave } = await renderEditor();
    type("Website", "httpbin.org");
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("httpbin", {
      rules: [{ host: "httpbin.org", auth: { type: "bearer" } }],
    });
  });

  it("never renames a service that is being edited", async () => {
    await renderEditor({
      name: "mine",
      service: { rules: [{ host: "a.example.com", auth: { type: "bearer" } }] },
    });
    type("Website", "b.example.com");
    expect(screen.getByLabelText("Name")).toHaveValue("mine");
  });

  it("starts with the name it was opened with and keeps it", async () => {
    await renderEditor({
      initialName: "github-limited",
      initialPreset: "github",
    });
    expect(screen.getByLabelText("Name")).toHaveValue("github-limited");
    expect(screen.getByLabelText("Preset")).toHaveValue("github");
    type("Preset", "openai");
    expect(screen.getByLabelText("Name")).toHaveValue("github-limited");
  });

  it("says Name is required, beside the name, and focuses it", async () => {
    const { onSave } = await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription(
      /Name is required/,
    );
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("prefilling a new service", () => {
  it("opens Add mode with the preset and the name it was given", async () => {
    const { onSave } = await renderEditor({
      initialPreset: "github",
      initialName: "github-limited",
    });
    expect(
      screen.getByRole("form", { name: "Add service" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeEnabled();
    expect(screen.getByLabelText("Preset")).toHaveValue("github");
    // The GitHub helper comes with the GitHub preset.
    expect(screen.getByText("Limit to repositories")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("github-limited", { preset: "github" });
  });

  it("names the service after the preset when only the preset is given", async () => {
    await renderEditor({ initialPreset: "github" });
    expect(screen.getByLabelText("Name")).toHaveValue("github");
  });

  it("is not unsaved changes until the user changes something", async () => {
    const onDirtyChange = vi.fn();
    await renderEditor({
      initialPreset: "github",
      initialName: "github-limited",
      onDirtyChange,
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("ignores them when editing a service", async () => {
    await renderEditor({
      name: "mine",
      service: { preset: "openai" },
      initialPreset: "github",
      initialName: "other",
    });
    expect(screen.getByLabelText("Name")).toHaveValue("mine");
    expect(screen.getByLabelText("Preset")).toHaveValue("openai");
  });
});

describe("errors beside their fields", () => {
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const save = () =>
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));

  it("shows each problem next to its field and focuses the first invalid one", async () => {
    const { onSave } = await renderEditor();
    save();
    const name = screen.getByLabelText("Name");
    const website = screen.getByLabelText("Website");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription(/Name is required/);
    expect(website).toHaveAttribute("aria-invalid", "true");
    expect(website).toHaveAccessibleDescription(/Host is required/);
    expect(name).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();
    // Fields without a problem are not marked.
    expect(screen.getByLabelText("Preset")).not.toHaveAttribute("aria-invalid");

    type("Name", "svc");
    // The messages follow the form once the user has tried to save.
    expect(name).not.toHaveAttribute("aria-invalid");
    expect(website).toHaveAttribute("aria-invalid", "true");
    save();
    expect(website).toHaveFocus();
    type("Website", "a.example.com");
    expect(website).not.toHaveAttribute("aria-invalid");
  });

  it("opens More options for a problem in it, and focuses that field", async () => {
    const { onSave } = await renderEditor();
    type("Website", "a.example.com");
    openMoreOptions();
    type("Path prefix", "v1");
    openMoreOptions();
    expect(screen.queryByLabelText("Path prefix")).toBeNull();
    save();
    const path = screen.getByLabelText("Path prefix");
    expect(path).toHaveAccessibleDescription(/Path prefix must start with \//);
    expect(path).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows a problem of an extra rule inside that rule", async () => {
    await renderEditor();
    type("Website", "a.example.com");
    openMoreOptions();
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    save();
    const host = screen.getByLabelText("Rule 2 host");
    expect(host).toHaveAccessibleDescription(/Host is required/);
    expect(host).toHaveFocus();
  });

  it("shows the field of a header, a template, or a port", async () => {
    await renderEditor();
    type("Name", "svc");
    type("Website", "a.example.com");
    type("Send the key as", "template");
    openMoreOptions();
    type("Port", "99999");
    save();
    expect(screen.getByLabelText("Header name")).toHaveAccessibleDescription(
      /Header auth needs a header name/,
    );
    expect(screen.getByLabelText("Value template")).toHaveAccessibleDescription(
      /Template must contain \{secret\} exactly once/,
    );
    expect(screen.getByLabelText("Port")).toHaveAccessibleDescription(
      /Port must be a number from 1 to 65535/,
    );
    // The header name comes first on the page.
    expect(screen.getByLabelText("Header name")).toHaveFocus();
  });

  it("keeps showing the server's own error in an alert", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("Could not save the service.");
    });
    await renderEditor({ onSave });
    type("Website", "a.example.com");
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save the service.",
    );
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-invalid");
  });

  it("states a size problem for the whole form in an alert", async () => {
    await renderEditor();
    type("Website", "a.example.com");
    openMoreOptions();
    type("Description", "x".repeat(17 * 1024));
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A service can take at most 16 KiB",
    );
  });
});

describe("saving the API key with the service", () => {
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const save = () =>
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
  const fill = () => {
    type("Name", "httpbin");
    type("Website", "httpbin.org");
  };

  it("offers an optional password field for the key", async () => {
    await renderEditor({ saveKey: vi.fn(async () => undefined) });
    const field = screen.getByLabelText("API key");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAccessibleDescription("Paste the key now or later");
    expect(field).toHaveAttribute("autocomplete", "new-password");
  });

  it("leaves the key field out when the page cannot save keys", async () => {
    await renderEditor();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  it("writes the service first and the key second, then reports it saved", async () => {
    const calls: string[] = [];
    const onSave = vi.fn(async () => {
      calls.push("service");
    });
    const saveKey = vi.fn(async () => {
      calls.push("key");
    });
    const onSaved = vi.fn(() => {
      calls.push("saved");
    });
    await renderEditor({ onSave, saveKey, onSaved });
    fill();
    type("API key", "sk-123");
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(["service", "key", "saved"]);
    expect(saveKey).toHaveBeenCalledWith("sk-123", "httpbin");
    expect(onSave).toHaveBeenCalledWith("httpbin", {
      rules: [{ host: "httpbin.org", auth: { type: "bearer" } }],
    });
  });

  it("saves only the service when no key was typed", async () => {
    const saveKey = vi.fn(async () => undefined);
    const onSaved = vi.fn();
    const { onSave } = await renderEditor({ saveKey, onSaved });
    fill();
    type("API key", "   ");
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(saveKey).not.toHaveBeenCalled();
  });

  it("never saves a key for a service whose save failed", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("The server said no");
    });
    const saveKey = vi.fn(async () => undefined);
    const onSaved = vi.fn();
    await renderEditor({ onSave, saveKey, onSaved });
    fill();
    type("API key", "sk-123");
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The server said no",
    );
    expect(saveKey).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    // The key stays typed for the next try.
    expect(screen.getByLabelText("API key")).toHaveValue("sk-123");
    expect(screen.getByLabelText("Name")).toBeEnabled();
  });

  it("says when the key failed, keeps the service, and retries only the key", async () => {
    const onSave = vi.fn(async () => undefined);
    const saveKey = vi
      .fn<(key: string, name: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("The vault is read-only"))
      .mockResolvedValue(undefined);
    const onSaved = vi.fn();
    await renderEditor({ onSave, saveKey, onSaved });
    fill();
    type("API key", "sk-123");
    save();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The service was saved, but its key was not: The vault is read-only",
    );
    expect(alert).toHaveTextContent("Paste the key again and save to retry.");
    expect(onSaved).not.toHaveBeenCalled();
    // The saved service stays: it keeps its name, and the form stays open.
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(
      screen.getByRole("form", { name: "Add service" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toHaveValue("sk-123");

    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(saveKey).toHaveBeenCalledTimes(2);
    expect(saveKey).toHaveBeenLastCalledWith("sk-123", "httpbin");
    // Nothing changed in the service, so it is not written again.
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("writes the service again when it changed after the key failed", async () => {
    const onSave = vi.fn(async () => undefined);
    const saveKey = vi
      .fn<(key: string, name: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("The vault is read-only"))
      .mockResolvedValue(undefined);
    await renderEditor({ onSave, saveKey });
    fill();
    type("API key", "sk-123");
    save();
    await screen.findByRole("alert");
    type("Website", "other.example.com");
    save();
    await waitFor(() => expect(saveKey).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith("httpbin", {
      rules: [{ host: "other.example.com", auth: { type: "bearer" } }],
    });
  });

  it("counts a typed key as unsaved changes", async () => {
    const onDirtyChange = vi.fn();
    await renderEditor({
      name: "github",
      service: { preset: "github" },
      saveKey: vi.fn(async () => undefined),
      onDirtyChange,
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    type("API key", "sk-1");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it("can set a key while editing a service", async () => {
    const saveKey = vi.fn(async () => undefined);
    const onSaved = vi.fn();
    await renderEditor({
      name: "github",
      service: { preset: "github" },
      saveKey,
      onSaved,
    });
    type("API key", "ghp_x");
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saveKey).toHaveBeenCalledWith("ghp_x", "github");
  });
});

describe("a placeholder an administrator's service also sets", () => {
  const configPlaceholders = { GH_TOKEN: "GitHub" };
  const warning =
    "GH_TOKEN is also set by GitHub from your administrator; when both are set, theirs is used.";
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it("warns with the service's display name, and only for that variable", async () => {
    const { onSave } = await renderEditor({ configPlaceholders });
    type("Name", "svc");
    type("Website", "a.example.com");
    openMoreOptions();
    fireEvent.click(screen.getByRole("button", { name: "Add placeholder" }));
    type("Placeholder 1 name", "MY_API_KEY");
    expect(screen.queryByText(warning)).toBeNull();
    type("Placeholder 1 name", "GH_TOKEN");
    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(
      screen.getByLabelText("Placeholder 1 name"),
    ).toHaveAccessibleDescription(warning);
    // It is a warning: the service still saves.
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("svc", {
      rules: [{ host: "a.example.com", auth: { type: "bearer" } }],
      placeholder_env: { GH_TOKEN: "mindroom-brokered" },
    });
  });

  it("does not mark the field as invalid", async () => {
    await renderEditor({
      configPlaceholders,
      name: "svc",
      service: { preset: "github", placeholder_env: { GH_TOKEN: "x" } },
    });
    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(screen.getByLabelText("Placeholder 1 name")).not.toHaveAttribute(
      "aria-invalid",
    );
  });

  it("warns for the placeholders the GitHub helper adds", async () => {
    await renderEditor({ configPlaceholders });
    type("Website", "api.github.com");
    fireEvent.change(screen.getByLabelText("GitHub repositories"), {
      target: { value: "o/r" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Use these repositories" }),
    );
    expect(screen.getByText(warning)).toBeInTheDocument();
  });

  it("says nothing without any", async () => {
    await renderEditor({
      name: "svc",
      service: { preset: "github", placeholder_env: { GH_TOKEN: "x" } },
    });
    expect(screen.queryByText(/from your administrator; when both/)).toBeNull();
  });
});

describe("the note on whose service this is", () => {
  it("names the agent for a user_agent service", async () => {
    await renderEditor({
      scope: "user_agent",
      agentName: "Code Helper",
      scopeAgents: [],
    });
    expect(
      screen.getByText("Only your Code Helper uses this service and its key."),
    ).toBeInTheDocument();
  });

  it("lists the agents that share a user's workspace", async () => {
    await renderEditor({
      scope: "user",
      agentName: "Code Helper",
      scopeAgents: ["Code Helper", "Research"],
    });
    expect(
      screen.getByText(
        "All your agents that share your personal workspace use this service and its key: Code Helper, Research.",
      ),
    ).toBeInTheDocument();
  });

  it("says nothing for a shared agent or the dashboard, and drops the old note", async () => {
    const oldNote =
      "This service applies to all of your personal agents that share this scope.";
    await renderEditor({
      scope: "shared",
      agentName: "Team",
      sharedTarget: true,
    });
    expect(screen.queryByText(/uses this service and its key/)).toBeNull();
    expect(screen.queryByText(/use this service and its key/)).toBeNull();
    expect(screen.queryByText(oldNote)).toBeNull();
    cleanup();
    await renderEditor({ context: "operator" });
    expect(screen.queryByText(/service and its key/)).toBeNull();
    expect(screen.queryByText(oldNote)).toBeNull();
    cleanup();
    await renderEditor();
    expect(screen.queryByText(oldNote)).toBeNull();
  });
});

describe("a free name for a new service", () => {
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const nameField = () => screen.getByLabelText("Name");

  it("skips the names the page already lists", async () => {
    await renderEditor({ takenNames: ["github"] });
    type("Preset", "github");
    expect(nameField()).toHaveValue("github-2");
    cleanup();
    await renderEditor({ takenNames: ["github", "github-2"] });
    type("Preset", "github");
    expect(nameField()).toHaveValue("github-3");
  });

  it("does the same for a name taken from the host", async () => {
    await renderEditor({ takenNames: ["httpbin"] });
    type("Website", "httpbin.org");
    expect(nameField()).toHaveValue("httpbin-2");
  });

  it("opens with a free name when only the preset is given", async () => {
    await renderEditor({ initialPreset: "github", takenNames: ["github"] });
    expect(nameField()).toHaveValue("github-2");
  });

  it("names the clash when all three are taken", async () => {
    const { onSave } = await renderEditor({
      takenNames: ["github", "github-2", "github-3"],
    });
    type("Preset", "github");
    expect(nameField()).toHaveValue("github");
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    expect(nameField()).toHaveAccessibleDescription(
      /A service named github already exists/,
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves the free name it suggested", async () => {
    const { onSave } = await renderEditor({ takenNames: ["github"] });
    type("Preset", "github");
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("github-2", { preset: "github" });
  });

  it("never changes a name the user typed or was given", async () => {
    await renderEditor({ takenNames: ["github"] });
    type("Name", "github");
    type("Preset", "github");
    expect(nameField()).toHaveValue("github");
    cleanup();
    await renderEditor({ initialName: "github", takenNames: ["github"] });
    expect(nameField()).toHaveValue("github");
  });
});

describe("the name after the GitHub helper", () => {
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const limit = (repositories: string) => {
    fireEvent.change(screen.getByLabelText("GitHub repositories"), {
      target: { value: repositories },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Use these repositories" }),
    );
  };

  it("keeps the name when the helper replaces the rules", async () => {
    await renderEditor();
    type("Website", "github.com");
    expect(screen.getByLabelText("Name")).toHaveValue("github");
    // The helper's first rule is on api.github.com, whose first label is "api".
    limit("o/r");
    expect(screen.getByLabelText("Website")).toHaveValue("api.github.com");
    expect(screen.getByLabelText("Name")).toHaveValue("github");
  });

  it("keeps it after the user edits the website too, as a name the helper fixed", async () => {
    await renderEditor();
    type("Website", "github.com");
    limit("o/r");
    type("Website", "uploads.github.com");
    expect(screen.getByLabelText("Name")).toHaveValue("github");
  });

  it("keeps the suggested name of the preset", async () => {
    await renderEditor({ takenNames: ["github"] });
    type("Preset", "github");
    limit("o/r");
    expect(screen.getByLabelText("Name")).toHaveValue("github-2");
  });
});

describe("a preset's placeholders an administrator's service also sets", () => {
  const configPlaceholders = { GH_TOKEN: "GitHub" };
  const warning =
    "GH_TOKEN is also set by GitHub from your administrator; when both are set, theirs is used.";

  it("warns in the basic form, beside the preset, when the preset brings them", async () => {
    await renderEditor({
      name: "mine",
      service: { preset: "github" },
      configPlaceholders,
    });
    // More options is still collapsed, and the warning is already there.
    expect(screen.queryByLabelText("Display name")).toBeNull();
    expect(screen.getByText(warning)).toBeVisible();
    // GITHUB_TOKEN is not set by the administrator's service.
    expect(screen.queryByText(/GITHUB_TOKEN is also set/)).toBeNull();
  });

  it("shows it once, not again under the placeholder variables", async () => {
    await renderEditor({
      name: "mine",
      service: { preset: "github" },
      configPlaceholders,
    });
    openMoreOptions();
    expect(screen.getByLabelText("Display name")).toBeVisible();
    expect(screen.getAllByText(warning)).toHaveLength(1);
  });

  it("warns on choosing the preset without opening More options", async () => {
    await renderEditor({ configPlaceholders });
    expect(screen.queryByText(warning)).toBeNull();
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "github" },
    });
    expect(screen.queryByLabelText("Display name")).toBeNull();
    expect(screen.getByText(warning)).toBeVisible();
  });

  it("follows the chosen preset", async () => {
    await renderEditor({ configPlaceholders });
    expect(screen.queryByText(warning)).toBeNull();
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "github" },
    });
    expect(screen.getByText(warning)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Preset"), {
      target: { value: "openai" },
    });
    expect(screen.queryByText(warning)).toBeNull();
  });

  it("stops once the service lists placeholders of its own", async () => {
    await renderEditor({
      name: "mine",
      service: { preset: "github", placeholder_env: { MY_API_KEY: "x" } },
      configPlaceholders,
    });
    expect(screen.queryByText(warning)).toBeNull();
  });

  it("stays quiet when the service drops the preset's placeholders on purpose", async () => {
    await renderEditor({
      name: "mine",
      service: { preset: "github", placeholder_env: {} },
      configPlaceholders,
    });
    expect(screen.queryByText(warning)).toBeNull();
  });
});

describe("which section a problem opens", () => {
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const toggle = () => screen.getByRole("button", { name: "More options" });
  const save = () =>
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));

  it.each<[string, string, () => void, boolean]>([
    ["the host", "Website", () => type("Website", ""), true],
    ["the username", "Username", () => type("Send the key as", "basic"), true],
    [
      "the header name",
      "Header name",
      () => type("Send the key as", "header"),
      true,
    ],
    [
      "the template",
      "Value template",
      () => {
        type("Send the key as", "template");
        type("Header name", "Authorization");
      },
      true,
    ],
    [
      "the path prefix",
      "Path prefix",
      () => {
        openMoreOptions();
        type("Path prefix", "v1");
        openMoreOptions();
      },
      false,
    ],
    [
      "the port",
      "Port",
      () => {
        openMoreOptions();
        type("Port", "0");
        openMoreOptions();
      },
      false,
    ],
  ])("%s", async (_name, label, arrange, basic) => {
    const { onSave } = await renderEditor();
    type("Name", "svc");
    type("Website", "a.example.com");
    arrange();
    save();
    // A problem in a basic field leaves More options as it was; any other opens it.
    expect(toggle()).toHaveAttribute("aria-expanded", String(!basic));
    expect(screen.getByLabelText(label)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText(label)).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("focuses the message for a problem of the rule list as a whole", async () => {
    const rules = Array.from({ length: 51 }, (_, index) => ({
      host: `h${index}.example.com`,
      auth: { type: "bearer" as const },
    }));
    const onSave = vi.fn(async () => undefined);
    // Fifty-one rules make a large page, where label and role queries are slow, so query it directly.
    const { container } = render(
      <EgressServiceEditor
        {...baseProps()}
        name="big"
        service={{ rules }}
        onSave={onSave}
      />,
    );
    const submit = container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit as HTMLButtonElement);
    const message = screen.getByText("A service can have at most 50 rules");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(message).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("what a collapsed or failed form keeps and shows", () => {
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const save = () =>
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));

  it("keeps a value typed under More options after the section is collapsed", async () => {
    const { onSave } = await renderEditor();
    type("Name", "svc");
    type("Website", "a.example.com");
    openMoreOptions();
    type("Display name", "Typed here");
    type("Path prefix", "/v1/");
    openMoreOptions();
    expect(screen.queryByLabelText("Display name")).toBeNull();
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("svc", {
      display_name: "Typed here",
      rules: [
        {
          host: "a.example.com",
          path_prefix: "/v1/",
          auth: { type: "bearer" },
        },
      ],
    });
    // The save does not reopen the section.
    expect(screen.queryByLabelText("Display name")).toBeNull();
  });

  it("shows the typed value again when the section is reopened", async () => {
    await renderEditor();
    openMoreOptions();
    type("Display name", "Typed here");
    openMoreOptions();
    openMoreOptions();
    expect(screen.getByLabelText("Display name")).toHaveValue("Typed here");
  });

  it("never prints the typed key after the key failed", async () => {
    const saveKey = vi.fn(async () => {
      throw new Error("The vault is read-only");
    });
    await renderEditor({ saveKey });
    type("Name", "svc");
    type("Website", "a.example.com");
    type("API key", "sk-very-secret-123");
    save();
    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent("sk-very-secret-123");
    expect(document.body.textContent).not.toContain("sk-very-secret-123");
    // It stays in the password field for the retry, and nowhere as text.
    expect(screen.getByLabelText("API key")).toHaveValue("sk-very-secret-123");
    expect(screen.getByLabelText("API key")).toHaveAttribute(
      "type",
      "password",
    );
  });
});

describe("asking before discarding an open editor", () => {
  it("offers to discard or to keep editing", () => {
    const onDiscard = vi.fn();
    const onKeep = vi.fn();
    render(<DiscardEditsNotice onDiscard={onDiscard} onKeep={onKeep} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You have unsaved changes in the open editor.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(onKeep).toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onDiscard).toHaveBeenCalled();
  });
});
