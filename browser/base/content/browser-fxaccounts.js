# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

XPCOMUtils.defineLazyGetter(this, "FxAccountsCommon", function () {
  return Cu.import("resource://gre/modules/FxAccountsCommon.js", {});
});

const PREF_SYNC_START_DOORHANGER = "services.sync.ui.showSyncStartDoorhanger";
const DOORHANGER_ACTIVATE_DELAY_MS = 5000;

let gFxAccounts = {

  _initialized: false,
  _inCustomizationMode: false,

  get weave() {
    delete this.weave;
    return this.weave = Cc["@mozilla.org/weave/service;1"]
                          .getService(Ci.nsISupports)
                          .wrappedJSObject;
  },

  get topics() {
    // Do all this dance to lazy-load FxAccountsCommon.
    delete this.topics;
    return this.topics = [
      "weave:service:ready",
      "weave:service:sync:start",
      "weave:service:login:error",
      "weave:service:setup-complete",
      FxAccountsCommon.ONVERIFIED_NOTIFICATION,
      FxAccountsCommon.ONLOGOUT_NOTIFICATION
    ];
  },

  get button() {
    delete this.button;
    return this.button = document.getElementById("PanelUI-fxa-status");
  },

  get loginFailed() {
    // Referencing Weave.Service will implicitly initialize sync, and we don't
    // want to force that - so first check if it is ready.
    let service = Cc["@mozilla.org/weave/service;1"]
                  .getService(Components.interfaces.nsISupports)
                  .wrappedJSObject;
    if (!service.ready) {
      return false;
    }
    // LOGIN_FAILED_LOGIN_REJECTED explicitly means "you must log back in".
    // All other login failures are assumed to be transient and should go
    // away by themselves, so aren't reflected here.
    return Weave.Status.login == Weave.LOGIN_FAILED_LOGIN_REJECTED;
  },

  get isActiveWindow() {
    let fm = Cc["@mozilla.org/focus-manager;1"].getService(Ci.nsIFocusManager);
    return fm.activeWindow == window;
  },

  init: function () {
    // Bail out if we're already initialized and for pop-up windows.
    if (this._initialized || !window.toolbar.visible) {
      return;
    }

    for (let topic of this.topics) {
      Services.obs.addObserver(this, topic, false);
    }

    addEventListener("activate", this);
    gNavToolbox.addEventListener("customizationstarting", this);
    gNavToolbox.addEventListener("customizationending", this);

    this._initialized = true;

    this.updateUI();
  },

  uninit: function () {
    if (!this._initialized) {
      return;
    }

    for (let topic of this.topics) {
      Services.obs.removeObserver(this, topic);
    }

    this._initialized = false;
  },

  observe: function (subject, topic) {
    switch (topic) {
      case FxAccountsCommon.ONVERIFIED_NOTIFICATION:
        Services.prefs.setBoolPref(PREF_SYNC_START_DOORHANGER, true);
        break;
      case "weave:service:sync:start":
        this.onSyncStart();
        break;
      default:
        this.updateUI();
        break;
    }
  },

  onSyncStart: function () {
    if (!this.isActiveWindow) {
      return;
    }

    let showDoorhanger = false;

    try {
      showDoorhanger = Services.prefs.getBoolPref(PREF_SYNC_START_DOORHANGER);
    } catch (e) { /* The pref might not exist. */ }

    if (showDoorhanger) {
      Services.prefs.clearUserPref(PREF_SYNC_START_DOORHANGER);
      this.showSyncStartedDoorhanger();
    }
  },

  handleEvent: function (event) {
    if (event.type == "activate") {
      // Our window might have been in the background while we received the
      // sync:start notification. If still needed, show the doorhanger after
      // a short delay. Without this delay the doorhanger would not show up
      // or with a too small delay show up while we're still animating the
      // window.
      setTimeout(() => this.onSyncStart(), DOORHANGER_ACTIVATE_DELAY_MS);
    } else {
      this._inCustomizationMode = event.type == "customizationstarting";
      this.updateUI();
    }
  },

  showDoorhanger: function (id) {
    let panel = document.getElementById(id);
    let anchor = document.getElementById("PanelUI-menu-button");

    let iconAnchor =
      document.getAnonymousElementByAttribute(anchor, "class",
                                              "toolbarbutton-icon");

    panel.hidden = false;
    panel.openPopup(iconAnchor || anchor, "bottomcenter topright");
  },

  showSyncStartedDoorhanger: function () {
    this.showDoorhanger("sync-start-panel");
  },

  showSyncFailedDoorhanger: function () {
    this.showDoorhanger("sync-error-panel");
  },

  updateUI: function () {
    // Bail out if FxA is disabled.
    if (!this.weave.fxAccountsEnabled) {
      return;
    }

    // FxA is enabled, show the widget.
    this.button.removeAttribute("hidden");

    // Make sure the button is disabled in customization mode.
    if (this._inCustomizationMode) {
      this.button.setAttribute("disabled", "true");
    } else {
      this.button.removeAttribute("disabled");
    }

    let defaultLabel = this.button.getAttribute("defaultlabel");
    let errorLabel = this.button.getAttribute("errorlabel");

    // If the user is signed into their Firefox account and we are not
    // currently in customization mode, show their email address.
    let doUpdate = userData => {
      // Reset the button to its original state.
      this.button.setAttribute("label", defaultLabel);
      this.button.removeAttribute("tooltiptext");
      this.button.removeAttribute("signedin");
      this.button.removeAttribute("failed");

      if (!this._inCustomizationMode) {
        if (this.loginFailed) {
          this.button.setAttribute("failed", "true");
          this.button.setAttribute("label", errorLabel);
        } else if (userData) {
          this.button.setAttribute("signedin", "true");
          this.button.setAttribute("label", userData.email);
          this.button.setAttribute("tooltiptext", userData.email);
        }
      }
    }
    fxAccounts.getSignedInUser().then(userData => {
      doUpdate(userData);
    }).then(null, error => {
      // This is most likely in tests, were we quickly log users in and out.
      // The most likely scenario is a user logged out, so reflect that.
      // Bug 995134 calls for better errors so we could retry if we were
      // sure this was the failure reason.
      doUpdate(null);
    });
  },

  onMenuPanelCommand: function (event) {
    let button = event.originalTarget;

    if (button.hasAttribute("signedin")) {
      this.openPreferences();
    } else if (button.hasAttribute("failed")) {
      this.openSignInAgainPage();
    } else {
      this.openAccountsPage();
    }

    PanelUI.hide();
  },

  openPreferences: function () {
    openPreferences("paneSync");
  },

  openAccountsPage: function () {
    let entryPoint = "menupanel";
    if (UITour.originTabs.get(window) && UITour.originTabs.get(window).has(gBrowser.selectedTab)) {
      entryPoint = "uitour";
    }
    switchToTabHavingURI("about:accounts?entrypoint=" + entryPoint, true, {
      replaceQueryString: true
    });
  },

  openSignInAgainPage: function () {
    let entryPoint = "menupanel";
    if (UITour.originTabs.get(window) && UITour.originTabs.get(window).has(gBrowser.selectedTab)) {
      entryPoint = "uitour";
    }
    switchToTabHavingURI("about:accounts?action=reauth&entrypoint=" + entryPoint, true, {
      replaceQueryString: true
    });
  }
};
