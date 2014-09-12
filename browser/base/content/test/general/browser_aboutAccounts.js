/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

XPCOMUtils.defineLazyModuleGetter(this, "Promise",
  "resource://gre/modules/Promise.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Task",
  "resource://gre/modules/Task.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "fxAccounts",
  "resource://gre/modules/FxAccounts.jsm");

const CHROME_BASE = "chrome://mochitests/content/browser/browser/base/content/test/general/";
// Preference helpers.
let changedPrefs = new Set();

function setPref(name, value) {
  changedPrefs.add(name);
  Services.prefs.setCharPref(name, value);
}

registerCleanupFunction(function() {
  // Ensure we don't pollute prefs for next tests.
  for (let name of changedPrefs) {
    Services.prefs.clearUserPref(name);
  }
});

let gTests = [
{
  desc: "Test the remote commands",
  teardown: function* () {
    gBrowser.removeCurrentTab();
    yield fxAccounts.signOut();
  },
  run: function* ()
  {
    setPref("identity.fxaccounts.remote.signup.uri",
            "https://example.com/browser/browser/base/content/test/general/accounts_testRemoteCommands.html");
    yield promiseNewTabLoadEvent("about:accounts");

    let deferred = Promise.defer();

    let results = 0;
    try {
      let win = gBrowser.contentWindow;
      win.addEventListener("message", function testLoad(e) {
        if (e.data.type == "testResult") {
          ok(e.data.pass, e.data.info);
          results++;
        }
        else if (e.data.type == "testsComplete") {
          is(results, e.data.count, "Checking number of results received matches the number of tests that should have run");
          win.removeEventListener("message", testLoad, false, true);
          deferred.resolve();
        }

      }, false, true);

    } catch(e) {
      ok(false, "Failed to get all commands");
      deferred.reject();
    }
    yield deferred.promise;
  }
},
{
  desc: "Test action=signin - no user logged in",
  teardown: () => gBrowser.removeCurrentTab(),
  run: function* ()
  {
    // When this loads with no user logged-in, we expect the "normal" URL
    const expected_url = "https://example.com/?is_sign_in";
    setPref("identity.fxaccounts.remote.signin.uri", expected_url);
    let [tab, url] = yield promiseNewTabWithIframeLoadEvent("about:accounts?action=signin");
    is(url, expected_url, "action=signin got the expected URL");
    // we expect the remote iframe to be shown.
    yield checkVisibilities(tab, {
      stage: false, // parent of 'manage' and 'intro'
      manage: false,
      intro: false, // this is  "get started"
      remote: true
    });
  }
},
{
  desc: "Test action=signin - user logged in",
  teardown: function* () {
    gBrowser.removeCurrentTab();
    yield signOut();
  },
  run: function* ()
  {
    // When this loads with a user logged-in, we expect the normal URL to
    // have been ignored and the "manage" page to be shown.
    const expected_url = "https://example.com/?is_sign_in";
    setPref("identity.fxaccounts.remote.signin.uri", expected_url);
    yield setSignedInUser();
    let tab = yield promiseNewTabLoadEvent("about:accounts?action=signin");
    // about:accounts initializes after fetching the current user from Fxa -
    // so we also request it - by the time we get it we know it should have
    // done its thing.
    yield fxAccounts.getSignedInUser();
    // we expect "manage" to be shown.
    yield checkVisibilities(tab, {
      stage: true, // parent of 'manage' and 'intro'
      manage: true,
      intro: false, // this is  "get started"
      remote: false
    });
  }
},
{
  desc: "Test action=signup - no user logged in",
  teardown: () => gBrowser.removeCurrentTab(),
  run: function* ()
  {
    const expected_url = "https://example.com/?is_sign_up";
    setPref("identity.fxaccounts.remote.signup.uri", expected_url);
    let [tab, url] = yield promiseNewTabWithIframeLoadEvent("about:accounts?action=signup");
    is(url, expected_url, "action=signup got the expected URL");
    // we expect the remote iframe to be shown.
    yield checkVisibilities(tab, {
      stage: false, // parent of 'manage' and 'intro'
      manage: false,
      intro: false, // this is  "get started"
      remote: true
    });
  },
},
{
  desc: "Test action=signup - user logged in",
  teardown: () => gBrowser.removeCurrentTab(),
  run: function* ()
  {
    const expected_url = "https://example.com/?is_sign_up";
    setPref("identity.fxaccounts.remote.signup.uri", expected_url);
    yield setSignedInUser();
    let tab = yield promiseNewTabLoadEvent("about:accounts?action=signup");
    yield fxAccounts.getSignedInUser();
    // we expect "manage" to be shown.
    yield checkVisibilities(tab, {
      stage: true, // parent of 'manage' and 'intro'
      manage: true,
      intro: false, // this is  "get started"
      remote: false
    });
  },
},
{
  desc: "Test action=reauth",
  teardown: function* () {
    gBrowser.removeCurrentTab();
    yield signOut();
  },
  run: function* ()
  {
    const expected_url = "https://example.com/?is_force_auth";
    setPref("identity.fxaccounts.remote.force_auth.uri", expected_url);
    let userData = {
      email: "foo@example.com",
      uid: "1234@lcip.org",
      assertion: "foobar",
      sessionToken: "dead",
      kA: "beef",
      kB: "cafe",
      verified: true
    };

    yield setSignedInUser();
    let [tab, url] = yield promiseNewTabWithIframeLoadEvent("about:accounts?action=reauth");
    // The current user will be appended to the url
    let expected = expected_url + "&email=foo%40example.com";
    is(url, expected, "action=reauth got the expected URL");
  },
},
{
  desc: "Test observers about:accounts",
  teardown: function() {
    gBrowser.removeCurrentTab();
  },
  run: function* () {
    setPref("identity.fxaccounts.remote.signup.uri", "https://example.com/");
    yield setSignedInUser();
    let tab = yield promiseNewTabLoadEvent("about:accounts");
    // sign the user out - the tab should have action=signin
    yield signOut();
    // wait for the new load.
    yield promiseOneMessage(tab, "test:document:load");
    is(tab.linkedBrowser.contentDocument.location.href, "about:accounts?action=signin");
  }
},
{
  desc: "Test entrypoint query string, no action, no user logged in",
  teardown: () => gBrowser.removeCurrentTab(),
  run: function* () {
    // When this loads with no user logged-in, we expect the "normal" URL
    setPref("identity.fxaccounts.remote.signup.uri", "https://example.com/");
    let [tab, url] = yield promiseNewTabWithIframeLoadEvent("about:accounts?entrypoint=abouthome");
    is(url, "https://example.com/?entrypoint=abouthome", "entrypoint=abouthome got the expected URL");
  },
},
{
  desc: "Test entrypoint query string for signin",
  teardown: () => gBrowser.removeCurrentTab(),
  run: function* () {
    // When this loads with no user logged-in, we expect the "normal" URL
    const expected_url = "https://example.com/?is_sign_in";
    setPref("identity.fxaccounts.remote.signin.uri", expected_url);
    let [tab, url] = yield promiseNewTabWithIframeLoadEvent("about:accounts?action=signin&entrypoint=abouthome");
    is(url, expected_url + "&entrypoint=abouthome", "entrypoint=abouthome got the expected URL");
  },
},
{
  desc: "Test entrypoint query string for signup",
  teardown: () => gBrowser.removeCurrentTab(),
  run: function* () {
    // When this loads with no user logged-in, we expect the "normal" URL
    const sign_up_url = "https://example.com/?is_sign_up";
    setPref("identity.fxaccounts.remote.signup.uri", sign_up_url);
    let [tab, url] = yield promiseNewTabWithIframeLoadEvent("about:accounts?entrypoint=abouthome&action=signup");
    is(url, sign_up_url + "&entrypoint=abouthome", "entrypoint=abouthome got the expected URL");
  },
},
]; // gTests

function test()
{
  waitForExplicitFinish();

  Task.spawn(function () {
    for (let test of gTests) {
      info(test.desc);
      try {
        yield test.run();
      } finally {
        yield test.teardown();
      }
    }

    finish();
  });
}

function promiseOneMessage(tab, messageName) {
  let mm = tab.linkedBrowser.messageManager;
  let deferred = Promise.defer();
  mm.addMessageListener(messageName, function onmessage(message) {
    mm.removeMessageListener(messageName, onmessage);
    deferred.resolve(message);
  });
  return deferred.promise;
}

function promiseNewTabLoadEvent(aUrl)
{
  let tab = gBrowser.selectedTab = gBrowser.addTab(aUrl);
  let browser = tab.linkedBrowser;
  let mm = browser.messageManager;

  // give it an e10s-friendly content script to help with our tests.
  mm.loadFrameScript(CHROME_BASE + "content_aboutAccounts.js", true);
  // and wait for it to tell us about the load.
  return promiseOneMessage(tab, "test:document:load").then(
    () => tab
  );
}

// Returns a promise which is resolved with the iframe's URL after a new
// tab is created and the iframe in that tab loads.
function promiseNewTabWithIframeLoadEvent(aUrl) {
  let deferred = Promise.defer();
  let tab = gBrowser.selectedTab = gBrowser.addTab(aUrl);
  let browser = tab.linkedBrowser;
  let mm = browser.messageManager;

  // give it an e10s-friendly content script to help with our tests.
  mm.loadFrameScript(CHROME_BASE + "content_aboutAccounts.js", true);
  // and wait for it to tell us about the iframe load.
  mm.addMessageListener("test:iframe:load", function onFrameLoad(message) {
    mm.removeMessageListener("test:iframe:load", onFrameLoad);
    deferred.resolve([tab, message.data.url]);
  });
  return deferred.promise;
}

function checkVisibilities(tab, data) {
  let ids = Object.keys(data);
  let mm = tab.linkedBrowser.messageManager;
  let deferred = Promise.defer();
  mm.addMessageListener("test:check-visibilities-response", function onResponse(message) {
    mm.removeMessageListener("test:check-visibilities-response", onResponse);
    for (let id of ids) {
      is(message.data[id], data[id], "Element '" + id + "' has correct visibility");
    }
    deferred.resolve();
  });
  mm.sendAsyncMessage("test:check-visibilities", {ids: ids});
  return deferred.promise;
}

// watch out - these will fire observers which if you aren't careful, may
// interfere with the tests.
function setSignedInUser(data) {
  if (!data) {
    data = {
      email: "foo@example.com",
      uid: "1234@lcip.org",
      assertion: "foobar",
      sessionToken: "dead",
      kA: "beef",
      kB: "cafe",
      verified: true
    }
  }
 return fxAccounts.setSignedInUser(data);
}

function signOut() {
  return fxAccounts.signOut();
}
