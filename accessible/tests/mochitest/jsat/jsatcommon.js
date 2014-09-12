// A common module to run tests on the AccessFu module

'use strict';

/*global isDeeply, getMainChromeWindow, SimpleTest, SpecialPowers, Logger,
  AccessFu, Utils, addMessageListener, currentTabDocument, currentBrowser*/

/**
  * A global variable holding an array of test functions.
  */
var gTestFuncs = [];
/**
  * A global Iterator for the array of test functions.
  */
var gIterator;

Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import("resource://gre/modules/accessibility/Utils.jsm");
Components.utils.import("resource://gre/modules/accessibility/EventManager.jsm");
Components.utils.import("resource://gre/modules/accessibility/Gestures.jsm");

const dwellThreshold = GestureSettings.dwellThreshold;
const swipeMaxDuration = GestureSettings.swipeMaxDuration;
const maxConsecutiveGestureDelay = GestureSettings.maxConsecutiveGestureDelay;

// https://bugzilla.mozilla.org/show_bug.cgi?id=1001945 - sometimes
// SimpleTest.executeSoon timeout is bigger than the timer settings in
// GestureSettings that causes intermittents.
GestureSettings.dwellThreshold = dwellThreshold * 10;
GestureSettings.swipeMaxDuration = swipeMaxDuration * 10;
GestureSettings.maxConsecutiveGestureDelay = maxConsecutiveGestureDelay * 10;

var AccessFuTest = {

  addFunc: function AccessFuTest_addFunc(aFunc) {
    if (aFunc) {
      gTestFuncs.push(aFunc);
    }
  },

  _registerListener: function AccessFuTest__registerListener(aWaitForMessage, aListenerFunc) {
    var listener = {
      observe: function observe(aMessage) {
        // Ignore unexpected messages.
        if (!(aMessage instanceof Components.interfaces.nsIConsoleMessage)) {
          return;
        }
        if (aMessage.message.indexOf(aWaitForMessage) < 0) {
          return;
        }
        aListenerFunc.apply(listener);
      }
    };
    Services.console.registerListener(listener);
    return listener;
  },

  on_log: function AccessFuTest_on_log(aWaitForMessage, aListenerFunc) {
    return this._registerListener(aWaitForMessage, aListenerFunc);
  },

  off_log: function AccessFuTest_off_log(aListener) {
    Services.console.unregisterListener(aListener);
  },

  once_log: function AccessFuTest_once_log(aWaitForMessage, aListenerFunc) {
    return this._registerListener(aWaitForMessage,
      function listenAndUnregister() {
        Services.console.unregisterListener(this);
        aListenerFunc();
      });
  },

  _addObserver: function AccessFuTest__addObserver(aWaitForData, aListener) {
    var listener = function listener(aSubject, aTopic, aData) {
      var data = JSON.parse(aData)[1];
      // Ignore non-relevant outputs.
      if (!data) {
        return;
      }
      isDeeply(data.details, aWaitForData, "Data is correct");
      aListener.apply(listener);
    };
    Services.obs.addObserver(listener, 'accessibility-output', false);
    return listener;
  },

  on: function AccessFuTest_on(aWaitForData, aListener) {
    return this._addObserver(aWaitForData, aListener);
  },

  off: function AccessFuTest_off(aListener) {
    Services.obs.removeObserver(aListener, 'accessibility-output');
  },

  once: function AccessFuTest_once(aWaitForData, aListener) {
    return this._addObserver(aWaitForData, function observerAndRemove() {
      Services.obs.removeObserver(this, 'accessibility-output');
      aListener();
    });
  },

  _waitForExplicitFinish: false,

  waitForExplicitFinish: function AccessFuTest_waitForExplicitFinish() {
    this._waitForExplicitFinish = true;
  },

  finish: function AccessFuTest_finish() {
    // Disable the console service logging.
    Logger.test = false;
    Logger.logLevel = Logger.INFO;
    // Reset Gesture Settings.
    GestureSettings.dwellThreshold = dwellThreshold;
    GestureSettings.swipeMaxDuration = swipeMaxDuration;
    GestureSettings.maxConsecutiveGestureDelay = maxConsecutiveGestureDelay;
    // Finish through idle callback to let AccessFu._disable complete.
    SimpleTest.executeSoon(function () {
      AccessFu.detach();
      SimpleTest.finish();
    });
  },

  nextTest: function AccessFuTest_nextTest() {
    var testFunc;
    try {
      // Get the next test function from the iterator. If none left,
      // StopIteration exception is thrown.
      testFunc = gIterator.next()[1];
    } catch (ex) {
      // StopIteration exception.
      this.finish();
      return;
    }
    testFunc();
  },

  runTests: function AccessFuTest_runTests() {
    if (gTestFuncs.length === 0) {
      ok(false, "No tests specified!");
      SimpleTest.finish();
      return;
    }

    // Create an Iterator for gTestFuncs array.
    gIterator = Iterator(gTestFuncs); // jshint ignore:line

    // Start AccessFu and put it in stand-by.
    Components.utils.import("resource://gre/modules/accessibility/AccessFu.jsm");

    AccessFu.attach(getMainChromeWindow(window));

    AccessFu.readyCallback = function readyCallback() {
      // Enable logging to the console service.
      Logger.test = true;
      Logger.logLevel = Logger.DEBUG;
    };

    SpecialPowers.pushPrefEnv({
      'set': [['accessibility.accessfu.notify_output', 1],
              ['dom.mozSettings.enabled', true]]
    }, function () {
      if (AccessFuTest._waitForExplicitFinish) {
        // Run all test functions asynchronously.
        AccessFuTest.nextTest();
      } else {
        // Run all test functions synchronously.
        [testFunc() for (testFunc of gTestFuncs)]; // jshint ignore:line
        AccessFuTest.finish();
      }
    });
  }
};

function AccessFuContentTest(aFuncResultPairs) {
  this.queue = aFuncResultPairs;
}

AccessFuContentTest.prototype = {
  expected: [],
  currentAction: null,

  start: function(aFinishedCallback) {
    Logger.logLevel = Logger.DEBUG;
    this.finishedCallback = aFinishedCallback;
    var self = this;

    // Get top content message manager, and set it up.
    this.mms = [Utils.getMessageManager(currentBrowser())];
    this.setupMessageManager(this.mms[0], function () {
      // Get child message managers and set them up
      var frames = currentTabDocument().querySelectorAll('iframe');
      if (frames.length === 0) {
        self.pump();
        return;
      }

      var toSetup = 0;
      for (var i = 0; i < frames.length; i++ ) {
        var mm = Utils.getMessageManager(frames[i]);
        if (mm) {
          toSetup++;
          self.mms.push(mm);
          self.setupMessageManager(mm, function () {
            if (--toSetup === 0) {
              // All message managers are loaded and ready to go.
              self.pump();
            }
          });
        }
      }
    });
  },

  finish: function() {
    Logger.logLevel = Logger.INFO;
    for (var mm of this.mms) {
        mm.sendAsyncMessage('AccessFu:Stop');
      }
    if (this.finishedCallback) {
      this.finishedCallback();
    }
  },

  setupMessageManager:  function (aMessageManager, aCallback) {
    function contentScript() {
      addMessageListener('AccessFuTest:Focus', function (aMessage) {
        var elem = content.document.querySelector(aMessage.json.selector);
        if (elem) {
          if (aMessage.json.blur) {
            elem.blur();
          } else {
            elem.focus();
          }
        }
      });
    }

    aMessageManager.addMessageListener('AccessFu:Present', this);
    aMessageManager.addMessageListener('AccessFu:Input', this);
    aMessageManager.addMessageListener('AccessFu:CursorCleared', this);
    aMessageManager.addMessageListener('AccessFu:Ready', function () {
      aMessageManager.addMessageListener('AccessFu:ContentStarted', aCallback);
      aMessageManager.sendAsyncMessage('AccessFu:Start',
        { buildApp: 'browser',
          androidSdkVersion: Utils.AndroidSdkVersion,
          logLevel: 'DEBUG' });
    });

    aMessageManager.loadFrameScript(
      'chrome://global/content/accessibility/content-script.js', false);
    aMessageManager.loadFrameScript(
      'data:,(' + contentScript.toString() + ')();', false);
  },

  pump: function() {
    this.expected.shift();
    if (this.expected.length) {
      return;
    }

    var currentPair = this.queue.shift();

    if (currentPair) {
      this.currentAction = currentPair[0];
      if (typeof this.currentAction === 'function') {
        this.currentAction(this.mms[0]);
      } else if (this.currentAction) {
        this.mms[0].sendAsyncMessage(this.currentAction.name,
         this.currentAction.json);
      }

      this.expected = currentPair.slice(1, currentPair.length);

      if (!this.expected[0]) {
       this.pump();
     }
    } else {
      this.finish();
    }
  },

  receiveMessage: function(aMessage) {
    var expected = this.expected[0];

    if (!expected) {
      return;
    }

    // |expected| can simply be a name of a message, no more further testing.
    if (aMessage.name === expected) {
      ok(true, 'Received ' + expected);
      this.pump();
      return;
    }

    var editState = this.extractEditeState(aMessage);
    var speech = this.extractUtterance(aMessage);
    var android = this.extractAndroid(aMessage, expected.android);
    if ((speech && expected.speak)
        || (android && expected.android)
        || (editState && expected.editState)) {
      if (expected.speak) {
        var checkFunc = SimpleTest[expected.speak_checkFunc] || isDeeply;
        checkFunc.apply(SimpleTest, [speech, expected.speak,
          'spoken: ' + JSON.stringify(speech) +
          ' expected: ' + JSON.stringify(expected.speak) +
          ' after: ' + (typeof this.currentAction === 'function' ?
            this.currentAction.toString() :
            JSON.stringify(this.currentAction))]);
      }

      if (expected.android) {
        var checkFunc = SimpleTest[expected.android_checkFunc] || ok;
        checkFunc.apply(SimpleTest,
          this.lazyCompare(android, expected.android));
      }

      if (expected.editState) {
        var checkFunc = SimpleTest[expected.editState_checkFunc] || isDeeply;
        checkFunc.apply(SimpleTest, [editState, expected.editState,
          'editState: ' + JSON.stringify(editState) +
          ' expected: ' + JSON.stringify(expected.editState) +
          ' after: ' + (typeof this.currentAction === 'function' ?
            this.currentAction.toString() :
            JSON.stringify(this.currentAction))]);
      }

      if (expected.focused) {
        var doc = currentTabDocument();
        is(doc.activeElement, doc.querySelector(expected.focused),
          'Correct element is focused: ' + expected.focused);
      }

      this.pump();
    }

  },

  lazyCompare: function lazyCompare(aReceived, aExpected) {
    var matches = true;
    var delta = [];
    for (var attr in aExpected) {
      var expected = aExpected[attr];
      var received = aReceived !== undefined ? aReceived[attr] : null;
      if (typeof expected === 'object') {
        var [childMatches, childDelta] = this.lazyCompare(received, expected);
        if (!childMatches) {
          delta.push(attr + ' [ ' + childDelta + ' ]');
          matches = false;
        }
      } else {
        if (received !== expected) {
          delta.push(
            attr + ' [ expected ' + expected + ' got ' + received + ' ]');
          matches = false;
        }
      }
    }
    return [matches, delta.join(' ')];
  },

  extractEditeState: function(aMessage) {
    if (!aMessage || aMessage.name !== 'AccessFu:Input') {
      return null;
    }

    return aMessage.json;
  },

  extractUtterance: function(aMessage) {
    if (!aMessage || aMessage.name !== 'AccessFu:Present') {
      return null;
    }

    for (var output of aMessage.json) {
      if (output && output.type === 'B2G') {
        if (output.details && output.details.data[0].string !== 'clickAction') {
          return output.details.data;
        }
      }
    }

    return null;
  },

  extractAndroid: function(aMessage, aExpectedEvents) {
    if (!aMessage || aMessage.name !== 'AccessFu:Present') {
      return null;
    }

    for (var output of aMessage.json) {
      if (output && output.type === 'Android') {
        for (var i in output.details) {
          // Only extract if event types match expected event types.
          var exp = aExpectedEvents ? aExpectedEvents[i] : null;
          if (!exp || (output.details[i].eventType !== exp.eventType)) {
            return null;
          }
        }
        return output.details;
      }
    }

    return null;
  }
};

// Common content messages

var ContentMessages = {
  simpleMoveFirst: {
    name: 'AccessFu:MoveCursor',
    json: {
      action: 'moveFirst',
      rule: 'Simple',
      inputType: 'gesture',
      origin: 'top'
    }
  },

  simpleMoveLast: {
    name: 'AccessFu:MoveCursor',
    json: {
      action: 'moveLast',
      rule: 'Simple',
      inputType: 'gesture',
      origin: 'top'
    }
  },

  simpleMoveNext: {
    name: 'AccessFu:MoveCursor',
    json: {
      action: 'moveNext',
      rule: 'Simple',
      inputType: 'gesture',
      origin: 'top'
    }
  },

  simpleMovePrevious: {
    name: 'AccessFu:MoveCursor',
    json: {
      action: 'movePrevious',
      rule: 'Simple',
      inputType: 'gesture',
      origin: 'top'
    }
  },

  clearCursor: {
    name: 'AccessFu:ClearCursor',
    json: {
      origin: 'top'
    }
  },

  adjustRangeUp: {
    name: 'AccessFu:AdjustRange',
    json: {
      origin: 'top',
      direction: 'backward'
    }
  },

  adjustRangeDown: {
    name: 'AccessFu:AdjustRange',
    json: {
      origin: 'top',
      direction: 'forward'
    }
  },

  focusSelector: function focusSelector(aSelector, aBlur) {
    return {
      name: 'AccessFuTest:Focus',
      json: {
        selector: aSelector,
        blur: aBlur
      }
    };
  },

  activateCurrent: function activateCurrent(aOffset) {
    return {
      name: 'AccessFu:Activate',
      json: {
        origin: 'top',
        offset: aOffset
      }
    };
  },

  moveNextBy: function moveNextBy(aGranularity) {
    return {
      name: 'AccessFu:MoveByGranularity',
      json: {
        direction: 'Next',
        granularity: this._granularityMap[aGranularity]
      }
    };
  },

  movePreviousBy: function movePreviousBy(aGranularity) {
    return {
      name: 'AccessFu:MoveByGranularity',
      json: {
        direction: 'Previous',
        granularity: this._granularityMap[aGranularity]
      }
    };
  },

  moveCaretNextBy: function moveCaretNextBy(aGranularity) {
    return {
      name: 'AccessFu:MoveCaret',
      json: {
        direction: 'Next',
        granularity: this._granularityMap[aGranularity]
      }
    };
  },

  moveCaretPreviousBy: function moveCaretPreviousBy(aGranularity) {
    return {
      name: 'AccessFu:MoveCaret',
      json: {
        direction: 'Previous',
        granularity: this._granularityMap[aGranularity]
      }
    };
  },

  _granularityMap: {
    'character': 1, // MOVEMENT_GRANULARITY_CHARACTER
    'word': 2, // MOVEMENT_GRANULARITY_WORD
    'paragraph': 8 // MOVEMENT_GRANULARITY_PARAGRAPH
  }
};

var AndroidEvent = {
  VIEW_CLICKED: 0x01,
  VIEW_LONG_CLICKED: 0x02,
  VIEW_SELECTED: 0x04,
  VIEW_FOCUSED: 0x08,
  VIEW_TEXT_CHANGED: 0x10,
  WINDOW_STATE_CHANGED: 0x20,
  VIEW_HOVER_ENTER: 0x80,
  VIEW_HOVER_EXIT: 0x100,
  VIEW_SCROLLED: 0x1000,
  VIEW_TEXT_SELECTION_CHANGED: 0x2000,
  ANNOUNCEMENT: 0x4000,
  VIEW_ACCESSIBILITY_FOCUSED: 0x8000,
  VIEW_TEXT_TRAVERSED_AT_MOVEMENT_GRANULARITY: 0x20000
};
