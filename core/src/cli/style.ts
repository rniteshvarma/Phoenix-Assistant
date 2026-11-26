/** Terminal colours in the "Ember" palette (24-bit ANSI). Respects NO_COLOR and non-TTY output. */
const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

const rgb = (r: number, g: number, b: number) => (s: string) =>
  enabled ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : s;
const sgr = (on: number, off: number) => (s: string) => (enabled ? `\x1b[${on}m${s}\x1b[${off}m` : s);

export const c = {
  ember: rgb(255, 106, 43),
  amber: rgb(255, 200, 87),
  green: rgb(91, 214, 154),
  red: rgb(255, 77, 94),
  dim: sgr(2, 22),
  bold: sgr(1, 22),
  italic: sgr(3, 23),
};
