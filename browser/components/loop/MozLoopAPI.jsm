/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource:///modules/loop/MozLoopService.jsm");
Cu.import("resource:///modules/loop/LoopContacts.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "hookWindowCloseForPanelClose",
                                        "resource://gre/modules/MozSocialAPI.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PluralForm",
                                        "resource://gre/modules/PluralForm.jsm");
XPCOMUtils.defineLazyGetter(this, "appInfo", function() {
  return Cc["@mozilla.org/xre/app-info;1"]
           .getService(Ci.nsIXULAppInfo)
           .QueryInterface(Ci.nsIXULRuntime);
});
XPCOMUtils.defineLazyServiceGetter(this, "clipboardHelper",
                                         "@mozilla.org/widget/clipboardhelper;1",
                                         "nsIClipboardHelper");
this.EXPORTED_SYMBOLS = ["injectLoopAPI"];

/**
 * Trying to clone an Error object into a different container will yield an error.
 * We can work around this by copying the properties we care about onto a regular
 * object.
 *
 * @param {Error}        error        Error object to copy
 * @param {nsIDOMWindow} targetWindow The content window to attach the API
 */
const cloneErrorObject = function(error, targetWindow) {
  let obj = new targetWindow.Error();
  for (let prop of Object.getOwnPropertyNames(error)) {
    obj[prop] = String(error[prop]);
  }
  return obj;
};

/**
 * Inject any API containing _only_ function properties into the given window.
 *
 * @param {Object}       api          Object containing functions that need to
 *                                    be exposed to content
 * @param {nsIDOMWindow} targetWindow The content window to attach the API
 */
const injectObjectAPI = function(api, targetWindow) {
  let injectedAPI = {};
  // Wrap all the methods in `api` to help results passed to callbacks get
  // through the priv => unpriv barrier with `Cu.cloneInto()`.
  Object.keys(api).forEach(func => {
    injectedAPI[func] = function(...params) {
      let callback = params.pop();
      api[func](...params, function(...results) {
        results = results.map(result => {
          if (result && typeof result == "object") {
            // Inspect for an error this way, because the Error object is special.
            if (result.constructor.name == "Error") {
              return cloneErrorObject(result.message)
            }
            return Cu.cloneInto(result, targetWindow);
          }
          return result;
        });
        callback(...results);
      });
    };
  });

  let contentObj = Cu.cloneInto(injectedAPI, targetWindow, {cloneFunctions: true});
  // Since we deny preventExtensions on XrayWrappers, because Xray semantics make
  // it difficult to act like an object has actually been frozen, we try to seal
  // the `contentObj` without Xrays.
  try {
    Object.seal(Cu.waiveXrays(contentObj));
  } catch (ex) {}
  return contentObj;
};

/**
 * Inject the loop API into the given window.  The caller must be sure the
 * window is a loop content window (eg, a panel, chatwindow, or similar).
 *
 * See the documentation on the individual functions for details of the API.
 *
 * @param {nsIDOMWindow} targetWindow The content window to attach the API.
 */
function injectLoopAPI(targetWindow) {
  let ringer;
  let ringerStopper;
  let appVersionInfo;
  let contactsAPI;

  let api = {
    /**
     * Sets and gets the "do not disturb" mode activation flag.
     */
    doNotDisturb: {
      enumerable: true,
      get: function() {
        return MozLoopService.doNotDisturb;
      },
      set: function(aFlag) {
        MozLoopService.doNotDisturb = aFlag;
      }
    },

    /**
     * Returns the current locale of the browser.
     *
     * @returns {String} The locale string
     */
    locale: {
      enumerable: true,
      get: function() {
        return MozLoopService.locale;
      }
    },

    /**
     * Returns the callData for a specific callDataId
     *
     * The data was retrieved from the LoopServer via a GET/calls/<version> request
     * triggered by an incoming message from the LoopPushServer.
     *
     * @param {int} loopCallId
     * @returns {callData} The callData or undefined if error.
     */
    getCallData: {
      enumerable: true,
      writable: true,
      value: function(loopCallId) {
        return Cu.cloneInto(MozLoopService.getCallData(loopCallId), targetWindow);
      }
    },

    /**
     * Returns the contacts API.
     *
     * @returns {Object} The contacts API object
     */
    contacts: {
      enumerable: true,
      get: function() {
        if (contactsAPI) {
          return contactsAPI;
        }
        return contactsAPI = injectObjectAPI(LoopContacts, targetWindow);
      }
    },

    /**
     * Returns translated strings associated with an element. Designed
     * for use with l10n.js
     *
     * @param {String} key The element id
     * @returns {Object} A JSON string containing the localized
     *                   attribute/value pairs for the element.
     */
    getStrings: {
      enumerable: true,
      writable: true,
      value: function(key) {
        return MozLoopService.getStrings(key);
      }
    },

    /**
     * Returns the correct form of a semi-colon separated string
     * based on the value of the `num` argument and the current locale.
     *
     * @param {Integer} num The number used to find the plural form.
     * @param {String} str The semi-colon separated string of word forms.
     * @returns {String} The correct word form based on the value of the number
     *                   and the current locale.
     */
    getPluralForm: {
      enumerable: true,
      writable: true,
      value: function(num, str) {
        return PluralForm.get(num, str);
      }
    },

    /**
     * Call to ensure that any necessary registrations for the Loop Service
     * have taken place.
     *
     * Callback parameters:
     * - err null on successful registration, non-null otherwise.
     *
     * @param {Function} callback Will be called once registration is complete,
     *                            or straight away if registration has already
     *                            happened.
     */
    ensureRegistered: {
      enumerable: true,
      writable: true,
      value: function(callback) {
        // We translate from a promise to a callback, as we can't pass promises from
        // Promise.jsm across the priv versus unpriv boundary.
        return MozLoopService.register().then(() => {
          callback(null);
        }, err => {
          callback(err);
        });
      }
    },

    /**
     * Used to note a call url expiry time. If the time is later than the current
     * latest expiry time, then the stored expiry time is increased. For times
     * sooner, this function is a no-op; this ensures we always have the latest
     * expiry time for a url.
     *
     * This is used to determine whether or not we should be registering with the
     * push server on start.
     *
     * @param {Integer} expiryTimeSeconds The seconds since epoch of the expiry time
     *                                    of the url.
     */
    noteCallUrlExpiry: {
      enumerable: true,
      writable: true,
      value: function(expiryTimeSeconds) {
        MozLoopService.noteCallUrlExpiry(expiryTimeSeconds);
      }
    },

    /**
     * Set any character preference under "loop."
     *
     * @param {String} prefName The name of the pref without the preceding "loop."
     * @param {String} stringValue The value to set.
     *
     * Any errors thrown by the Mozilla pref API are logged to the console
     * and cause false to be returned.
     */
    setLoopCharPref: {
      enumerable: true,
      writable: true,
      value: function(prefName, value) {
        MozLoopService.setLoopCharPref(prefName, value);
      }
    },

    /**
     * Return any preference under "loop." that's coercible to a character
     * preference.
     *
     * @param {String} prefName The name of the pref without the preceding
     * "loop."
     *
     * Any errors thrown by the Mozilla pref API are logged to the console
     * and cause null to be returned. This includes the case of the preference
     * not being found.
     *
     * @return {String} on success, null on error
     */
    getLoopCharPref: {
      enumerable: true,
      writable: true,
      value: function(prefName) {
        return MozLoopService.getLoopCharPref(prefName);
      }
    },

    /**
     * Return any preference under "loop." that's coercible to a boolean
     * preference.
     *
     * @param {String} prefName The name of the pref without the preceding
     * "loop."
     *
     * Any errors thrown by the Mozilla pref API are logged to the console
     * and cause null to be returned. This includes the case of the preference
     * not being found.
     *
     * @return {String} on success, null on error
     */
    getLoopBoolPref: {
      enumerable: true,
      writable: true,
      value: function(prefName) {
        return MozLoopService.getLoopBoolPref(prefName);
      }
    },

    /**
     * Starts alerting the user about an incoming call
     */
    startAlerting: {
      enumerable: true,
      writable: true,
      value: function() {
        let chromeWindow = getChromeWindow(targetWindow);
        chromeWindow.getAttention();
        ringer = new chromeWindow.Audio();
        ringer.src = Services.prefs.getCharPref("loop.ringtone");
        ringer.loop = true;
        ringer.load();
        ringer.play();
        targetWindow.document.addEventListener("visibilitychange",
          ringerStopper = function(event) {
            if (event.currentTarget.hidden) {
              api.stopAlerting.value();
            }
          });
      }
    },

    /**
     * Stops alerting the user about an incoming call
     */
    stopAlerting: {
      enumerable: true,
      writable: true,
      value: function() {
        if (ringerStopper) {
          targetWindow.document.removeEventListener("visibilitychange",
                                                    ringerStopper);
          ringerStopper = null;
        }
        if (ringer) {
          ringer.pause();
          ringer = null;
        }
      }
    },

    /**
     * Performs a hawk based request to the loop server.
     *
     * Callback parameters:
     *  - {Object|null} null if success. Otherwise an object:
     *    {
     *      code: 401,
     *      errno: 401,
     *      error: "Request failed",
     *      message: "invalid token"
     *    }
     *  - {String} The body of the response.
     *
     * @param {String} path The path to make the request to.
     * @param {String} method The request method, e.g. 'POST', 'GET'.
     * @param {Object} payloadObj An object which is converted to JSON and
     *                            transmitted with the request.
     * @param {Function} callback Called when the request completes.
     */
    hawkRequest: {
      enumerable: true,
      writable: true,
      value: function(path, method, payloadObj, callback) {
        // XXX: Bug 1065153 - Should take a sessionType parameter instead of hard-coding GUEST
        // XXX Should really return a DOM promise here.
        return MozLoopService.hawkRequest(LOOP_SESSION_TYPE.GUEST, path, method, payloadObj).then((response) => {
          callback(null, response.body);
        }, (error) => {
          callback(Cu.cloneInto(error, targetWindow));
        });
      }
    },

    LOOP_SESSION_TYPE: {
      enumerable: true,
      writable: false,
      value: function() {
        return LOOP_SESSION_TYPE;
      },
    },

    logInToFxA: {
      enumerable: true,
      writable: true,
      value: function() {
        return MozLoopService.logInToFxA();
      }
    },

    /**
     * Copies passed string onto the system clipboard.
     *
     * @param {String} str The string to copy
     */
    copyString: {
      enumerable: true,
      writable: true,
      value: function(str) {
        clipboardHelper.copyString(str);
      }
    },

    /**
     * Returns the app version information for use during feedback.
     *
     * @return {Object} An object containing:
     *   - channel: The update channel the application is on
     *   - version: The application version
     *   - OS: The operating system the application is running on
     */
    appVersionInfo: {
      enumerable: true,
      get: function() {
        if (!appVersionInfo) {
          let defaults = Services.prefs.getDefaultBranch(null);

          appVersionInfo = Cu.cloneInto({
            channel: defaults.getCharPref("app.update.channel"),
            version: appInfo.version,
            OS: appInfo.OS
          }, targetWindow);
        }
        return appVersionInfo;
      }
    },
  };

  let contentObj = Cu.createObjectIn(targetWindow);
  Object.defineProperties(contentObj, api);
  Object.seal(contentObj);
  Cu.makeObjectPropsNormal(contentObj);

  targetWindow.navigator.wrappedJSObject.__defineGetter__("mozLoop", function() {
    // We do this in a getter, so that we create these objects
    // only on demand (this is a potential concern, since
    // otherwise we might add one per iframe, and keep them
    // alive for as long as the window is alive).
    delete targetWindow.navigator.wrappedJSObject.mozLoop;
    return targetWindow.navigator.wrappedJSObject.mozLoop = contentObj;
  });

  // Handle window.close correctly on the panel and chatbox.
  hookWindowCloseForPanelClose(targetWindow);
}

function getChromeWindow(contentWin) {
  return contentWin.QueryInterface(Ci.nsIInterfaceRequestor)
                   .getInterface(Ci.nsIWebNavigation)
                   .QueryInterface(Ci.nsIDocShellTreeItem)
                   .rootTreeItem
                   .QueryInterface(Ci.nsIInterfaceRequestor)
                   .getInterface(Ci.nsIDOMWindow);
}
