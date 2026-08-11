import { basename } from "path";

export interface PaneIdentityInput {
  paneTitle: string;
  paneCurrentCommand: string;
  paneCurrentPath: string;
}

export interface PaneLabelInput extends PaneIdentityInput {
  sessionName: string;
}

/**
 * A pane's own identity, with no session name attached: the pane title if the
 * program set one (Claude does), otherwise "command · cwd-basename" to
 * disambiguate two node/bun panes in one session. The half of `buildPaneLabel`
 * that survives as the tile label's pane suffix (`buildTileLabel`) once the
 * session name is supplied by the tile's own identity instead.
 */
export function paneIdentity(input: PaneIdentityInput): string {
  const { paneTitle, paneCurrentCommand, paneCurrentPath } = input;
  const title = paneTitle.trim();
  if (title) return title;
  const base = basename(paneCurrentPath);
  return base && base !== "/" ? `${paneCurrentCommand} · ${base}` : paneCurrentCommand;
}

/**
 * Human label for a pane: "session name › pane identity". Predates the
 * Command Center's derived-membership design, where it was the whole tile
 * label; kept for the sidebar's Overview children, and as the building block
 * `buildTileLabel` reuses for the tile label's pane suffix.
 */
export function buildPaneLabel(input: PaneLabelInput): string {
  return `${input.sessionName} › ${paneIdentity(input)}`;
}

/**
 * A Command Center tile's full label: the session's own identity (name plus
 * issue badge, built by the caller), with the displayed pane's identity
 * appended only when that pane is not the session's natural first choice — a
 * force-on pin or a live `Ctrl-a x` cycle override. Without the suffix there
 * is nothing on screen saying which of a session's panes a tile is showing
 * once a cycle has moved it off the election's own answer.
 */
export function buildTileLabel(
  identity: string,
  pane: PaneIdentityInput | null,
  showPaneSuffix: boolean,
): string {
  if (!showPaneSuffix || !pane) return identity;
  return `${identity} · ${paneIdentity(pane)}`;
}
