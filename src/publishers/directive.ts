// Text appended to every agent's system prompt when a session is public.

export function publicSessionDirective(): string {
  return [
    "PUBLIC SESSION NOTICE",
    "Everything written in this session is copied word for word to a world-readable channel that anyone with the link can open.",
    "- Work at the level of ideas. Cite only public URLs and public sources.",
    "- Never reproduce private context, private data, source code, internal project or company names, credentials, keys, file paths, or any personal information about any real person.",
    "- If something you were given looks private, leave it out or describe it in general terms.",
    "- Write for the discussion itself. There is no audience: do not address readers, do not play to a crowd, and do not mention that the session is public or being recorded. Simply do the work the way you would in a private session.",
  ].join("\n");
}
