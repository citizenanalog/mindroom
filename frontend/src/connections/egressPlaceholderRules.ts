/**
 * What a placeholder name and value must look like, and the texts that say
 * why not. The server decides; these checks give the same answer, with the
 * same words, while the form is being filled in.
 */

export const PLACEHOLDER_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
// The names the broker sets itself, which no service may use as a placeholder
// (the lowercase proxy variables cannot match the name pattern anyway).
const RESERVED_PLACEHOLDER_NAMES = new Set([
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
]);
const RESERVED_PLACEHOLDER_PREFIXES = ["MINDROOM_", "GIT_CONFIG_"];
// Services of a personal scope may only set credential-like placeholders with
// plain values. These mirror `_placeholder_error` in
// src/mindroom/egress_broker/user_services.py, with its words in its order.
const PERSONAL_PLACEHOLDER_NAME = /^[A-Z][A-Z0-9_]*$/;
const PERSONAL_PLACEHOLDER_VALUE = /^[A-Za-z0-9._:-]{1,256}$/;
const PERSONAL_PLACEHOLDER_WORDS = [
  "TOKEN",
  "KEY",
  "SECRET",
  "PASSWORD",
  "PAT",
  "AUTH",
  "CREDENTIAL",
];
// Tools read variables with these words, or starting with SSH_, as programs or
// paths to run or load, so a service of one's own cannot set them.
const PERSONAL_PLACEHOLDER_REFUSED_WORDS = [
  "COMMAND",
  "CMD",
  "FILE",
  "DIR",
  "PROVIDER",
  "HELPER",
  "OPTS",
  "OPTIONS",
  "EXTENSIONS",
];
const PERSONAL_PLACEHOLDER_REFUSED_PREFIX = "SSH_";

/** Why no service may use this valid placeholder name, or null; the server refuses these in every scope. */
export function reservedPlaceholderError(name: string): string | null {
  if (RESERVED_PLACEHOLDER_NAMES.has(name))
    return `Placeholder name ${name} is reserved`;
  const prefix = RESERVED_PLACEHOLDER_PREFIXES.find((reserved) =>
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

export function personalPlaceholderNameError(name: string): string {
  return `${name} is not allowed as a placeholder: name a credential, such as MY_API_KEY, with ${wordList(PERSONAL_PLACEHOLDER_WORDS)} as one of its words.`;
}

/** The texts mirror the server's, which never quotes a value. */
export function personalPlaceholderError(
  name: string,
  value: string,
): { part: "name" | "value"; message: string } | null {
  const words = name.split("_");
  if (
    !PERSONAL_PLACEHOLDER_NAME.test(name) ||
    !PERSONAL_PLACEHOLDER_WORDS.some((word) => words.includes(word))
  )
    return { part: "name", message: personalPlaceholderNameError(name) };
  if (
    name.startsWith(PERSONAL_PLACEHOLDER_REFUSED_PREFIX) ||
    PERSONAL_PLACEHOLDER_REFUSED_WORDS.some((word) => words.includes(word))
  )
    return {
      part: "name",
      message: `${name} is not allowed: tools read names with ${wordList(PERSONAL_PLACEHOLDER_REFUSED_WORDS)}, or starting with ${PERSONAL_PLACEHOLDER_REFUSED_PREFIX}, as programs or paths.`,
    };
  if (!PERSONAL_PLACEHOLDER_VALUE.test(value))
    return {
      part: "value",
      message: `The value of ${name} must be 1 to 256 letters, digits, or . _ : -`,
    };
  return null;
}
