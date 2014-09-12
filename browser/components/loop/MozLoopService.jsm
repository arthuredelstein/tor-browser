/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;

// Invalid auth token as per
// https://github.com/mozilla-services/loop-server/blob/45787d34108e2f0d87d74d4ddf4ff0dbab23501c/loop/errno.json#L6
const INVALID_AUTH_TOKEN = 110;

// Ticket numbers are 24 bits in length.
// The highest valid ticket number is 16777214 (2^24 - 2), so that a "now
// serving" number of 2^24 - 1 is greater than it.
const MAX_SOFT_START_TICKET_NUMBER = 16777214;

const LOOP_SESSION_TYPE = {
  GUEST: 1,
  FXA: 2,
};

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/osfile.jsm", this);
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/FxAccountsOAuthClient.jsm");

this.EXPORTED_SYMBOLS = ["MozLoopService", "LOOP_SESSION_TYPE"];

XPCOMUtils.defineLazyModuleGetter(this, "console",
  "resource://gre/modules/devtools/Console.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "injectLoopAPI",
  "resource:///modules/loop/MozLoopAPI.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "convertToRTCStatsReport",
  "resource://gre/modules/media/RTCStatsReport.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "Chat", "resource:///modules/Chat.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "CommonUtils",
                                  "resource://services-common/utils.js");

XPCOMUtils.defineLazyModuleGetter(this, "CryptoUtils",
                                  "resource://services-crypto/utils.js");

XPCOMUtils.defineLazyModuleGetter(this, "HawkClient",
                                  "resource://services-common/hawkclient.js");

XPCOMUtils.defineLazyModuleGetter(this, "deriveHawkCredentials",
                                  "resource://services-common/hawkrequest.js");

XPCOMUtils.defineLazyModuleGetter(this, "MozLoopPushHandler",
                                  "resource:///modules/loop/MozLoopPushHandler.jsm");

XPCOMUtils.defineLazyServiceGetter(this, "uuidgen",
                                   "@mozilla.org/uuid-generator;1",
                                   "nsIUUIDGenerator");

XPCOMUtils.defineLazyServiceGetter(this, "gDNSService",
                                   "@mozilla.org/network/dns-service;1",
                                   "nsIDNSService");


// The current deferred for the registration process. This is set if in progress
// or the registration was successful. This is null if a registration attempt was
// unsuccessful.
let gRegisteredDeferred = null;
let gPushHandler = null;
let gHawkClient = null;
let gRegisteredLoopServer = false;
let gLocalizedStrings =  null;
let gInitializeTimer = null;
let gFxAOAuthClientPromise = null;
let gFxAOAuthClient = null;
let gFxAOAuthTokenData = null;
let gErrors = new Map();

/**
 * Internal helper methods and state
 *
 * The registration is a two-part process. First we need to connect to
 * and register with the push server. Then we need to take the result of that
 * and register with the Loop server.
 */
let MozLoopServiceInternal = {
  callsData: {data: undefined},

  // The uri of the Loop server.
  get loopServerUri() Services.prefs.getCharPref("loop.server"),

  /**
   * The initial delay for push registration. This ensures we don't start
   * kicking off straight after browser startup, just a few seconds later.
   */
  get initialRegistrationDelayMilliseconds() {
    try {
      // Let a pref override this for developer & testing use.
      return Services.prefs.getIntPref("loop.initialDelay");
    } catch (x) {
      // Default to 5 seconds
      return 5000;
    }
    return initialDelay;
  },

  /**
   * Gets the current latest expiry time for urls.
   *
   * In seconds since epoch.
   */
  get expiryTimeSeconds() {
    try {
      return Services.prefs.getIntPref("loop.urlsExpiryTimeSeconds");
    } catch (x) {
      // It is ok for the pref not to exist.
      return 0;
    }
  },

  /**
   * Sets the expiry time to either the specified time, or keeps it the same
   * depending on which is latest.
   */
  set expiryTimeSeconds(time) {
    if (time > this.expiryTimeSeconds) {
      Services.prefs.setIntPref("loop.urlsExpiryTimeSeconds", time);
    }
  },

  /**
   * Returns true if the expiry time is in the future.
   */
  urlExpiryTimeIsInFuture: function() {
    return this.expiryTimeSeconds * 1000 > Date.now();
  },

  /**
   * Retrieves MozLoopService "do not disturb" pref value.
   *
   * @return {Boolean} aFlag
   */
  get doNotDisturb() {
    return Services.prefs.getBoolPref("loop.do_not_disturb");
  },

  /**
   * Sets MozLoopService "do not disturb" pref value.
   *
   * @param {Boolean} aFlag
   */
  set doNotDisturb(aFlag) {
    Services.prefs.setBoolPref("loop.do_not_disturb", Boolean(aFlag));
    this.notifyStatusChanged();
  },

  notifyStatusChanged: function() {
    Services.obs.notifyObservers(null, "loop-status-changed", null);
  },

  /**
   * @param {String} errorType a key to identify the type of error. Only one
   *                           error of a type will be saved at a time.
   * @param {Object} error     an object describing the error in the format from Hawk errors
   */
  setError: function(errorType, error) {
    gErrors.set(errorType, error);
    this.notifyStatusChanged();
  },

  clearError: function(errorType) {
    gErrors.delete(errorType);
    this.notifyStatusChanged();
  },

  get errors() {
    return gErrors;
  },

  /**
   * Starts registration of Loop with the push server, and then will register
   * with the Loop server. It will return early if already registered.
   *
   * @param {Object} mockPushHandler Optional, test-only mock push handler. Used
   *                                 to allow mocking of the MozLoopPushHandler.
   * @returns {Promise} a promise that is resolved with no params on completion, or
   *          rejected with an error code or string.
   */
  promiseRegisteredWithServers: function(mockPushHandler) {
    if (gRegisteredDeferred) {
      return gRegisteredDeferred.promise;
    }

    gRegisteredDeferred = Promise.defer();
    // We grab the promise early in case .initialize or its results sets
    // it back to null on error.
    let result = gRegisteredDeferred.promise;

    gPushHandler = mockPushHandler || MozLoopPushHandler;

    gPushHandler.initialize(this.onPushRegistered.bind(this),
      this.onHandleNotification.bind(this));

    return result;
  },

  /**
   * Performs a hawk based request to the loop server.
   *
   * @param {LOOP_SESSION_TYPE} sessionType The type of session to use for the request.
   *                                        This is one of the LOOP_SESSION_TYPE members.
   * @param {String} path The path to make the request to.
   * @param {String} method The request method, e.g. 'POST', 'GET'.
   * @param {Object} payloadObj An object which is converted to JSON and
   *                            transmitted with the request.
   * @returns {Promise}
   *        Returns a promise that resolves to the response of the API call,
   *        or is rejected with an error.  If the server response can be parsed
   *        as JSON and contains an 'error' property, the promise will be
   *        rejected with this JSON-parsed response.
   */
  hawkRequest: function(sessionType, path, method, payloadObj) {
    if (!gHawkClient) {
      gHawkClient = new HawkClient(this.loopServerUri);
    }

    let sessionToken;
    try {
      sessionToken = Services.prefs.getCharPref(this.getSessionTokenPrefName(sessionType));
    } catch (x) {
      // It is ok for this not to exist, we'll default to sending no-creds
    }

    let credentials;
    if (sessionToken) {
      // true = use a hex key, as required by the server (see bug 1032738).
      credentials = deriveHawkCredentials(sessionToken, "sessionToken",
                                          2 * 32, true);
    }

    return gHawkClient.request(path, method, credentials, payloadObj).catch(error => {
      console.error("Loop hawkRequest error:", error);
      throw error;
    });
  },

  getSessionTokenPrefName: function(sessionType) {
    let suffix;
    switch (sessionType) {
      case LOOP_SESSION_TYPE.GUEST:
        suffix = "";
        break;
      case LOOP_SESSION_TYPE.FXA:
        suffix = ".fxa";
        break;
      default:
        throw new Error("Unknown LOOP_SESSION_TYPE");
        break;
    }
    return "loop.hawk-session-token" + suffix;
  },

  /**
   * Used to store a session token from a request if it exists in the headers.
   *
   * @param {LOOP_SESSION_TYPE} sessionType The type of session to use for the request.
   *                                        One of the LOOP_SESSION_TYPE members.
   * @param {Object} headers The request headers, which may include a
   *                         "hawk-session-token" to be saved.
   * @return true on success or no token, false on failure.
   */
  storeSessionToken: function(sessionType, headers) {
    let sessionToken = headers["hawk-session-token"];
    if (sessionToken) {
      // XXX should do more validation here
      if (sessionToken.length === 64) {
        Services.prefs.setCharPref(this.getSessionTokenPrefName(sessionType), sessionToken);
      } else {
        // XXX Bubble the precise details up to the UI somehow (bug 1013248).
        console.warn("Loop server sent an invalid session token");
        gRegisteredDeferred.reject("session-token-wrong-size");
        gRegisteredDeferred = null;
        return false;
      }
    }
    return true;
  },

  /**
   * Callback from MozLoopPushHandler - The push server has been registered
   * and has given us a push url.
   *
   * @param {String} pushUrl The push url given by the push server.
   */
  onPushRegistered: function(err, pushUrl) {
    if (err) {
      gRegisteredDeferred.reject(err);
      gRegisteredDeferred = null;
      return;
    }

    this.registerWithLoopServer(LOOP_SESSION_TYPE.GUEST, pushUrl).then(() => {
      // storeSessionToken could have rejected and nulled the promise if the token was malformed.
      if (!gRegisteredDeferred) {
        return;
      }
      gRegisteredDeferred.resolve();
      // No need to clear the promise here, everything was good, so we don't need
      // to re-register.
    }, (error) => {
      Cu.reportError("Failed to register with Loop server: " + error.errno);
      gRegisteredDeferred.reject(error.errno);
      gRegisteredDeferred = null;
    });
  },

  /**
   * Registers with the Loop server either as a guest or a FxA user.
   *
   * @param {LOOP_SESSION_TYPE} sessionType The type of session e.g. guest or FxA
   * @param {String} pushUrl The push url given by the push server.
   * @param {Boolean} [retry=true] Whether to retry if authentication fails.
   * @return {Promise}
   */
  registerWithLoopServer: function(sessionType, pushUrl, retry = true) {
    return this.hawkRequest(sessionType, "/registration", "POST", { simplePushURL: pushUrl})
      .then((response) => {
        // If this failed we got an invalid token. storeSessionToken rejects
        // the gRegisteredDeferred promise for us, so here we just need to
        // early return.
        if (!this.storeSessionToken(sessionType, response.headers))
          return;

        this.clearError("registration");
      }, (error) => {
        // There's other errors than invalid auth token, but we should only do the reset
        // as a last resort.
        if (error.code === 401 && error.errno === INVALID_AUTH_TOKEN) {
          if (this.urlExpiryTimeIsInFuture()) {
            // XXX Should this be reported to the user is a visible manner?
            Cu.reportError("Loop session token is invalid, all previously "
                           + "generated urls will no longer work.");
          }

          // Authorization failed, invalid token, we need to try again with a new token.
          Services.prefs.clearUserPref(this.getSessionTokenPrefName(sessionType));
          if (retry) {
            return this.registerWithLoopServer(sessionType, pushUrl, false);
          }
        }

        // XXX Bubble the precise details up to the UI somehow (bug 1013248).
        Cu.reportError("Failed to register with the loop server. error: " + error);
        this.setError("registration", error);
        throw error;
      }
    );
  },

  /**
   * Callback from MozLoopPushHandler - A push notification has been received from
   * the server.
   *
   * @param {String} version The version information from the server.
   */
  onHandleNotification: function(version) {
    if (this.doNotDisturb) {
      return;
    }

    // We set this here as it is assumed that once the user receives an incoming
    // call, they'll have had enough time to see the terms of service. See
    // bug 1046039 for background.
    Services.prefs.setCharPref("loop.seenToS", "seen");

    /* Request the information on the new call(s) associated with this version. */
    this.hawkRequest(LOOP_SESSION_TYPE.GUEST,
      "/calls?version=" + version, "GET").then(response => {
      try {
        let respData = JSON.parse(response.body);
        if (respData.calls && respData.calls[0]) {
          this.callsData.data = respData.calls[0];
          this.openChatWindow(null,
            this.localizedStrings["incoming_call_title2"].textContent,
            "about:loopconversation#incoming/" + version);
        } else {
          console.warn("Error: missing calls[] in response");
        }
      } catch (err) {
        console.warn("Error parsing calls info", err);
      }
    });
  },

  /**
   * A getter to obtain and store the strings for loop. This is structured
   * for use by l10n.js.
   *
   * @returns {Object} a map of element ids with attributes to set.
   */
  get localizedStrings() {
    if (gLocalizedStrings)
      return gLocalizedStrings;

    var stringBundle =
      Services.strings.createBundle('chrome://browser/locale/loop/loop.properties');

    var map = {};
    var enumerator = stringBundle.getSimpleEnumeration();
    while (enumerator.hasMoreElements()) {
      var string = enumerator.getNext().QueryInterface(Ci.nsIPropertyElement);

      // 'textContent' is the default attribute to set if none are specified.
      var key = string.key, property = 'textContent';
      var i = key.lastIndexOf('.');
      if (i >= 0) {
        property = key.substring(i + 1);
        key = key.substring(0, i);
      }
      if (!(key in map))
        map[key] = {};
      map[key][property] = string.value;
    }

    return gLocalizedStrings = map;
  },

  /**
   * Saves loop logs to the saved-telemetry-pings folder.
   *
   * @param {Object} pc The peerConnection in question.
   */
  stageForTelemetryUpload: function(window, pc) {
    window.WebrtcGlobalInformation.getAllStats(allStats => {
      let internalFormat = allStats.reports[0]; // filtered on pc.id
      window.WebrtcGlobalInformation.getLogging('', logs => {
        let report = convertToRTCStatsReport(internalFormat);
        let logStr = "";
        logs.forEach(s => { logStr += s + "\n"; });

        // We have stats and logs.

        // Create worker job. ping = saved telemetry ping file header + payload
        //
        // Prepare payload according to https://wiki.mozilla.org/Loop/Telemetry

        let ai = Services.appinfo;
        let uuid = uuidgen.generateUUID().toString();
        uuid = uuid.substr(1,uuid.length-2); // remove uuid curly braces

        let directory = OS.Path.join(OS.Constants.Path.profileDir,
                                     "saved-telemetry-pings");
        let job = {
          directory: directory,
          filename: uuid + ".json",
          ping: {
            reason: "loop",
            slug: uuid,
            payload: {
              ver: 1,
              info: {
                appUpdateChannel: ai.defaultUpdateChannel,
                appBuildID: ai.appBuildID,
                appName: ai.name,
                appVersion: ai.version,
                reason: "loop",
                OS: ai.OS,
                version: Services.sysinfo.getProperty("version")
              },
              report: "ice failure",
              connectionstate: pc.iceConnectionState,
              stats: report,
              localSdp: internalFormat.localSdp,
              remoteSdp: internalFormat.remoteSdp,
              log: logStr
            }
          }
        };

        // Send job to worker to do log sanitation, transcoding and saving to
        // disk for pickup by telemetry on next startup, which then uploads it.

        let worker = new ChromeWorker("MozLoopWorker.js");
        worker.onmessage = function(e) {
          console.log(e.data.ok ?
            "Successfully staged loop report for telemetry upload." :
            ("Failed to stage loop report. Error: " + e.data.fail));
        }
        worker.postMessage(job);
      });
    }, pc.id);
  },

  /**
   * Opens the chat window
   *
   * @param {Object} contentWindow The window to open the chat window in, may
   *                               be null.
   * @param {String} title The title of the chat window.
   * @param {String} url The page to load in the chat window.
   */
  openChatWindow: function(contentWindow, title, url) {
    // So I guess the origin is the loop server!?
    let origin = this.loopServerUri;
    url = url.spec || url;

    let callback = chatbox => {
      // We need to use DOMContentLoaded as otherwise the injection will happen
      // in about:blank and then get lost.
      // Sadly we can't use chatbox.promiseChatLoaded() as promise chaining
      // involves event loop spins, which means it might be too late.
      // Have we already done it?
      if (chatbox.contentWindow.navigator.mozLoop) {
        return;
      }

      chatbox.setAttribute("dark", true);

      chatbox.addEventListener("DOMContentLoaded", function loaded(event) {
        if (event.target != chatbox.contentDocument) {
          return;
        }
        chatbox.removeEventListener("DOMContentLoaded", loaded, true);

        let window = chatbox.contentWindow;
        injectLoopAPI(window);

        let ourID = window.QueryInterface(Ci.nsIInterfaceRequestor)
            .getInterface(Ci.nsIDOMWindowUtils).currentInnerWindowID;

        let onPCLifecycleChange = (pc, winID, type) => {
          if (winID != ourID) {
            return;
          }
          if (type == "iceconnectionstatechange") {
            switch(pc.iceConnectionState) {
              case "failed":
              case "disconnected":
                if (Services.telemetry.canSend ||
                    Services.prefs.getBoolPref("toolkit.telemetry.test")) {
                  this.stageForTelemetryUpload(window, pc);
                }
                break;
            }
          }
        };

        let pc_static = new window.mozRTCPeerConnectionStatic();
        pc_static.registerPeerConnectionLifecycleCallback(onPCLifecycleChange);
      }.bind(this), true);
    };

    Chat.open(contentWindow, origin, title, url, undefined, undefined, callback);
  },

  /**
   * Fetch Firefox Accounts (FxA) OAuth parameters from the Loop Server.
   *
   * @return {Promise} resolved with the body of the hawk request for OAuth parameters.
   */
  promiseFxAOAuthParameters: function() {
    const SESSION_TYPE = LOOP_SESSION_TYPE.FXA;
    return this.hawkRequest(SESSION_TYPE, "/fxa-oauth/params", "POST").then(response => {
      if (!this.storeSessionToken(SESSION_TYPE, response.headers)) {
        throw new Error("Invalid FxA hawk token returned");
      }
      let prefType = Services.prefs.getPrefType(this.getSessionTokenPrefName(SESSION_TYPE));
      if (prefType == Services.prefs.PREF_INVALID) {
        throw new Error("No FxA hawk token returned and we don't have one saved");
      }

      return JSON.parse(response.body);
    });
  },

  /**
   * Get the OAuth client constructed with Loop OAauth parameters.
   *
   * @return {Promise}
   */
  promiseFxAOAuthClient: Task.async(function* () {
    // We must make sure to have only a single client otherwise they will have different states and
    // multiple channels. This would happen if the user clicks the Login button more than once.
    if (gFxAOAuthClientPromise) {
      return gFxAOAuthClientPromise;
    }

    gFxAOAuthClientPromise = this.promiseFxAOAuthParameters().then(
      parameters => {
        try {
          gFxAOAuthClient = new FxAccountsOAuthClient({
            parameters: parameters,
          });
        } catch (ex) {
          gFxAOAuthClientPromise = null;
          throw ex;
        }
        return gFxAOAuthClient;
      },
      error => {
        gFxAOAuthClientPromise = null;
        throw error;
      }
    );

    return gFxAOAuthClientPromise;
  }),

  /**
   * Get the OAuth client and do the authorization web flow to get an OAuth code.
   *
   * @return {Promise}
   */
  promiseFxAOAuthAuthorization: function() {
    let deferred = Promise.defer();
    this.promiseFxAOAuthClient().then(
      client => {
        client.onComplete = this._fxAOAuthComplete.bind(this, deferred);
        client.launchWebFlow();
      },
      error => {
        console.error(error);
        deferred.reject(error);
      }
    );
    return deferred.promise;
  },

  /**
   * Get the OAuth token using the OAuth code and state.
   *
   * The caller should approperiately handle 4xx errors (which should lead to a logout)
   * and 5xx or connectivity issues with messaging to try again later.
   *
   * @param {String} code
   * @param {String} state
   *
   * @return {Promise} resolving with OAuth token data.
   */
  promiseFxAOAuthToken: function(code, state) {
    if (!code || !state) {
      throw new Error("promiseFxAOAuthToken: code and state are required.");
    }

    let payload = {
      code: code,
      state: state,
    };
    return this.hawkRequest(LOOP_SESSION_TYPE.FXA, "/fxa-oauth/token", "POST", payload).then(response => {
      return JSON.parse(response.body);
    });
  },

  /**
   * Called once gFxAOAuthClient fires onComplete.
   *
   * @param {Deferred} deferred used to resolve or reject the gFxAOAuthClientPromise
   * @param {Object} result (with code and state)
   */
  _fxAOAuthComplete: function(deferred, result) {
    gFxAOAuthClientPromise = null;

    // Note: The state was already verified in FxAccountsOAuthClient.
    if (result) {
      deferred.resolve(result);
    } else {
      deferred.reject("Invalid token data");
    }
  },
};
Object.freeze(MozLoopServiceInternal);

let gInitializeTimerFunc = () => {
  // Kick off the push notification service into registering after a timeout
  // this ensures we're not doing too much straight after the browser's finished
  // starting up.
  gInitializeTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  gInitializeTimer.initWithCallback(() => {
    MozLoopService.register();
    gInitializeTimer = null;
  },
  MozLoopServiceInternal.initialRegistrationDelayMilliseconds, Ci.nsITimer.TYPE_ONE_SHOT);
};

/**
 * Public API
 */
this.MozLoopService = {
  _DNSService: gDNSService,

  set initializeTimerFunc(value) {
    gInitializeTimerFunc = value;
  },

  /**
   * Initialized the loop service, and starts registration with the
   * push and loop servers.
   */
  initialize: function() {
    // Don't do anything if loop is not enabled.
    if (!Services.prefs.getBoolPref("loop.enabled") ||
        Services.prefs.getBoolPref("loop.throttled")) {
      return;
    }

    // If expiresTime is in the future then kick-off registration.
    if (MozLoopServiceInternal.urlExpiryTimeIsInFuture()) {
      gInitializeTimerFunc();
    }
  },

  /**
   * If we're operating the service in "soft start" mode, and this browser
   * isn't already activated, check whether it's time for it to become active.
   * If so, activate the loop service.
   *
   * @param {Object} buttonNode DOM node representing the Loop button -- if we
   *                            change from inactive to active, we need this
   *                            in order to unhide the Loop button.
   * @param {Function} doneCb   [optional] Callback that is called when the
   *                            check has completed.
   */
  checkSoftStart(buttonNode, doneCb) {
    if (!Services.prefs.getBoolPref("loop.throttled")) {
      if (typeof(doneCb) == "function") {
        doneCb(new Error("Throttling is not active"));
      }
      return;
    }

    if (Services.io.offline) {
      if (typeof(doneCb) == "function") {
        doneCb(new Error("Cannot check soft-start value: browser is offline"));
      }
      return;
    }

    let ticket = Services.prefs.getIntPref("loop.soft_start_ticket_number");
    if (!ticket || ticket > MAX_SOFT_START_TICKET_NUMBER || ticket < 0) {
      // Ticket value isn't valid (probably isn't set up yet) -- pick a random
      // number from 1 to MAX_SOFT_START_TICKET_NUMBER, inclusive, and write it
      // into prefs.
      ticket = Math.floor(Math.random() * MAX_SOFT_START_TICKET_NUMBER) + 1;
      // Floating point numbers can be imprecise, so we need to deal with
      // the case that Math.random() effectively rounds to 1.0
      if (ticket > MAX_SOFT_START_TICKET_NUMBER) {
        ticket = MAX_SOFT_START_TICKET_NUMBER;
      }
      Services.prefs.setIntPref("loop.soft_start_ticket_number", ticket);
    }

    let onLookupComplete = (request, record, status) => {
      // We don't bother checking errors -- if the DNS query fails,
      // we just don't activate this time around. We'll check again on
      // next startup.
      if (!Components.isSuccessCode(status)) {
        if (typeof(doneCb) == "function") {
          doneCb(new Error("Error in DNS Lookup: " + status));
        }
        return;
      }

      let address = record.getNextAddrAsString().split(".");
      if (address.length != 4) {
        if (typeof(doneCb) == "function") {
          doneCb(new Error("Invalid IP address"));
        }
        return;
      }

      if (address[0] != 127) {
        if (typeof(doneCb) == "function") {
          doneCb(new Error("Throttling IP address is not on localhost subnet"));
        }
        return
      }

      // Can't use bitwise operations here because JS treats all bitwise
      // operations as 32-bit *signed* integers.
      let now_serving = ((parseInt(address[1]) * 0x10000) +
                         (parseInt(address[2]) * 0x100) +
                         parseInt(address[3]));

      if (now_serving > ticket) {
        // Hot diggity! It's our turn! Activate the service.
        console.log("MozLoopService: Activating Loop via soft-start");
        Services.prefs.setBoolPref("loop.throttled", false);
        buttonNode.hidden = false;
        this.initialize();
      }
      if (typeof(doneCb) == "function") {
        doneCb(null);
      }
    };

    // We use DNS to propagate the slow-start value, since it has well-known
    // scaling properties. Ideally, this would use something more semantic,
    // like a TXT record; but we don't support TXT in our DNS resolution (see
    // Bug 14328), so we instead treat the lowest 24 bits of the IP address
    // corresponding to our "slow start DNS name" as a 24-bit integer. To
    // ensure that these addresses aren't routable, the highest 8 bits must
    // be "127" (reserved for localhost).
    let host = Services.prefs.getCharPref("loop.soft_start_hostname");
    let task = this._DNSService.asyncResolve(host,
                                             this._DNSService.RESOLVE_DISABLE_IPV6,
                                             onLookupComplete,
                                             Services.tm.mainThread);
  },


  /**
   * Starts registration of Loop with the push server, and then will register
   * with the Loop server. It will return early if already registered.
   *
   * @param {Object} mockPushHandler Optional, test-only mock push handler. Used
   *                                 to allow mocking of the MozLoopPushHandler.
   * @returns {Promise} a promise that is resolved with no params on completion, or
   *          rejected with an error code or string.
   */
  register: function(mockPushHandler) {
    // Don't do anything if loop is not enabled.
    if (!Services.prefs.getBoolPref("loop.enabled")) {
      throw new Error("Loop is not enabled");
    }

    if (Services.prefs.getBoolPref("loop.throttled")) {
      throw new Error("Loop is disabled by the soft-start mechanism");
    }

    return MozLoopServiceInternal.promiseRegisteredWithServers(mockPushHandler);
  },

  /**
   * Used to note a call url expiry time. If the time is later than the current
   * latest expiry time, then the stored expiry time is increased. For times
   * sooner, this function is a no-op; this ensures we always have the latest
   * expiry time for a url.
   *
   * This is used to deterimine whether or not we should be registering with the
   * push server on start.
   *
   * @param {Integer} expiryTimeSeconds The seconds since epoch of the expiry time
   *                                    of the url.
   */
  noteCallUrlExpiry: function(expiryTimeSeconds) {
    MozLoopServiceInternal.expiryTimeSeconds = expiryTimeSeconds;
  },

  /**
   * Returns the strings for the specified element. Designed for use
   * with l10n.js.
   *
   * @param {key} The element id to get strings for.
   * @return {String} A JSON string containing the localized
   *                  attribute/value pairs for the element.
   */
  getStrings: function(key) {
      var stringData = MozLoopServiceInternal.localizedStrings;
      if (!(key in stringData)) {
        Cu.reportError('No string for key: ' + key + 'found');
        return "";
      }

      return JSON.stringify(stringData[key]);
  },

  /**
   * Retrieves MozLoopService "do not disturb" value.
   *
   * @return {Boolean}
   */
  get doNotDisturb() {
    return MozLoopServiceInternal.doNotDisturb;
  },

  /**
   * Sets MozLoopService "do not disturb" value.
   *
   * @param {Boolean} aFlag
   */
  set doNotDisturb(aFlag) {
    MozLoopServiceInternal.doNotDisturb = aFlag;
  },

  get errors() {
    return MozLoopServiceInternal.errors;
  },

  /**
   * Returns the current locale
   *
   * @return {String} The code of the current locale.
   */
  get locale() {
    try {
      return Services.prefs.getComplexValue("general.useragent.locale",
        Ci.nsISupportsString).data;
    } catch (ex) {
      return "en-US";
    }
  },

  /**
   * Returns the callData for a specific callDataId
   *
   * The data was retrieved from the LoopServer via a GET/calls/<version> request
   * triggered by an incoming message from the LoopPushServer.
   *
   * @param {int} loopCallId
   * @return {callData} The callData or undefined if error.
   */
  getCallData: function(loopCallId) {
    return MozLoopServiceInternal.callsData.data;
  },

  /**
   * Set any character preference under "loop.".
   *
   * @param {String} prefName The name of the pref without the preceding "loop."
   * @param {String} value The value to set.
   *
   * Any errors thrown by the Mozilla pref API are logged to the console.
   */
  setLoopCharPref: function(prefName, value) {
    try {
      Services.prefs.setCharPref("loop." + prefName, value);
    } catch (ex) {
      console.log("setLoopCharPref had trouble setting " + prefName +
        "; exception: " + ex);
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
  getLoopCharPref: function(prefName) {
    try {
      return Services.prefs.getCharPref("loop." + prefName);
    } catch (ex) {
      console.log("getLoopCharPref had trouble getting " + prefName +
        "; exception: " + ex);
      return null;
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
  getLoopBoolPref: function(prefName) {
    try {
      return Services.prefs.getBoolPref("loop." + prefName);
    } catch (ex) {
      console.log("getLoopBoolPref had trouble getting " + prefName +
        "; exception: " + ex);
      return null;
    }
  },

  /**
   * Start the FxA login flow using the OAuth client and params from the Loop server.
   *
   * The caller should be prepared to handle rejections related to network, server or login errors.
   *
   * @return {Promise} that resolves when the FxA login flow is complete.
   */
  logInToFxA: function() {
    if (gFxAOAuthTokenData) {
      return Promise.resolve(gFxAOAuthTokenData);
    }

    return MozLoopServiceInternal.promiseFxAOAuthAuthorization().then(response => {
      return MozLoopServiceInternal.promiseFxAOAuthToken(response.code, response.state);
    }).then(tokenData => {
      gFxAOAuthTokenData = tokenData;
      return tokenData;
    }).then(tokenData => {
      return gRegisteredDeferred.promise.then(Task.async(function*() {
        if (gPushHandler.pushUrl) {
          yield MozLoopServiceInternal.registerWithLoopServer(LOOP_SESSION_TYPE.FXA, gPushHandler.pushUrl);
        } else {
          throw new Error("No pushUrl for FxA registration");
        }
        return gFxAOAuthTokenData;
      }));
    },
    error => {
      gFxAOAuthTokenData = null;
      throw error;
    });
  },

  /**
   * Performs a hawk based request to the loop server.
   *
   * @param {LOOP_SESSION_TYPE} sessionType The type of session to use for the request.
   *                                        One of the LOOP_SESSION_TYPE members.
   * @param {String} path The path to make the request to.
   * @param {String} method The request method, e.g. 'POST', 'GET'.
   * @param {Object} payloadObj An object which is converted to JSON and
   *                            transmitted with the request.
   * @returns {Promise}
   *        Returns a promise that resolves to the response of the API call,
   *        or is rejected with an error.  If the server response can be parsed
   *        as JSON and contains an 'error' property, the promise will be
   *        rejected with this JSON-parsed response.
   */
  hawkRequest: function(sessionType, path, method, payloadObj) {
    return MozLoopServiceInternal.hawkRequest(sessionType, path, method, payloadObj);
  },
};
Object.freeze(this.MozLoopService);
