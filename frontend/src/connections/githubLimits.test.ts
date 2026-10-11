import { describe, expect, it } from "vitest";
import { githubRepositoryRules } from "./egressServiceModel";
import { coversGithub, limitedRepositories } from "./githubLimits";
import type { EgressRuleSummary } from "./types";

const rule = (host: string, path_prefix = "/"): EgressRuleSummary => ({
  host,
  port: null,
  path_prefix,
});
const summarized = (input: string, uploads = false, graphql = false) =>
  githubRepositoryRules(input, { uploads, graphql }).rules.map((item) =>
    rule(item.host, item.path_prefix),
  );

describe("GitHub coverage", () => {
  it("sees the API, web, and upload hosts, in any case", () => {
    expect(coversGithub([rule("api.github.com")])).toBe(true);
    expect(coversGithub([rule("GitHub.com")])).toBe(true);
    expect(coversGithub([rule("uploads.github.com")])).toBe(true);
    expect(
      coversGithub([rule("httpbin.org"), rule("github.example.com")]),
    ).toBe(false);
    expect(coversGithub([])).toBe(false);
    expect(coversGithub(undefined)).toBe(false);
  });
});

describe("repositories a service is limited to", () => {
  it("reads back what the editor's helper writes", () => {
    expect(limitedRepositories(summarized("basnijholt/agent-cli"))).toEqual([
      "basnijholt/agent-cli",
    ]);
    expect(limitedRepositories(summarized("a/b\nc/d", true))).toEqual([
      "a/b",
      "c/d",
    ]);
    expect(limitedRepositories(summarized("octo/*\na/b", true))).toEqual([
      "octo/*",
      "a/b",
    ]);
  });

  it("does not call a service limited while it reaches more", () => {
    expect(
      limitedRepositories([rule("api.github.com"), rule("github.com")]),
    ).toEqual([]);
    expect(limitedRepositories(summarized("a/b", false, true))).toEqual([]);
    expect(
      limitedRepositories([...summarized("a/b"), rule("api.github.com", "/")]),
    ).toEqual([]);
  });

  it("ignores rules on other hosts and reads none from a service without GitHub rules", () => {
    expect(
      limitedRepositories([...summarized("a/b"), rule("httpbin.org")]),
    ).toEqual(["a/b"]);
    expect(limitedRepositories([rule("httpbin.org", "/repos/a/b")])).toEqual(
      [],
    );
    expect(limitedRepositories(undefined)).toEqual([]);
  });

  it("takes a path of the wrong shape for the host as no repository", () => {
    expect(limitedRepositories([rule("api.github.com", "/a/b")])).toEqual([]);
    expect(limitedRepositories([rule("github.com", "/repos/a/b")])).toEqual([]);
    expect(limitedRepositories([rule("github.com", "/a/b/")])).toEqual([]);
  });
});
