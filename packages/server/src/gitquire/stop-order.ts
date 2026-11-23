export interface StopSteps {
  flushWiki: () => Promise<void>;
  stopDrafts: () => Promise<void>;
}

export async function stopWikiAndDrafts(behindFrontDoor: boolean, steps: StopSteps): Promise<void> {
  if (behindFrontDoor) {
    await steps.stopDrafts();
    await steps.flushWiki();
    return;
  }
  await steps.flushWiki();
  await steps.stopDrafts();
}
