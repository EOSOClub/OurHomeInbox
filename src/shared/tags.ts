// Tags: the household's own labels for its emails, such as "Utilities" or
// "Taxes 2026". Shared by the server (which stores and checks them) and the
// web app (which runs the same checks while someone types).
//
// Two tags cannot have the same name in one household, ignoring upper and
// lower case ("utilities" is "Utilities").

export const MAX_TAG_NAME = 40;
/** The most tags one household can have. */
export const MAX_TAGS = 200;
/** The most emails one change can tag or untag. */
export const MAX_TAGGED_AT_ONCE = 500;

/** A name as stored: trimmed, with runs of spaces (and tabs or line breaks) made one space. */
export function normalizeTagName(input: string): string {
  return input.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** What makes two names the same tag: the normalized name in lower case. */
export function tagKey(name: string): string {
  return normalizeTagName(name).toLowerCase();
}

/** What is wrong with a normalized name, in plain words, or null when it is fine. */
export function tagNameProblem(name: string): string | null {
  if (name === "") return "Enter a name for the tag.";
  if ([...name].length > MAX_TAG_NAME) return `Keep tag names under ${MAX_TAG_NAME} characters.`;
  // Control and format characters, except the joiner that builds emoji like a family.
  if (/(?!‍)[\p{Cc}\p{Cf}]/u.test(name)) return "Tag names cannot hold hidden characters. Type the name again.";
  return null;
}
