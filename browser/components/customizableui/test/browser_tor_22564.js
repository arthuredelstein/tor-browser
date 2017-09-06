"use strict";

// Returns true if the element with id is hidden.
let isHidden = function (id) {
  return document.getElementById(id).hidden;
};

// A single task to test all elements that shold be hidden if
// and only if "services.sync.ui.hidden" is enabled.
add_task(async function () {
  // Place sync button on navigation bar:
  CustomizableUI.addWidgetToArea("sync-button", "nav-bar");
  ok(document.getElementById("sync-button"), "sync button should exist");
  // Open a new tab to about:preferences:
  await BrowserTestUtils.withNewTab("about:preferences",
    async function (preferencesBrowser) {
      // Check results when hiding is off and on:
      for (let hideSync of [false, true]) {
        await SpecialPowers.pushPrefEnv({ set : [["services.sync.ui.hidden", hideSync]] });
        // Check the current hidden state of the category-sync label:
        let syncCategoryHidden = await ContentTask.spawn(preferencesBrowser, {}, () => {
          return content.document.getElementById("category-sync").hidden;
        });
        is(syncCategoryHidden, hideSync, "Sync category in about:preferences hidden state");
        // Now check hamburger menu item, sync button, and Tools menu items respectively:
        is(isHidden("PanelUI-footer-fxa"), hideSync, "Sync hamburger menu item hidden state");
        is(isHidden("sync-button"), hideSync, "Sync button hidden state");
        is(isHidden("sync-reauth-state") &&
           isHidden("sync-setup-state") &&
           isHidden("sync-syncnow-state"),
           hideSync,
           "Sync menu items in Tools menu hidden state");
      }
    });
  // Return navigation bar to its original uncustomized state.
  CustomizableUI.reset();
});
