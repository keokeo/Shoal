const MAX_TITLE = 24;

// Pasted-image placeholders and absolute file paths say nothing about the task.
const NOISE = /\[Image #\d+\]|"(?:[A-Za-z]:[\\/]|\/)[^"]*"|(?<=^|\s)(?:[A-Za-z]:[\\/]|\/(?=[^\s/]+\/))\S*/g;

// First line with real words (noise removed, whitespace collapsed), cut to 24 code points (+ '…'). '' if nothing usable.
export function titleFromPrompt(text: string): string {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const s = line.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
    if (!s) continue;
    const cps = [...s];
    return cps.length > MAX_TITLE ? cps.slice(0, MAX_TITLE).join('') + '…' : s;
  }
  return '';
}

// A title saved before the noise filter existed, cleaned the same way; unchanged if cleaning leaves nothing.
// A placeholder cut off by the 24-character limit ("[Ima…") goes too.
export function cleanTitle(title: string): string {
  const s = title.replace(NOISE, ' ').replace(/\[[^\]]*…$/, '').replace(/\s+/g, ' ').trim();
  return s && s !== '…' ? s : title;
}
