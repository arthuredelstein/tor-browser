/**
 * Tor Bug 1330467 - A test case for permissions isolation.
 */

const TEST_PAGE = "https://w3c-test.org/browser/browser/components/" +
                  "originattributes/test/browser/file_firstPartyBasic.html";

async function init() {
  // Remove all stored permissions before test.
  let innerURI = Services.io.newURI("https://w3c-test.org");
  for (let firstPartyDomain of ["example.org", "example.com", ""]) {
    let principal = Services.scriptSecurityManager.createCodebasePrincipal(
      innerURI, { firstPartyDomain });
    Services.perms.removeFromPrincipal(principal, "desktop-notification");
  }
}

// Define the testing function
async function doTest(aBrowser) {
  // Promise will result when permissions popup appears:
  let popupShowPromise = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popupshown");
  let originalStatus = await ContentTask.spawn(aBrowser, null, async function (key) {
    let status = (await content.navigator.permissions.query({name: "notifications"})).state;
    if (status === "prompt") {
      content.Notification.requestPermission();
    }
    return status;
  });
  if (originalStatus === "prompt") {
    // Wait for the popup requesting permission to show notifications:
    await popupShowPromise;
    let popupHidePromise = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popuphidden");
    let popupNotification = PopupNotifications.panel.childNodes[0];
    // Click to grant permission:
    popupNotification.button.click();
    // Wait for popup to hide again.
    await popupHidePromise;
  }
  return originalStatus;
}

function checkIsolation (isolated, val1, val2) {
  is(val1, "prompt", "Permissions have been properly cleared.");
  return isolated === (val2 == "prompt");
}

add_task(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.webnotifications.enabled", true]]
  });
  IsolationTestTools.runTests(TEST_PAGE, doTest, checkIsolation,
                              init, true, true, true);
});
