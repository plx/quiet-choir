// Quote matching: code decides whether an agent's PRD quote is in the PRD. The lens items and the
// repair patch are checked with it; a merged ticket carries its source items' checked anchors.

/** Lower-cased text without quotes, emphasis marks or repeated whitespace, for quote matching. */
export const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/[‐-―]/gu, '-')
    .replace(/["'`*_#>‘’“”]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();

/** A quote is anchored when every part between ellipses occurs in the PRD. */
export function anchored(prd: string, quote: string): boolean {
  const text = plain(prd);
  const parts = quote
    .split(/\.\.\.|…/u)
    .map(plain)
    .filter(Boolean);
  return parts.length > 0 && parts.every((part) => text.includes(part));
}
