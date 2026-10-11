import type { EgressPlaceholderLimits } from "./types";

/**
 * What a placeholder name and value must look like, and the texts that say
 * why not. The server decides: its words, reserved names, and name and value
 * patterns arrive in `limits.placeholder`, so these checks give the same
 * answer, with the same words, while the form is being filled in.
 */

// Every service's variable names, as the config model checks them.
export const PLACEHOLDER_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** What the dashboard says about a name outside `PLACEHOLDER_NAME_PATTERN`, quoting the pattern as the server does. */
export function operatorPlaceholderNameError(name: string): string {
  return `Placeholder name ${name} must match ^[A-Z_][A-Z0-9_]*$`;
}

/** Why no service may use this valid placeholder name, or null; the server refuses these in every scope. */
export function reservedPlaceholderError(
  name: string,
  limits: EgressPlaceholderLimits,
): string | null {
  if (limits.reserved_names.includes(name))
    return `Placeholder name ${name} is reserved`;
  const prefix = limits.reserved_prefixes.find((reserved) =>
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

export function personalPlaceholderNameError(
  name: string,
  limits: EgressPlaceholderLimits,
): string {
  return `${name} is not allowed as a placeholder: name a credential, such as MY_API_KEY, with ${wordList(limits.credential_words)} as one of its words.`;
}

/** A server pattern, which Python matches against the whole name or value, as a regular expression that does too. */
function wholeMatchPattern(source: string): RegExp | null {
  try {
    return new RegExp(`^(?:${source})$`);
  } catch {
    // A pattern this browser cannot read is left to the server.
    return null;
  }
}

/**
 * Why a personal service may not set this placeholder, as the part of the row
 * that is wrong and the message; null when it may. A personal service may only
 * set credential-like names, with plain values. The texts mirror the server's,
 * which never quotes a value.
 */
export function personalPlaceholderError(
  name: string,
  value: string,
  limits: EgressPlaceholderLimits,
): { part: "name" | "value"; message: string } | null {
  const words = name.split("_");
  const namePattern = wholeMatchPattern(limits.name_pattern);
  if (
    (namePattern !== null && !namePattern.test(name)) ||
    !limits.credential_words.some((word) => words.includes(word))
  )
    return {
      part: "name",
      message: personalPlaceholderNameError(name, limits),
    };
  // Tools read variables with these words, or starting with the prefix, as
  // programs or paths to run or load, so a service of one's own cannot set them.
  if (
    name.startsWith(limits.refused_prefix) ||
    limits.refused_words.some((word) => words.includes(word))
  )
    return {
      part: "name",
      message: `${name} is not allowed: tools read names with ${wordList(limits.refused_words)}, or starting with ${limits.refused_prefix}, as programs or paths.`,
    };
  const valuePattern = wholeMatchPattern(limits.value_pattern);
  if (valuePattern !== null && !valuePattern.test(value))
    return {
      part: "value",
      message: `The value of ${name} must be 1 to 256 letters, digits, or . _ : -`,
    };
  return null;
}
