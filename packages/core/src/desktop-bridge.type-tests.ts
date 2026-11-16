import type { GqEditorViewMenuStateChange } from './desktop-bridge.ts';

const _paired: GqEditorViewMenuStateChange = {
  agentPanelVisible: false,
  wideIntent: { agentPanelVisible: true },
};
void _paired;

const _menuOnly: GqEditorViewMenuStateChange = { sidebarVisible: true };
void _menuOnly;

// @ts-expect-error -- an empty intent would update the menu and persist nothing for the changed pane.
const _emptyIntent: GqEditorViewMenuStateChange = { agentPanelVisible: true, wideIntent: {} };
void _emptyIntent;

// @ts-expect-error -- an intent for another pane leaves the changed pane unpersisted.
const _mismatchedIntent: GqEditorViewMenuStateChange = {
  editorVisible: true,
  wideIntent: { agentPanelVisible: false },
};
void _mismatchedIntent;

// @ts-expect-error -- a dock visibility change without its intent is the unpersisted case this type exists to reject.
const _missingIntent: GqEditorViewMenuStateChange = { editorVisible: true };
void _missingIntent;

const _strayIntent: GqEditorViewMenuStateChange = {
  editorVisible: true,
  // @ts-expect-error -- an intent for a pane the change does not name would persist a pane the menu did not change.
  wideIntent: { editorVisible: true, agentPanelVisible: false },
};
void _strayIntent;

// @ts-expect-error -- one change names one pane; every sender reports each pane separately.
const _twoPanes: GqEditorViewMenuStateChange = {
  editorVisible: true,
  agentPanelVisible: false,
  wideIntent: { editorVisible: true },
};
void _twoPanes;
