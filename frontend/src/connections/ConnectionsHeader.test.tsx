import { cleanup, render, screen } from "@testing-library/react";
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
