import { useId, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  BROKERED_PLACEHOLDER,
  type EgressServiceForm,
  type PlaceholderForm,
  githubLimitLabels,
  githubRepositoryRules,
  ruleFormFrom,
} from "./egressServiceModel";
import type { EgressRule } from "./types";

const GITHUB_PLACEHOLDER_NAMES = ["GH_TOKEN", "GITHUB_TOKEN"];
const brokered = (name: string): PlaceholderForm => ({
  name,
  value: BROKERED_PLACEHOLDER,
});

/** The labels the helper last wrote, which it may rewrite on the next apply. */
export interface HelperLabels {
  displayName: string;
  description: string;
}

/**
 * What applying the helper changes in the form, and the labels it wrote.
 *
 * It replaces the rules and turns on the restriction. A custom service also
 * gets the placeholders the GitHub preset would set, unless it already sets
 * some. Labels the user wrote stay; the ones the last apply wrote follow the
 * new repositories. The name is kept as it is, so the new first rule's host
 * does not rename the service.
 */
export function githubHelperChanges(
  form: EgressServiceForm,
  result: { rules: EgressRule[]; repositories: string[] },
  written: HelperLabels,
): { changes: Partial<EgressServiceForm>; written: HelperLabels } {
  const labels = githubLimitLabels(result.repositories);
  const fillDisplayName =
    form.displayName.trim() === "" || form.displayName === written.displayName;
  const fillDescription =
    form.description.trim() === "" || form.description === written.description;
  const addPlaceholders = form.preset === "" && form.placeholders.length === 0;
  return {
    changes: {
      name: form.name,
      rules: result.rules.map(ruleFormFrom),
      replacePresetRules: form.preset !== "",
      restrictToRules: true,
      ...(fillDisplayName ? { displayName: labels.displayName } : {}),
      ...(fillDescription ? { description: labels.description } : {}),
      ...(addPlaceholders
        ? { placeholders: GITHUB_PLACEHOLDER_NAMES.map(brokered) }
        : {}),
    },
    written: {
      displayName: fillDisplayName ? labels.displayName : written.displayName,
      description: fillDescription ? labels.description : written.description,
    },
  };
}

export function GithubHelper({
  onApply,
}: {
  onApply: (result: { rules: EgressRule[]; repositories: string[] }) => void;
}) {
  const id = useId();
  const [repositories, setRepositories] = useState("");
  const [uploads, setUploads] = useState(false);
  const [graphql, setGraphql] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const apply = () => {
    const result = githubRepositoryRules(repositories, { uploads, graphql });
    setErrors(result.errors);
    if (result.errors.length === 0) onApply(result);
  };

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3"
    >
      <div className="space-y-1">
        <h4 id={`${id}-heading`} className="text-sm font-medium">
          Limit to repositories
        </h4>
        <p className="text-xs text-muted-foreground">
          One repository per line, as owner/repo, or owner/* for everything an
          owner has. Applying replaces this service's rules with rules for just
          those repositories (API and git over HTTPS) and refuses every other
          path on GitHub. Other API paths, such as /user or search, stop
          working. Matching is case sensitive, so write names as they appear in
          GitHub URLs.
        </p>
      </div>
      <Textarea
        aria-label="GitHub repositories"
        placeholder={"basnijholt/agent-cli\nmindroom-ai/*"}
        rows={3}
        className="font-mono text-xs"
        value={repositories}
        onChange={(event) => setRepositories(event.target.value)}
      />
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={uploads}
          onChange={(event) => setUploads(event.target.checked)}
        />
        <span>
          Also allow uploads.github.com for these repositories (release assets)
        </span>
      </label>
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={graphql}
          onChange={(event) => setGraphql(event.target.checked)}
        />
        <span>
          Also allow GraphQL (/graphql). GraphQL reaches every repository the
          key can reach, not just the ones listed.
        </span>
      </label>
      {errors.length > 0 && (
        <Alert variant="destructive" className="p-2">
          <AlertDescription>
            <ul className="list-disc pl-4">
              {errors.map((error, index) => (
                <li key={`${index}-${error}`}>{error}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <Button type="button" size="sm" variant="outline" onClick={apply}>
        Use these repositories
      </Button>
    </section>
  );
}
