/**
 * Catch API keys mangled by pasting (e.g. bracketed-paste markers like ESC[200~) or with
 * stray whitespace. The SDK otherwise reports these as a confusing "Connection error".
 * Returns a message to show the user, or null if the key looks fine (or is unset, in which
 * case the SDK may still find other credentials). Never includes the key itself.
 */
export function checkApiKey(key: string | undefined): string | null {
  if (key === undefined || key === "") return null;
  if (/[^\x21-\x7e]/.test(key)) {
    return (
      "Your ANTHROPIC_API_KEY contains hidden characters or spaces (often added when pasting). " +
      'Set it again: read -rs "ANTHROPIC_API_KEY?Key: " && export ANTHROPIC_API_KEY'
    );
  }
  if (!key.startsWith("sk-ant-")) {
    return "Your ANTHROPIC_API_KEY doesn't look like an Anthropic key (it should start with sk-ant-).";
  }
  return null;
}
