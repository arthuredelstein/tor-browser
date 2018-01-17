// Copyright (c) 2018, The Tor Project, Inc.
// See LICENSE for licensing information.
//
// vim: set sw=2 sts=2 ts=8 et syntax=javascript:

"use strict";

var Cc = Components.classes;
var Ci = Components.interfaces;
var Cu = Components.utils;

this.EXPORTED_SYMBOLS = [ "AboutTBUpdate" ];

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");

const kRequestUpdateMessageName = "AboutTBUpdate:RequestUpdate";
const kSendUpdateMessageName    = "AboutTBUpdate:Update";

#ifdef TOR_BROWSER_VERSION
#expand const TOR_BROWSER_VERSION = __TOR_BROWSER_VERSION__;
#endif

/**
 * This code provides services to the about:tbupdate page. Whenever
 * about:tbupdate needs to do something chrome-privileged, it sends a
 * message that's handled here. It is modeled after Mozilla's about:home
 * implementation.
 */
var AboutTBUpdate = {
  init: function() {
    let mm = Cc["@mozilla.org/globalmessagemanager;1"]
               .getService(Ci.nsIMessageListenerManager);
    mm.addMessageListener(kRequestUpdateMessageName, this);
  },

  receiveMessage: function(aMessage) {
    if (aMessage.name == kRequestUpdateMessageName)
      this.sendAboutTBUpdateData(aMessage.target);
  },

  sendAboutTBUpdateData: function(aTarget) {
    let data = { productInfo: this.productInfo,
                 moreInfoURL: this.moreInfoURL,
                 changeLog: this.changeLog };

    if (aTarget && aTarget.messageManager) {
      aTarget.messageManager.sendAsyncMessage(kSendUpdateMessageName, data);
    } else {
      let mm = Cc["@mozilla.org/globalmessagemanager;1"]
                 .getService(Ci.nsIMessageListenerManager);
      mm.broadcastAsyncMessage(kSendUpdateMessageName, data);
    }
  },

  get productInfo() {
    const kBrandBundle = "chrome://branding/locale/brand.properties";
    let brandBundle = Cc["@mozilla.org/intl/stringbundle;1"]
                        .getService(Ci.nsIStringBundleService)
                        .createBundle(kBrandBundle);
    return brandBundle.GetStringFromName("brandFullName")
           + "\n" + TOR_BROWSER_VERSION;
  },

  get moreInfoURL() {
    try {
      return Services.prefs.getCharPref("torbrowser.post_update.url");
    } catch (e) {}

    // Use the default URL as a fallback.
    return Services.urlFormatter.formatURLPref("startup.homepage_override_url");
  },

  // Read and return the text from the beginning of the changelog file that is
  // located at TorBrowser/Docs/ChangeLog.txt.
  // On Mac OS, when building with --enable-tor-browser-data-outside-app-dir
  // to support Gatekeeper signing, the file is located in
  // TorBrowser.app/Contents/Resources/TorBrowser/Docs/.
  get changeLog() {
    try {
#ifdef TOR_BROWSER_DATA_OUTSIDE_APP_DIR
      // "XREExeF".parent is the directory that contains firefox, i.e.,
      // Browser/ or, on Mac OS, TorBrowser.app/Contents/MacOS/.
      let f = Services.dirsvc.get("XREExeF", Ci.nsIFile).parent;
#ifdef XP_MACOSX
      f = f.parent;
      f.append("Resources");
#endif
      f.append("TorBrowser");
#else
      // "DefProfRt" is .../TorBrowser/Data/Browser
      let f = Cc["@mozilla.org/file/directory_service;1"]
                .getService(Ci.nsIProperties).get("DefProfRt", Ci.nsIFile);
      f = f.parent.parent;  // Remove "Data/Browser"
#endif
      f.append("Docs");
      f.append("ChangeLog.txt");

      let fs = Cc["@mozilla.org/network/file-input-stream;1"]
                 .createInstance(Ci.nsIFileInputStream);
      fs.init(f, -1, 0, 0);
      let s = NetUtil.readInputStreamToString(fs, fs.available());
      fs.close();

      // Truncate at the first empty line.
      return s.replace(/[\r\n][\r\n][\s\S]*$/m, "");
    } catch (e) {}

    return "";
  },
};
