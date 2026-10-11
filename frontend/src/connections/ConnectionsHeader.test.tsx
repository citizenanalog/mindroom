import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsHeader } from "./ConnectionsHeader";
import type { ConnectionsIdentity } from "./types";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const identity = (
  overrides: Partial<ConnectionsIdentity> = {},
): ConnectionsIdentity => ({
  matrix_user_id: "@bob:example.org",
  email: "bob@example.org",
  is_administrator: false,
  ...overrides,
});

function answerWith(response: () => Promise<Response>) {
  vi.mocked(fetch).mockImplementation(async (input) => {
    if (String(input) === "/api/connections/me") return response();
    throw new Error(`Unexpected request: ${String(input)}`);
  });
}

const renderHeader = (current: "agents" | "keys" = "agents") =>
  render(
    <ConnectionsHeader current={current} title="Your title">
      The intro.
    </ConnectionsHeader>,
  );

beforeEach(() => answerWith(async () => json(identity())));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("connections header", () => {
  it("shows who is signed in and links the two pages", async () => {
    renderHeader();
    expect(
      await screen.findByText("Signed in as @bob:example.org"),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your title" })).toBeVisible();
    expect(screen.getByText("The intro.")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Connections pages" });
    expect(
      Array.from(nav.querySelectorAll("a")).map((link) => [
        link.textContent,
        link.getAttribute("href"),
      ]),
    ).toEqual([
      ["Agents", "/connections"],
      ["API keys and accounts", "/connections/egress"],
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/connections/me",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("marks the page that is open", () => {
    renderHeader("keys");
    expect(
      screen.getByRole("link", { name: "API keys and accounts" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Agents" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("offers the dashboard to administrators only", async () => {
    renderHeader();
    await screen.findByText("Signed in as @bob:example.org");
    expect(screen.queryByRole("link", { name: "Dashboard" })).toBeNull();
    cleanup();

    answerWith(async () =>
      json(
        identity({
          matrix_user_id: "@alice:example.org",
          is_administrator: true,
        }),
      ),
    );
    renderHeader();
    expect(
      await screen.findByText("Signed in as @alice:example.org"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("keeps the links when the identity cannot be loaded", async () => {
    answerWith(async () => json({}, 500));
    renderHeader();
    expect(await screen.findByRole("link", { name: "Agents" })).toBeVisible();
    expect(
      screen.getByRole("link", { name: "API keys and accounts" }),
    ).toBeVisible();
    expect(screen.queryByText(/Signed in as/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the notice after a redirect from the dashboard", () => {
  const NOTICE =
    "The dashboard is for administrators. Manage your agents' keys and accounts here.";
  afterEach(() => window.history.replaceState({}, "", "/"));

  it("tells someone sent here from the dashboard that it is for administrators", () => {
    window.history.replaceState({}, "", "/connections?notice=admin-only");
    renderHeader();
    expect(screen.getByRole("alert")).toHaveTextContent(NOTICE);
  });

  it("shows nothing without the notice, or for one it does not know", () => {
    renderHeader();
    expect(screen.queryByText(NOTICE)).toBeNull();
    cleanup();
    window.history.replaceState({}, "", "/connections?notice=something-else");
    renderHeader();
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();
    window.history.replaceState({}, "", "/connections?notice=");
    renderHeader();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the explanation behind How this works", () => {
  it("is hidden until the disclosure is opened, and offered only when there is one", () => {
    render(
      <ConnectionsHeader
        current="keys"
        title="Your title"
        howItWorks="The long explanation."
      >
        The intro.
      </ConnectionsHeader>,
    );
    const toggle = screen.getByRole("button", { name: "How this works" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("The long explanation.")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("The long explanation.")).toBeVisible();
    cleanup();
    renderHeader();
    expect(screen.queryByRole("button", { name: "How this works" })).toBeNull();
  });
});
