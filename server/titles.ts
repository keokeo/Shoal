const MAX_TITLE = 24;

// First non-empty line of a prompt, whitespace collapsed, cut to 24 code points (+ '…'). '' if nothing usable.
export function titleFromPrompt(text: string): string {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const s = line.replace(/\s+/g, ' ').trim();
    if (!s) continue;
    const cps = [...s];
    return cps.length > MAX_TITLE ? cps.slice(0, MAX_TITLE).join('') + '…' : s;
  }
  return '';
}
