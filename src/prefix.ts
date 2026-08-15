/**
 * jmux's default prefix, in the three forms its boundaries need.
 *
 * Terminals encode Ctrl-Space as NUL. Keep this byte shared by every input
 * surface that recognizes a prefix chord; tmux's spelling is asserted against
 * config/core.conf in tmux-conf.test.ts.
 */
export const PREFIX_BYTE = "\x00";
export const PREFIX_LABEL = "Ctrl-Space";
export const TMUX_PREFIX_KEY = "C-Space";
