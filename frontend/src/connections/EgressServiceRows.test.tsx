import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubRepositoryRules } from "./egressServiceModel";
import {
  EgressServiceRows,
  type RowAgent,
  type ServiceEditing,
} from "./EgressServiceRows";
import type { EgressCredentialService, EgressOAuthStatus } from "./types";

const github: EgressCredentialService = {
  name: "github",
  display_name: "GitHub",
  description: "GitHub API and git over HTTPS",
  is_shared: false,
  can_manage: true,
  configured: false,
  updated_at: null,
  active_source: null,
  key_configured: false,
  key_updated_at: null,
  oauth: null,
};
const openai: EgressCredentialService = {
  ...github,
  name: "openai",
  display_name: "OpenAI",
  description: "OpenAI API",
  configured: true,
  active_source: "key",
  key_configured: true,
};
const githubAccount: EgressOAuthStatus = {
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
const withAccount = (
  account: Partial<EgressOAuthStatus> = {},
  service: Partial<EgressCredentialService> = {},
): EgressCredentialService => ({
  ...github,
  oauth: { ...githubAccount, ...account },
  ...service,
});
const connectedGithub = withAccount(
  { connected: true, account_label: "octocat" },
  { configured: true, active_source: "oauth" },
);
const authorization = {
  provider: "github",
  auth_url: "https://github.com/login/oauth/authorize?state=abc",
  completion_origin: "https://portal.example.com",
};

const noContent = () => new Response(null, { status: 204 });
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const row = (name: string) => screen.getByRole("listitem", { name });

beforeEach(() => {
  vi.mocked(fetch).mockImplementation(async () => noContent());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("egress service rows", () => {
  it("shows name, description and the Set or Not set status", () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[github, openai]}
        onChanged={vi.fn()}
      />,
    );
    expect(within(row("GitHub")).getByText("Not set")).toBeInTheDocument();
    expect(
      within(row("GitHub")).getByText("GitHub API and git over HTTPS"),
    ).toBeInTheDocument();
    expect(within(row("OpenAI")).getByText("Set")).toBeInTheDocument();
    expect(
      within(row("GitHub")).getByRole("button", { name: "Set GitHub API key" }),
    ).toBeInTheDocument();
    expect(
      within(row("OpenAI")).getByRole("button", {
        name: "Replace OpenAI API key",
      }),
    ).toBeInTheDocument();
  });

  it("shows the update date for a key with a known timestamp", () => {
    const updatedAt = "2026-10-05T12:00:00+00:00";
    render(
      <EgressServiceRows
        agentName="personal"
        services={[
          { ...openai, updated_at: updatedAt, key_updated_at: updatedAt },
        ]}
        onChanged={vi.fn()}
      />,
    );
    expect(
      screen.getByText(`Updated ${new Date(updatedAt).toLocaleDateString()}`),
    ).toBeInTheDocument();
  });

  it("saves the key, clears the input and reports the change", async () => {
    const onChanged = vi.fn();
    render(
      <EgressServiceRows
        agentName="personal"
        services={[github]}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Set GitHub API key" }));
    const input = screen.getByLabelText("GitHub API key");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      "/api/connections/egress/agents/personal/github",
      expect.objectContaining({
        method: "PUT",
        credentials: "same-origin",
        body: JSON.stringify({ secret: "abc" }),
      }),
    );
    expect(screen.queryByLabelText("GitHub API key")).toBeNull();
    // Reopening the editor must not show the previous value.
    fireEvent.click(screen.getByRole("button", { name: "Set GitHub API key" }));
    expect(screen.getByLabelText("GitHub API key")).toHaveValue("");
  });

  it("encodes the agent and service names in the request path", async () => {
    render(
      <EgressServiceRows
        agentName="my agent"
        services={[{ ...github, name: "git/hub" }]}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Set GitHub API key" }));
    fireEvent.change(screen.getByLabelText("GitHub API key"), {
      target: { value: "abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "/api/connections/egress/agents/my%20agent/git%2Fhub",
    );
  });

  it("writes to a custom secret path instead of the connections API", async () => {
    render(
      <EgressServiceRows
        secretPath={(name) => `/custom/${name}/secret`}
        accountPath={(name, action) => `/custom/${name}/${action}`}
        services={[github]}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Set GitHub API key" }));
    fireEvent.change(screen.getByLabelText("GitHub API key"), {
      target: { value: "abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/custom/github/secret");
  });

  it("cancels without sending anything and drops the typed value", () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[openai]}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Replace OpenAI API key" }),
    );
    fireEvent.change(screen.getByLabelText("OpenAI API key"), {
      target: { value: "sk-typed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Replace OpenAI API key" }),
    );
    expect(screen.getByLabelText("OpenAI API key")).toHaveValue("");
  });

  it("keeps Save disabled until a key is typed", () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[github]}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Set GitHub API key" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("GitHub API key"), {
      target: { value: "   " },
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows the server validation message and keeps the editor open on failure", async () => {
    const onChanged = vi.fn();
    vi.mocked(fetch).mockImplementation(async () =>
      json({ detail: "Secret cannot be empty or whitespace" }, 422),
    );
    render(
      <EgressServiceRows
        agentName="personal"
        services={[github]}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Set GitHub API key" }));
    fireEvent.change(screen.getByLabelText("GitHub API key"), {
      target: { value: "abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Secret cannot be empty or whitespace",
    );
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByLabelText("GitHub API key")).toBeInTheDocument();
  });

  it("removes a key only after confirmation", async () => {
    const onChanged = vi.fn();
    render(
      <EgressServiceRows
        agentName="personal"
        services={[openai]}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove OpenAI API key" }),
    );
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      "/api/connections/egress/agents/personal/openai",
      expect.objectContaining({
        method: "DELETE",
        credentials: "same-origin",
      }),
    );
  });

  it("does not remove the key when the confirmation is cancelled", async () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[openai]}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove OpenAI API key" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("offers no Remove for a service without a key", () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[github]}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("shows status only to users who cannot manage the shared key", () => {
    render(
      <EgressServiceRows
        agentName="shared_dev"
        services={[{ ...openai, is_shared: true, can_manage: false }]}
        onChanged={vi.fn()}
      />,
    );
    expect(within(row("OpenAI")).getByText("Set")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Managed by credential managers")).toBeVisible();
  });

  it("warns that a shared key affects everyone who relies on it", async () => {
    render(
      <EgressServiceRows
        agentName="shared_dev"
        services={[{ ...openai, is_shared: true, can_manage: true }]}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove OpenAI API key" }),
    );
    expect(
      await screen.findByText(
        "This deletes the shared key. Everyone who relies on it loses access to this service until a key is set again.",
      ),
    ).toBeInTheDocument();
  });

  it("says the key is not shared when the scope is unknown", async () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[{ ...openai, is_shared: null }]}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove OpenAI API key" }),
    );
    expect(
      await screen.findByText(
        "This deletes the saved key. The agent loses access to this service until a key is set again.",
      ),
    ).toBeInTheDocument();
  });

  it("reports a forbidden save with the connections wording by default", async () => {
    vi.mocked(fetch).mockImplementation(async () => json({}, 403));
    render(
      <EgressServiceRows
        agentName="personal"
        services={[github]}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Set GitHub API key" }));
    fireEvent.change(screen.getByLabelText("GitHub API key"), {
      target: { value: "abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(
        "Connections are not available for this account.",
      ),
    ).toBeInTheDocument();
  });

  it("uses the supplied wording for 403 and 404 responses", async () => {
    render(
      <EgressServiceRows
        secretPath={(name) => `/custom/${name}/secret`}
        accountPath={(name, action) => `/custom/${name}/${action}`}
        errorMessages={{ forbidden: "No access.", notFound: "Gone." }}
        services={[openai]}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove OpenAI API key" }),
    );
    vi.mocked(fetch).mockImplementation(async () => json({}, 404));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Remove",
      }),
    );
    expect(await screen.findByText("Gone.")).toBeInTheDocument();

    vi.mocked(fetch).mockImplementation(async () => json({}, 403));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove OpenAI API key" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Remove",
      }),
    );
    expect(await screen.findByText("No access.")).toBeInTheDocument();
  });
});

describe("connected accounts", () => {
  let popup: {
    closed: boolean;
    close: ReturnType<typeof vi.fn>;
    location: { href: string };
  };

  beforeEach(() => {
    popup = {
      closed: false,
      close: vi.fn(),
      location: { href: "about:blank" },
    };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  });

  function finishAuthorization(provider = "github") {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: authorization.completion_origin,
        source: popup as unknown as Window,
        data: {
          type: "mindroom:oauth-complete",
          provider,
          status: "connected",
        },
      }),
    );
  }

  it("offers Connect first and keeps the key behind a secondary toggle", () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[withAccount()]}
        onChanged={vi.fn()}
      />,
    );
    const github = row("GitHub");
    expect(within(github).getByText("Not set")).toBeInTheDocument();
    expect(
      within(github).getByRole("button", { name: "Connect GitHub" }),
    ).toBeEnabled();
    expect(
      within(github).queryByRole("button", { name: "Set GitHub API key" }),
    ).toBeNull();

    fireEvent.click(
      within(github).getByRole("button", { name: "Use an API key instead" }),
    );
    expect(within(github).getByLabelText("GitHub API key")).toBeInTheDocument();
    expect(
      within(github).queryByRole("button", { name: "Use an API key instead" }),
    ).toBeNull();
    // Cancelling folds the key controls away again.
    fireEvent.click(within(github).getByRole("button", { name: "Cancel" }));
    expect(
      within(github).getByRole("button", { name: "Use an API key instead" }),
    ).toBeInTheDocument();
  });

  it("opens the popup, calls the connect endpoint and reports the change", async () => {
    vi.mocked(fetch).mockImplementation(async () => json(authorization));
    const onChanged = vi.fn();
    render(
      <EgressServiceRows
        agentName="my agent"
        services={[withAccount()]}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));

    await waitFor(() =>
      expect(popup.location.href).toBe(authorization.auth_url),
    );
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/connections/egress/agents/my%20agent/github/connect",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
    expect(
      screen.getByRole("button", { name: "Connect GitHub" }),
    ).toBeDisabled();
    expect(onChanged).not.toHaveBeenCalled();

    finishAuthorization();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(popup.close).toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Connect GitHub" }),
    ).toBeEnabled();
  });

  it("uses the supplied account paths for connect and disconnect", async () => {
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input).includes("/connect")
        ? json(authorization)
        : json({ status: "disconnected", provider: "github" }),
    );
    const onChanged = vi.fn();
    const { rerender } = render(
      <EgressServiceRows
        secretPath={(name) => `/custom/${name}/secret`}
        accountPath={(name, action) => `/custom/${name}/${action}?agent_name=a`}
        services={[withAccount()]}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    await waitFor(() =>
      expect(popup.location.href).toBe(authorization.auth_url),
    );
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "/custom/github/connect?agent_name=a",
    );
    finishAuthorization();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    rerender(
      <EgressServiceRows
        secretPath={(name) => `/custom/${name}/secret`}
        accountPath={(name, action) => `/custom/${name}/${action}?agent_name=a`}
        services={[connectedGithub]}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect GitHub" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Disconnect",
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe(
      "/custom/github/disconnect?agent_name=a",
    );
  });

  it("shows the server error and does not report a change when connecting fails", async () => {
    vi.mocked(fetch).mockImplementation(async () => json({}, 409));
    const onChanged = vi.fn();
    render(
      <EgressServiceRows
        agentName="personal"
        services={[withAccount()]}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not complete the request. Try again.",
    );
    expect(onChanged).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Connect GitHub" }),
    ).toBeEnabled();
  });

  it("tells the user when the browser blocks the popup", async () => {
    vi.mocked(window.open).mockReturnValue(null);
    render(
      <EgressServiceRows
        agentName="personal"
        services={[withAccount()]}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The popup was blocked",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("offers Connect only when the server says the account is connectable", () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[withAccount({ can_connect: false })]}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Use an API key instead" }),
    ).toBeInTheDocument();
  });

  it("lets a user without key rights connect a requester-scoped account", () => {
    render(
      <EgressServiceRows
        agentName="shared_dev"
        services={[withAccount({}, { is_shared: true, can_manage: false })]}
        onChanged={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Connect GitHub" }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: /API key/ })).toBeNull();
    expect(
      screen.getByText("API key managed by credential managers"),
    ).toBeVisible();
  });

  it("offers no actions to a user who can neither connect nor manage", () => {
    render(
      <EgressServiceRows
        agentName="shared_dev"
        services={[
          withAccount(
            { connected: true, can_connect: false },
            { is_shared: true, can_manage: false, active_source: "oauth" },
          ),
        ]}
        onChanged={vi.fn()}
      />,
    );
    expect(within(row("GitHub")).getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Managed by credential managers")).toBeVisible();
  });

  it("shows the connected account with Disconnect", () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[connectedGithub]}
        onChanged={vi.fn()}
      />,
    );
    const github = row("GitHub");
    expect(
      within(github).getByText("Connected as octocat"),
    ).toBeInTheDocument();
    expect(
      within(github).getByRole("button", { name: "Disconnect GitHub" }),
    ).toBeInTheDocument();
    expect(
      within(github).queryByRole("button", { name: /Connect/ }),
    ).toBeNull();
  });

  it("says Connected when the provider gives no account label", () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[
          withAccount(
            { connected: true },
            { configured: true, active_source: "oauth" },
          ),
        ]}
        onChanged={vi.fn()}
      />,
    );
    expect(within(row("GitHub")).getByText("Connected")).toBeInTheDocument();
  });

  it("disconnects only after confirmation and reports the change", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      json({ status: "disconnected", provider: "github" }),
    );
    const onChanged = vi.fn();
    render(
      <EgressServiceRows
        agentName="personal"
        services={[connectedGithub]}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect GitHub" }));
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Disconnect",
      }),
    );

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      "/api/connections/egress/agents/personal/github/disconnect",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
  });

  it("does not disconnect when the confirmation is cancelled", async () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[connectedGithub]}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect GitHub" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says the API key is in use and keeps its controls visible", () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[
          withAccount(
            { connected: true, account_label: "octocat" },
            { configured: true, active_source: "key", key_configured: true },
          ),
        ]}
        onChanged={vi.fn()}
      />,
    );
    const github = row("GitHub");
    expect(within(github).getByText("Using API key")).toBeInTheDocument();
    expect(within(github).queryByText(/Connected as/)).toBeNull();
    expect(
      within(github).getByRole("button", { name: "Replace GitHub API key" }),
    ).toBeInTheDocument();
    expect(
      within(github).getByRole("button", { name: "Remove GitHub API key" }),
    ).toBeInTheDocument();
    expect(
      within(github).queryByRole("button", { name: "Use an API key instead" }),
    ).toBeNull();
  });

  it("offers only Reset connection while the saved connection needs a reset", () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[withAccount({ reset_required: true })]}
        onChanged={vi.fn()}
      />,
    );
    const github = row("GitHub");
    expect(within(github).getByText("Reset required")).toBeInTheDocument();
    expect(
      within(github).getByRole("button", { name: "Reset GitHub connection" }),
    ).toBeEnabled();
    // Connecting reads the unreadable connection first, so it cannot work until the reset.
    expect(
      within(github).queryByRole("button", { name: /Connect/ }),
    ).toBeNull();
  });

  it("lets a user without key rights disconnect their requester-scoped account", () => {
    render(
      <EgressServiceRows
        agentName="shared_dev"
        services={[
          withAccount(
            {
              connected: true,
              account_label: "octocat",
              shared_worker_opt_in: true,
            },
            {
              is_shared: true,
              can_manage: false,
              configured: true,
              active_source: "oauth",
            },
          ),
        ]}
        onChanged={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Disconnect GitHub" }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: /API key/ })).toBeNull();
  });

  it("explains that personal accounts are not used in a shared sandbox", () => {
    render(
      <EgressServiceRows
        agentName="shared_dev"
        services={[
          withAccount(
            { can_connect: false, unavailable_reason: "shared_sandbox" },
            { is_shared: true },
          ),
        ]}
        onChanged={vi.fn()}
      />,
    );
    const github = row("GitHub");
    expect(
      within(github).getByText(
        "Personal accounts are not used in a shared sandbox; add an API key or ask an administrator",
      ),
    ).toBeVisible();
    expect(
      within(github).queryByRole("button", { name: /Connect/ }),
    ).toBeNull();
    expect(
      within(github).getByRole("button", { name: "Use an API key instead" }),
    ).toBeEnabled();
  });

  it("warns that everyone using a shared agent can act with an opted-in account", () => {
    render(
      <EgressServiceRows
        agentName="shared_dev"
        services={[
          withAccount({ shared_worker_opt_in: true }, { is_shared: true }),
        ]}
        onChanged={vi.fn()}
      />,
    );
    const github = row("GitHub");
    expect(
      within(github).getByText(
        "Everyone using this agent can act with the connected account until its access expires",
      ),
    ).toBeVisible();
    expect(
      within(github).getByRole("button", { name: "Connect GitHub" }),
    ).toBeEnabled();
  });

  it("resets an unreadable connection after confirmation", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      json({ status: "disconnected", provider: "github" }),
    );
    const onChanged = vi.fn();
    render(
      <EgressServiceRows
        agentName="personal"
        services={[withAccount({ reset_required: true })]}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reset GitHub connection" }),
    );
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Reset connection",
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "/api/connections/egress/agents/personal/github/disconnect",
    );
  });

  it("stops waiting for authorization when Cancel is clicked", async () => {
    vi.mocked(fetch).mockImplementation(async () => json(authorization));
    const onChanged = vi.fn();
    render(
      <EgressServiceRows
        agentName="personal"
        services={[withAccount()]}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    await waitFor(() =>
      expect(popup.location.href).toBe(authorization.auth_url),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: "Connect GitHub" }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await waitFor(() => expect(popup.close).toHaveBeenCalled());
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("explains a shared service account and offers no connect action", () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[withAccount({ service_account: true, can_connect: false })]}
        onChanged={vi.fn()}
      />,
    );
    expect(
      within(row("GitHub")).getByText("Uses a shared service account"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
  });

  it("leaves services without an account provider as plain key rows", () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[github]}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
    expect(screen.queryByText("Use an API key instead")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Set GitHub API key" }),
    ).toBeInTheDocument();
  });
});

describe("egress service rows with service editing", () => {
  const mine: EgressCredentialService = {
    ...github,
    name: "mine",
    display_name: "Mine",
    source: "user",
  };
  const theirs: EgressCredentialService = {
    ...github,
    name: "theirs",
    display_name: "Theirs",
    source: "config",
  };
  const editing = (
    overrides: Partial<ServiceEditing> = {},
  ): ServiceEditing => ({
    editableSource: "user",
    onEdit: vi.fn(),
    onDelete: vi.fn(async () => undefined),
    deleteWarning: (service) => `Deleting ${service.name} cannot be undone.`,
    labels: { config: "Added by your administrator" },
    ...overrides,
  });

  it("offers Edit and Delete for the editable source and labels the rest", () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[mine, theirs]}
        onChanged={vi.fn()}
        serviceEditing={editing()}
      />,
    );
    expect(
      within(row("Mine")).getByRole("button", { name: "Edit Mine service" }),
    ).toBeInTheDocument();
    expect(
      within(row("Mine")).getByRole("button", { name: "Delete Mine service" }),
    ).toBeInTheDocument();
    expect(
      within(row("Mine")).queryByText("Added by your administrator"),
    ).toBeNull();
    expect(
      within(row("Theirs")).queryByRole("button", { name: /Edit|Delete/ }),
    ).toBeNull();
    expect(
      within(row("Theirs")).getByText("Added by your administrator"),
    ).toBeInTheDocument();
  });

  it("hides Edit and Delete from someone who cannot manage the service", () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[{ ...mine, can_manage: false }]}
        onChanged={vi.fn()}
        serviceEditing={editing()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Edit|Delete/ })).toBeNull();
  });

  it("offers nothing without service editing or without a known source", () => {
    const { rerender } = render(
      <EgressServiceRows
        agentName="personal"
        services={[mine]}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Edit|Delete/ })).toBeNull();
    rerender(
      <EgressServiceRows
        agentName="personal"
        services={[{ ...mine, source: undefined }]}
        onChanged={vi.fn()}
        serviceEditing={editing()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Edit|Delete/ })).toBeNull();
  });

  it("turns Edit and Delete off while something else is being written", () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[mine]}
        onChanged={vi.fn()}
        serviceEditing={editing({ disabled: true })}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Edit Mine service" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete Mine service" }),
    ).toBeDisabled();
    // The key controls are not part of a service write.
    expect(
      screen.getByRole("button", { name: "Set Mine API key" }),
    ).toBeEnabled();
  });

  it("hands the service to the Edit callback", () => {
    const serviceEditing = editing();
    render(
      <EgressServiceRows
        agentName="personal"
        services={[mine]}
        onChanged={vi.fn()}
        serviceEditing={serviceEditing}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit Mine service" }));
    expect(serviceEditing.onEdit).toHaveBeenCalledWith(mine);
  });

  it("deletes only after the warning is confirmed", async () => {
    const serviceEditing = editing();
    render(
      <EgressServiceRows
        agentName="personal"
        services={[mine]}
        onChanged={vi.fn()}
        serviceEditing={serviceEditing}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Mine service" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Deleting mine cannot be undone.");
    expect(serviceEditing.onDelete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(serviceEditing.onDelete).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Delete Mine service" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() =>
      expect(serviceEditing.onDelete).toHaveBeenCalledWith(mine),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows why a delete failed and keeps the row", async () => {
    const serviceEditing = editing({
      onDelete: vi.fn(async () => {
        throw new Error("Service is not a service of your own");
      }),
    });
    render(
      <EgressServiceRows
        agentName="personal"
        services={[mine]}
        onChanged={vi.fn()}
        serviceEditing={serviceEditing}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Mine service" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Service is not a service of your own",
    );
    expect(
      screen.getByRole("button", { name: "Delete Mine service" }),
    ).toBeEnabled();
  });
});

describe("rows with an agent's wording", () => {
  const agent = (overrides: Partial<RowAgent> = {}): RowAgent => ({
    displayName: "Personal Mind",
    managers: [],
    services: [],
    ...overrides,
  });
  const keyed = (
    overrides: Partial<EgressCredentialService> = {},
  ): EgressCredentialService => ({
    ...openai,
    updated_at: "2026-10-05T12:00:00+00:00",
    key_updated_at: "2026-10-05T12:00:00+00:00",
    ...overrides,
  });
  const renderRows = (
    services: EgressCredentialService[],
    rowAgent: RowAgent = agent({ services }),
    extra: { serviceEditing?: ServiceEditing } = {},
  ) =>
    render(
      <EgressServiceRows
        agentName="personal"
        services={services}
        onChanged={vi.fn()}
        agent={rowAgent}
        {...extra}
      />,
    );

  it("says Key saved with the date, and Set key, Replace key and Remove key on the buttons", () => {
    renderRows([github, keyed()]);
    const date = new Date("2026-10-05T12:00:00+00:00").toLocaleDateString();
    expect(
      within(row("OpenAI")).getByText(`Key saved ${date}`),
    ).toBeInTheDocument();
    expect(within(row("GitHub")).getByText("Not set")).toBeInTheDocument();
    expect(
      within(row("GitHub")).getByRole("button", { name: "Set GitHub API key" }),
    ).toHaveTextContent(/^Set key$/);
    expect(
      within(row("OpenAI")).getByRole("button", {
        name: "Replace OpenAI API key",
      }),
    ).toHaveTextContent(/^Replace key$/);
    expect(
      within(row("OpenAI")).getByRole("button", {
        name: "Remove OpenAI API key",
      }),
    ).toHaveTextContent(/^Remove key$/);
  });

  it("says Key saved without a date when the server sends none", () => {
    renderRows([keyed({ updated_at: null, key_updated_at: null })]);
    expect(within(row("OpenAI")).getByText("Key saved")).toBeInTheDocument();
  });

  it("keeps the dashboard's Updated and Set wording without an agent", () => {
    render(
      <EgressServiceRows
        agentName="personal"
        services={[keyed()]}
        onChanged={vi.fn()}
      />,
    );
    expect(
      within(row("OpenAI")).getByText(
        `Updated ${new Date("2026-10-05T12:00:00+00:00").toLocaleDateString()}`,
      ),
    ).toBeInTheDocument();
  });

  it("notes that a connected account is kept while an API key is in use", () => {
    renderRows([
      withAccount(
        { connected: true, account_label: "octocat" },
        { configured: true, active_source: "key", key_configured: true },
      ),
    ]);
    const github = row("GitHub");
    expect(within(github).getByText("Using API key")).toBeInTheDocument();
    expect(
      within(github).getByText(
        "Your connected GitHub account is kept for other services.",
      ),
    ).toBeVisible();
  });

  it("adds no kept-account note when no account is connected or the account is the one in use", () => {
    renderRows([
      withAccount(
        { connected: false },
        { configured: true, active_source: "key", key_configured: true },
      ),
    ]);
    expect(screen.queryByText(/is kept for other services/)).toBeNull();
    cleanup();
    renderRows([connectedGithub]);
    expect(screen.queryByText(/is kept for other services/)).toBeNull();
  });

  it("shows a shared account to everyone as connected and shared with everyone using the agent", () => {
    const shared = withAccount(
      { connected: true, account_label: "team@example.org" },
      {
        is_shared: true,
        can_manage: false,
        configured: true,
        active_source: "oauth",
      },
    );
    renderRows(
      [shared],
      agent({ displayName: "Shared Dev", services: [shared] }),
    );
    expect(
      within(row("GitHub")).getByText(
        "Connected as team@example.org · shared with everyone using Shared Dev",
      ),
    ).toBeVisible();
  });

  it("names a shared account without a label as Connected, shared with everyone", () => {
    const shared = withAccount(
      { connected: true, account_label: null },
      { is_shared: true, configured: true, active_source: "oauth" },
    );
    renderRows(
      [shared],
      agent({ displayName: "Shared Dev", services: [shared] }),
    );
    expect(
      within(row("GitHub")).getByText(
        "Connected · shared with everyone using Shared Dev",
      ),
    ).toBeVisible();
  });

  it("does not call a personal agent's account shared", () => {
    renderRows([connectedGithub]);
    expect(
      within(row("GitHub")).getByText("Connected as octocat"),
    ).toBeVisible();
    expect(screen.queryByText(/shared with everyone/)).toBeNull();
  });

  describe("Connect on a shared agent", () => {
    const sharedGoogle = withAccount(
      { provider: "google", display_name: "Google" },
      { is_shared: true, name: "gmail", display_name: "Gmail" },
    );
    beforeEach(() => {
      vi.spyOn(window, "open").mockReturnValue({
        closed: false,
        close: vi.fn(),
        location: { href: "about:blank" },
      } as unknown as Window);
      vi.mocked(fetch).mockImplementation(async () =>
        json({
          provider: "google",
          auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
          completion_origin: "https://portal.example.com",
        }),
      );
    });

    it("asks Connect a shared account? and only goes on after Continue", async () => {
      renderRows(
        [sharedGoogle],
        agent({ displayName: "Shared Dev", services: [sharedGoogle] }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Connect Google" }));

      const dialog = await screen.findByRole("dialog", {
        name: "Connect a shared account?",
      });
      expect(
        within(dialog).getByText(
          "Everyone who uses Shared Dev will act as the Google account you pick. Use a team account, not your personal one.",
        ),
      ).toBeVisible();
      expect(fetch).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
      await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(
          "/api/connections/egress/agents/personal/gmail/connect",
          expect.objectContaining({ method: "POST" }),
        ),
      );
      expect(
        screen.queryByRole("dialog", { name: "Connect a shared account?" }),
      ).toBeNull();
    });

    it("sends nothing when the question is cancelled", async () => {
      renderRows(
        [sharedGoogle],
        agent({ displayName: "Shared Dev", services: [sharedGoogle] }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Connect Google" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(fetch).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();
    });

    it("does not ask on a personal agent", async () => {
      const personal = { ...sharedGoogle, is_shared: false };
      renderRows([personal], agent({ services: [personal] }));
      fireEvent.click(screen.getByRole("button", { name: "Connect Google" }));
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("does not ask without an agent, as on the dashboard", async () => {
      render(
        <EgressServiceRows
          agentName="personal"
          services={[sharedGoogle]}
          onChanged={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Connect Google" }));
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  describe("a personal account the shared agent refuses", () => {
    const refused = withAccount(
      { can_connect: false, unavailable_reason: "shared_sandbox" },
      { is_shared: true, can_manage: false },
    );

    it("tells a non-manager whom to ask", () => {
      renderRows(
        [refused],
        agent({
          managers: ["@bob:example.org", "@carol:example.org"],
          services: [refused],
        }),
      );
      expect(
        within(row("GitHub")).getByText(
          "Personal GitHub accounts can't be used by shared agents. Ask @bob:example.org and @carol:example.org to add a team API key.",
        ),
      ).toBeVisible();
    });

    it("tells a non-manager to ask an administrator when there are no managers", () => {
      renderRows([refused], agent({ managers: [], services: [refused] }));
      expect(
        within(row("GitHub")).getByText(
          /Ask an administrator to add a team API key\.$/,
        ),
      ).toBeVisible();
    });

    it("tells a manager to add a team key", () => {
      const asManager = { ...refused, can_manage: true };
      renderRows(
        [asManager],
        agent({ managers: ["@bob:example.org"], services: [asManager] }),
      );
      expect(
        within(row("GitHub")).getByText(
          "Personal GitHub accounts can't be used by shared agents. Add a team API key instead.",
        ),
      ).toBeVisible();
    });
  });

  describe("who manages a shared agent", () => {
    const readOnly = { ...openai, is_shared: true, can_manage: false };

    it("leaves naming the managers to the agent's note when they are known", () => {
      renderRows(
        [readOnly],
        agent({ managers: ["@bob:example.org"], services: [readOnly] }),
      );
      expect(screen.queryByText(/Managed by credential managers/)).toBeNull();
      expect(screen.queryByRole("button", { name: /API key/ })).toBeNull();
    });

    it("still says it where the managers are not known", () => {
      renderRows(
        [readOnly],
        agent({ managers: undefined, services: [readOnly] }),
      );
      expect(screen.getByText("Managed by credential managers")).toBeVisible();
    });

    it("does not repeat it beside a refused personal account that says whom to ask", () => {
      const refused = withAccount(
        { can_connect: false, unavailable_reason: "shared_sandbox" },
        { is_shared: true, can_manage: false },
      );
      renderRows(
        [refused],
        agent({ managers: undefined, services: [refused] }),
      );
      expect(
        within(row("GitHub")).getByText(
          /Ask its credential managers to add a team API key\.$/,
        ),
      ).toBeVisible();
      expect(screen.queryByText("Managed by credential managers")).toBeNull();
    });
  });

  describe("disconnecting an account", () => {
    const listing = [
      connectedGithub,
      {
        ...connectedGithub,
        name: "github-limited",
        display_name: "GitHub (a/b)",
        source: "user" as const,
      },
      openai,
      withAccount(
        { provider: "google", display_name: "Google", connected: true },
        { name: "gmail", display_name: "Gmail" },
      ),
    ];

    it("lists every service of the agent that uses the provider", async () => {
      vi.mocked(fetch).mockImplementation(async () =>
        json({ status: "disconnected", provider: "github" }),
      );
      const onChanged = vi.fn();
      render(
        <EgressServiceRows
          agentName="personal"
          services={listing}
          onChanged={onChanged}
          agent={agent({ services: listing })}
        />,
      );
      fireEvent.click(
        within(row("GitHub")).getByRole("button", {
          name: "Disconnect GitHub",
        }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: "Disconnect GitHub?",
      });
      expect(
        within(dialog).getByText(
          "This removes the saved GitHub connection for Personal Mind. These services stop working until an account is connected again: GitHub and GitHub (a/b).",
        ),
      ).toBeVisible();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Disconnect" }),
      );
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    });

    it("keeps the dashboard's wording without an agent", async () => {
      render(
        <EgressServiceRows
          agentName="personal"
          services={[connectedGithub]}
          onChanged={vi.fn()}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Disconnect GitHub" }),
      );
      expect(
        await screen.findByText(
          "This removes the saved GitHub connection. Agents lose access through it until an account is connected again.",
        ),
      ).toBeVisible();
    });
  });

  describe("limiting a GitHub service to repositories", () => {
    const base = (overrides: Partial<EgressCredentialService> = {}) => ({
      ...github,
      source: "config" as const,
      rules: [
        { host: "api.github.com", port: null, path_prefix: "/" },
        { host: "github.com", port: null, path_prefix: "/" },
      ],
      ...overrides,
    });
    const limiting = (
      overrides: Partial<ServiceEditing> = {},
    ): ServiceEditing => ({
      editableSource: "user",
      onEdit: vi.fn(),
      onDelete: vi.fn(async () => undefined),
      deleteWarning: () => "",
      onLimitToRepositories: vi.fn(),
      ...overrides,
    });

    it("offers it on an administrator's GitHub row to someone who can manage the agent", () => {
      const onLimitToRepositories = vi.fn();
      const service = base();
      renderRows([service], undefined, {
        serviceEditing: limiting({ onLimitToRepositories }),
      });
      const button = within(row("GitHub")).getByRole("button", {
        name: "Limit GitHub to repositories",
      });
      expect(button).toHaveTextContent("Limit to repositories");
      fireEvent.click(button);
      expect(onLimitToRepositories).toHaveBeenCalledWith(service);
    });

    it.each([
      ["the viewer cannot manage the agent", base({ can_manage: false })],
      ["the service is the viewer's own", base({ source: "user" })],
      [
        "it has no rule on a GitHub host",
        base({
          rules: [{ host: "httpbin.org", port: null, path_prefix: "/" }],
        }),
      ],
      ["the response lists no rules", base({ rules: undefined })],
    ])("does not offer it when %s", (_why, service) => {
      renderRows([service], undefined, { serviceEditing: limiting() });
      expect(screen.queryByText("Limit to repositories")).toBeNull();
    });

    it("does not offer it without a handler, as on the dashboard", () => {
      renderRows([base()], undefined, {
        serviceEditing: limiting({ onLimitToRepositories: undefined }),
      });
      expect(screen.queryByText("Limit to repositories")).toBeNull();
    });

    it("turns it off while the editor is open or something is being written", () => {
      renderRows([base()], undefined, {
        serviceEditing: limiting({ limitDisabled: true }),
      });
      expect(
        screen.getByRole("button", { name: "Limit GitHub to repositories" }),
      ).toBeDisabled();
      cleanup();
      renderRows([base()], undefined, {
        serviceEditing: limiting({ disabled: true }),
      });
      expect(
        screen.getByRole("button", { name: "Limit GitHub to repositories" }),
      ).toBeDisabled();
    });

    it("shows which repositories a limited service is limited to", () => {
      const rules = githubRepositoryRules("a/b\nc/*", {
        uploads: false,
        graphql: false,
      }).rules.map((rule) => ({
        host: rule.host,
        port: null,
        path_prefix: rule.path_prefix ?? "/",
      }));
      renderRows([base({ source: "user", display_name: "Mine", rules })]);
      expect(
        within(row("Mine")).getByText("Limited to a/b, c/*"),
      ).toBeVisible();
    });

    it("shows nothing for a service that reaches all of GitHub", () => {
      renderRows([base()]);
      expect(screen.queryByText(/Limited to/)).toBeNull();
    });

    it("does not repeat a description that already says it", () => {
      const rules = githubRepositoryRules("a/b", {
        uploads: false,
        graphql: false,
      }).rules.map((rule) => ({
        host: rule.host,
        port: null,
        path_prefix: rule.path_prefix ?? "/",
      }));
      renderRows([
        base({
          source: "user",
          display_name: "Mine",
          description: "Limited to a/b",
          rules,
        }),
      ]);
      expect(screen.getAllByText("Limited to a/b")).toHaveLength(1);
    });
  });

  it("shows no administrator badge when no label is given", () => {
    renderRows([{ ...github, source: "config" }], undefined, {
      serviceEditing: {
        editableSource: "user",
        onEdit: vi.fn(),
        onDelete: vi.fn(async () => undefined),
        deleteWarning: () => "",
      },
    });
    expect(screen.queryByText(/administrator/)).toBeNull();
  });
});
