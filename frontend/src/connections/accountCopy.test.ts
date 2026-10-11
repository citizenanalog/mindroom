import { describe, expect, it } from "vitest";
import {
  PASS_THROUGH_CAPTION,
  deleteServiceWarning,
  disconnectDescription,
  formatList,
  personalAccountRefusal,
  personalSandboxRefusal,
  sharedAccountBody,
  sharedAccountStatus,
  sharedAgentNote,
} from "./accountCopy";

describe("account copy", () => {
  it("lists one, two, and three names", () => {
    expect(formatList(["@bob:x"])).toBe("@bob:x");
    expect(formatList(["@bob:x", "@carol:x"])).toBe("@bob:x and @carol:x");
    expect(formatList(["a", "b", "c"])).toBe("a, b, and c");
  });

  it("asks about a shared account in the spec's words", () => {
    expect(sharedAccountBody("Shared Dev", "Google")).toBe(
      "Everyone who uses Shared Dev will act as the Google account you pick. Use a team account, not your personal one.",
    );
  });

  it("says who a connected account is shared with", () => {
    expect(sharedAccountStatus("team@example.org", "Shared Dev")).toBe(
      "Connected as team@example.org · shared with everyone using Shared Dev",
    );
    expect(sharedAccountStatus(null, "Shared Dev")).toBe(
      "Connected · shared with everyone using Shared Dev",
    );
  });

  it("describes a disconnect with the services that stop working", () => {
    expect(
      disconnectDescription("GitHub", "Personal Mind", [
        "GitHub",
        "GitHub (a/b)",
      ]),
    ).toBe(
      "This removes the saved GitHub connection for Personal Mind. These services stop working until an account is connected again: GitHub and GitHub (a/b).",
    );
    expect(disconnectDescription("GitHub", "Personal Mind", [])).toBe(
      "This removes the saved GitHub connection for Personal Mind.",
    );
  });

  it("tells managers and others who can change the keys of a shared agent", () => {
    expect(sharedAgentNote(true, ["@bob:x"])).toBe(
      "You manage this shared agent's keys. Everyone who uses it shares them.",
    );
    expect(sharedAgentNote(false, ["@bob:x", "@carol:x"])).toBe(
      "Only @bob:x and @carol:x can change keys for this shared agent.",
    );
    expect(sharedAgentNote(false, [])).toBe(
      "Only administrators can change keys for this shared agent.",
    );
  });

  it("gives managers and others different advice for a refused personal account", () => {
    expect(personalAccountRefusal("GitHub", true, ["@bob:x"])).toBe(
      "Personal GitHub accounts can't be used by shared agents. Add a team API key instead.",
    );
    expect(personalAccountRefusal("GitHub", false, ["@bob:x"])).toBe(
      "Personal GitHub accounts can't be used by shared agents. Ask @bob:x to add a team API key.",
    );
    expect(personalAccountRefusal("GitHub", false, [])).toBe(
      "Personal GitHub accounts can't be used by shared agents. Ask an administrator to add a team API key.",
    );
    expect(personalAccountRefusal("GitHub", false, undefined)).toBe(
      "Personal GitHub accounts can't be used by shared agents. Ask its credential managers to add a team API key.",
    );
  });

  it("tells a personal agent's user the sandbox is shared, not the agent", () => {
    expect(personalSandboxRefusal("GitHub")).toBe(
      "Personal GitHub accounts can't be used in this sandbox, which other users' commands share. Add an API key instead.",
    );
  });

  it("says who loses access when a service is deleted, by scope", () => {
    expect(deleteServiceWarning("user_agent", "Coder", [])).toBe(
      "This deletes the service and its saved key. Your Coder loses access through it.",
    );
    expect(
      deleteServiceWarning("user", "Coder", ["Coder", "Writer", "Scripter"]),
    ).toBe(
      "This deletes the service and its saved key. All your agents that share your personal workspace lose access through it: Coder, Writer, Scripter.",
    );
    expect(deleteServiceWarning("user", "Coder", [])).toBe(
      "This deletes the service and its saved key. All your agents that share your personal workspace lose access through it: Coder.",
    );
    expect(deleteServiceWarning("shared", "Team Bot", [])).toBe(
      "This deletes the service and its shared key. Everyone using Team Bot loses access through it.",
    );
    expect(deleteServiceWarning("unscoped", "Team Bot", [])).toBe(
      "This deletes the service and its shared key. Every agent without a scope loses access through it.",
    );
  });

  it("tells the viewer that administrators can see the requests too", () => {
    expect(PASS_THROUGH_CAPTION).toBe(
      "Requests to sites without a service pass straight through; MindRoom sees only the host. Administrators can also see these requests (method, host, and path).",
    );
  });
});
