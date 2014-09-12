/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global loop, sinon, React, TestUtils */

var expect = chai.expect;

describe("loop.conversation", function() {
  "use strict";

  var ConversationRouter = loop.conversation.ConversationRouter,
      sandbox,
      notifications;

  beforeEach(function() {
    sandbox = sinon.sandbox.create();
    sandbox.useFakeTimers();
    notifications = new loop.shared.models.NotificationCollection();

    navigator.mozLoop = {
      doNotDisturb: true,
      get serverUrl() {
        return "http://example.com";
      },
      getStrings: function() {
        return JSON.stringify({textContent: "fakeText"});
      },
      get locale() {
        return "en-US";
      },
      setLoopCharPref: sandbox.stub(),
      getLoopCharPref: sandbox.stub(),
      getLoopBoolPref: sandbox.stub(),
      getCallData: sandbox.stub(),
      startAlerting: function() {},
      stopAlerting: function() {},
      ensureRegistered: function() {},
      get appVersionInfo() {
        return {
          version: "42",
          channel: "test",
          platform: "test"
        };
      }
    };

    // XXX These stubs should be hoisted in a common file
    // Bug 1040968
    document.mozL10n.initialize(navigator.mozLoop);
  });

  afterEach(function() {
    delete navigator.mozLoop;
    sandbox.restore();
  });

  describe("#init", function() {
    var oldTitle;

    beforeEach(function() {
      oldTitle = document.title;

      sandbox.stub(document.mozL10n, "initialize");
      sandbox.stub(document.mozL10n, "get").returns("Fake title");

      sandbox.stub(loop.conversation.ConversationRouter.prototype,
        "initialize");
      sandbox.stub(loop.shared.models.ConversationModel.prototype,
        "initialize");

      sandbox.stub(Backbone.history, "start");
    });

    afterEach(function() {
      document.title = oldTitle;
    });

    it("should initalize L10n", function() {
      loop.conversation.init();

      sinon.assert.calledOnce(document.mozL10n.initialize);
      sinon.assert.calledWithExactly(document.mozL10n.initialize,
        navigator.mozLoop);
    });

    it("should set the document title", function() {
      loop.conversation.init();

      expect(document.title).to.be.equal("Fake title");
    });

    it("should create the router", function() {
      loop.conversation.init();

      sinon.assert.calledOnce(
        loop.conversation.ConversationRouter.prototype.initialize);
    });

    it("should start Backbone history", function() {
      loop.conversation.init();

      sinon.assert.calledOnce(Backbone.history.start);
    });
  });

  describe("ConversationRouter", function() {
    var conversation, client;

    beforeEach(function() {
      client = new loop.Client();
      conversation = new loop.shared.models.ConversationModel({}, {
        sdk: {},
        pendingCallTimeout: 1000,
      });
      sandbox.spy(conversation, "setIncomingSessionData");
      sandbox.stub(conversation, "setOutgoingSessionData");
    });

    describe("Routes", function() {
      var router;

      beforeEach(function() {
        router = new ConversationRouter({
          client: client,
          conversation: conversation,
          notifications: notifications
        });
        sandbox.stub(conversation, "incoming");
      });

      describe("#incoming", function() {

        // XXX refactor to Just Work with "sandbox.stubComponent" or else
        // just pass in the sandbox and put somewhere generally usable

        function stubComponent(obj, component, mockTagName){
          var reactClass = React.createClass({
            render: function() {
              var mockTagName = mockTagName || "div";
              return React.DOM[mockTagName](null, this.props.children);
            }
          });
          return sandbox.stub(obj, component, reactClass);
        }

        beforeEach(function() {
          sandbox.stub(router, "loadReactComponent");
          stubComponent(loop.conversation, "IncomingCallView");
        });

        it("should start alerting", function() {
          sandbox.stub(navigator.mozLoop, "startAlerting");
          router.incoming("fakeVersion");

          sinon.assert.calledOnce(navigator.mozLoop.startAlerting);
        });

        it("should call getCallData on navigator.mozLoop",
          function() {
            router.incoming(42);

            sinon.assert.calledOnce(navigator.mozLoop.getCallData);
            sinon.assert.calledWith(navigator.mozLoop.getCallData, 42);
          });

        describe("getCallData successful", function() {
          var fakeSessionData, resolvePromise, rejectPromise;

          beforeEach(function() {
            fakeSessionData  = {
              sessionId:      "sessionId",
              sessionToken:   "sessionToken",
              apiKey:         "apiKey",
              callType:       "callType",
              callId:         "Hello",
              progressURL:    "http://progress.example.com",
              websocketToken: 123
            };

            sandbox.stub(router, "_setupWebSocketAndCallView");

            navigator.mozLoop.getCallData.returns(fakeSessionData);
          });

          it("should store the session data", function() {
            router.incoming("fakeVersion");

            sinon.assert.calledOnce(conversation.setIncomingSessionData);
            sinon.assert.calledWithExactly(conversation.setIncomingSessionData,
                                           fakeSessionData);
          });

          it("should call #_setupWebSocketAndCallView", function() {

            router.incoming("fakeVersion");

            sinon.assert.calledOnce(router._setupWebSocketAndCallView);
            sinon.assert.calledWithExactly(router._setupWebSocketAndCallView);
          });
        });

        describe("#_setupWebSocketAndCallView", function() {
          beforeEach(function() {
            conversation.setIncomingSessionData({
              sessionId:      "sessionId",
              sessionToken:   "sessionToken",
              apiKey:         "apiKey",
              callType:       "callType",
              callId:         "Hello",
              progressURL:    "http://progress.example.com",
              websocketToken: 123
            });
          });

          describe("Websocket connection successful", function() {
            var promise;

            beforeEach(function() {
              sandbox.stub(loop, "CallConnectionWebSocket").returns({
                promiseConnect: function() {
                  promise = new Promise(function(resolve, reject) {
                    resolve();
                  });
                  return promise;
                }
              });
            });

            it("should create a CallConnectionWebSocket", function(done) {
              router._setupWebSocketAndCallView();

              promise.then(function () {
                sinon.assert.calledOnce(loop.CallConnectionWebSocket);
                sinon.assert.calledWithExactly(loop.CallConnectionWebSocket, {
                  callId: "Hello",
                  url: "http://progress.example.com",
                  // The websocket token is converted to a hex string.
                  websocketToken: "7b"
                });
                done();
              });
            });

            it("should create the view with video.enabled=false", function(done) {
              sandbox.stub(conversation, "get").withArgs("callType").returns("audio");

              router._setupWebSocketAndCallView();

              promise.then(function () {
                sinon.assert.called(conversation.get);
                sinon.assert.calledOnce(loop.conversation.IncomingCallView);
                sinon.assert.calledWithExactly(loop.conversation.IncomingCallView,
                                               {model: conversation,
                                               video: {enabled: false}});
                done();
              });
            });
          });

          describe("Websocket connection failed", function() {
            var promise;

            beforeEach(function() {
              sandbox.stub(loop, "CallConnectionWebSocket").returns({
                promiseConnect: function() {
                  promise = new Promise(function(resolve, reject) {
                    reject();
                  });
                  return promise;
                }
              });
            });

            it("should display an error", function(done) {
              sandbox.stub(notifications, "errorL10n");
              router._setupWebSocketAndCallView();

              promise.then(function() {
              }, function () {
                sinon.assert.calledOnce(router._notifications.errorL10n);
                sinon.assert.calledWithExactly(router._notifications.errorL10n,
                  "cannot_start_call_session_not_ready");
                done();
              });
            });
          });
        });
      });

      describe("#accept", function() {
        beforeEach(function() {
          conversation.setIncomingSessionData({
            sessionId:      "sessionId",
            sessionToken:   "sessionToken",
            apiKey:         "apiKey",
            callType:       "callType",
            callId:         "Hello",
            progressURL:    "http://progress.example.com",
            websocketToken: 123
          });
          router._setupWebSocketAndCallView();

          sandbox.stub(router._websocket, "accept");
          sandbox.stub(navigator.mozLoop, "stopAlerting");
        });

        it("should initiate the conversation", function() {
          router.accept();

          sinon.assert.calledOnce(conversation.incoming);
        });

        it("should notify the websocket of the user acceptance", function() {
          router.accept();

          sinon.assert.calledOnce(router._websocket.accept);
        });

        it("should stop alerting", function() {
          router.accept();

          sinon.assert.calledOnce(navigator.mozLoop.stopAlerting);
        });
      });

      describe("#conversation", function() {
        beforeEach(function() {
          sandbox.stub(router, "loadReactComponent");
        });

        it("should load the ConversationView if session is set", function() {
          conversation.set("sessionId", "fakeSessionId");

          router.conversation();

          sinon.assert.calledOnce(router.loadReactComponent);
          sinon.assert.calledWith(router.loadReactComponent,
            sinon.match(function(value) {
              return TestUtils.isDescriptorOfType(value,
                loop.shared.views.ConversationView);
            }));
        });

        it("should not load the ConversationView if session is not set",
          function() {
            router.conversation();

            sinon.assert.notCalled(router.loadReactComponent);
        });

        it("should notify the user when session is not set",
          function() {
            sandbox.stub(notifications, "errorL10n");
            router.conversation();

            sinon.assert.calledOnce(router._notifications.errorL10n);
            sinon.assert.calledWithExactly(router._notifications.errorL10n,
              "cannot_start_call_session_not_ready");
        });
      });

      describe("#decline", function() {
        beforeEach(function() {
          sandbox.stub(window, "close");
          router._websocket = {
            decline: sandbox.spy()
          };
        });

        it("should close the window", function() {
          router.decline();
          sandbox.clock.tick(1);

          sinon.assert.calledOnce(window.close);
        });

        it("should stop alerting", function() {
          sandbox.stub(navigator.mozLoop, "stopAlerting");
          router.decline();

          sinon.assert.calledOnce(navigator.mozLoop.stopAlerting);
        });
      });

      describe("#feedback", function() {
        var oldTitle;

        beforeEach(function() {
          oldTitle = document.title;
          sandbox.stub(document.mozL10n, "get").returns("Call ended");
        });

        beforeEach(function() {
          sandbox.stub(loop, "FeedbackAPIClient");
          sandbox.stub(router, "loadReactComponent");
        });

        afterEach(function() {
          document.title = oldTitle;
        });

        // XXX When the call is ended gracefully, we should check that we
        // close connections nicely (see bug 1046744)
        it("should display a feedback form view", function() {
          router.feedback();

          sinon.assert.calledOnce(router.loadReactComponent);
          sinon.assert.calledWith(router.loadReactComponent,
            sinon.match(function(value) {
              return TestUtils.isDescriptorOfType(value,
                loop.shared.views.FeedbackView);
            }));
        });

        it("should update the conversation window title", function() {
          router.feedback();

          expect(document.title).eql("Call ended");
        });
      });

      describe("#blocked", function() {
        beforeEach(function() {
          router._websocket = {
            decline: sandbox.spy()
          };
          sandbox.stub(window, "close");
        });

        it("should call mozLoop.stopAlerting", function() {
          sandbox.stub(navigator.mozLoop, "stopAlerting");
          router.declineAndBlock();

          sinon.assert.calledOnce(navigator.mozLoop.stopAlerting);
        });

        it("should call delete call", function() {
          sandbox.stub(conversation, "get").withArgs("callToken")
                                           .returns("fakeToken");
          var deleteCallUrl = sandbox.stub(loop.Client.prototype,
                                           "deleteCallUrl");
          router.declineAndBlock();

          sinon.assert.calledOnce(deleteCallUrl);
          sinon.assert.calledWithExactly(deleteCallUrl, "fakeToken",
                                                        sinon.match.func);
        });

        it("should get callToken from conversation model", function() {
          sandbox.stub(conversation, "get");
          router.declineAndBlock();

          sinon.assert.calledOnce(conversation.get);
          sinon.assert.calledWithExactly(conversation.get, "callToken");
        });

        it("should trigger error handling in case of error", function() {
          // XXX just logging to console for now
          var log = sandbox.stub(console, "log");
          var fakeError = {
            error: true
          };
          sandbox.stub(loop.Client.prototype, "deleteCallUrl", function(_, cb) {
            cb(fakeError);
          });
          router.declineAndBlock();

          sinon.assert.calledOnce(log);
          sinon.assert.calledWithExactly(log, fakeError);
        });

        it("should close the window", function() {
          router.declineAndBlock();

          sandbox.clock.tick(1);

          sinon.assert.calledOnce(window.close);
        });
      });
    });

    describe("Events", function() {
      var router, fakeSessionData;

      beforeEach(function() {
        fakeSessionData = {
          sessionId:    "sessionId",
          sessionToken: "sessionToken",
          apiKey:       "apiKey"
        };
        sandbox.stub(loop.conversation.ConversationRouter.prototype,
                     "navigate");
        conversation.set("loopToken", "fakeToken");
        router = new loop.conversation.ConversationRouter({
          client: client,
          conversation: conversation,
          notifications: notifications
        });
      });

      it("should navigate to call/ongoing once the call is ready",
        function() {
          router.incoming(42);

          conversation.incoming();

          sinon.assert.calledOnce(router.navigate);
          sinon.assert.calledWith(router.navigate, "call/ongoing");
        });

      it("should navigate to call/feedback when the call session ends",
        function() {
          conversation.trigger("session:ended");

          sinon.assert.calledOnce(router.navigate);
          sinon.assert.calledWith(router.navigate, "call/feedback");
        });

      it("should navigate to call/feedback when peer hangs up", function() {
        conversation.trigger("session:peer-hungup");

        sinon.assert.calledOnce(router.navigate);
        sinon.assert.calledWith(router.navigate, "call/feedback");
      });

      it("should navigate to call/feedback when network disconnects",
        function() {
          conversation.trigger("session:network-disconnected");

          sinon.assert.calledOnce(router.navigate);
          sinon.assert.calledWith(router.navigate, "call/feedback");
        });

      describe("Published and Subscribed Streams", function() {
        beforeEach(function() {
          router._websocket = {
            mediaUp: sinon.spy()
          };
          router.incoming("fakeVersion");
        });

        describe("publishStream", function() {
          it("should not notify the websocket if only one stream is up",
            function() {
              conversation.set("publishedStream", true);

              sinon.assert.notCalled(router._websocket.mediaUp);
            });

          it("should notify the websocket that media is up if both streams" +
             "are connected", function() {
              conversation.set("subscribedStream", true);
              conversation.set("publishedStream", true);

              sinon.assert.calledOnce(router._websocket.mediaUp);
            });
        });

        describe("subscribedStream", function() {
          it("should not notify the websocket if only one stream is up",
            function() {
              conversation.set("subscribedStream", true);

              sinon.assert.notCalled(router._websocket.mediaUp);
            });

          it("should notify the websocket that media is up if both streams" +
             "are connected", function() {
              conversation.set("publishedStream", true);
              conversation.set("subscribedStream", true);

              sinon.assert.calledOnce(router._websocket.mediaUp);
            });
        });
      });
    });
  });

  describe("IncomingCallView", function() {
    var view, model;

    beforeEach(function() {
      var Model = Backbone.Model.extend({});
      model = new Model();
      sandbox.spy(model, "trigger");
      view = TestUtils.renderIntoDocument(loop.conversation.IncomingCallView({
        model: model
      }));
    });

    describe("click event on .btn-accept", function() {
      it("should trigger an 'accept' conversation model event", function () {
        var buttonAccept = view.getDOMNode().querySelector(".btn-accept");
        model.trigger.withArgs("accept");
        TestUtils.Simulate.click(buttonAccept);

        /* Setting a model property triggers 2 events */
        sinon.assert.calledOnce(model.trigger.withArgs("accept"));
      });

      it("should set selectedCallType to audio-video", function () {
        var buttonAccept = view.getDOMNode().querySelector(".btn-accept");
        sandbox.stub(model, "set");

        TestUtils.Simulate.click(buttonAccept);

        sinon.assert.calledOnce(model.set);
        sinon.assert.calledWithExactly(model.set, "selectedCallType",
          "audio-video");
      });
    });

    describe("click event on .call-audio-only", function() {

      it("should trigger an 'accept' conversation model event", function () {
        var buttonAccept = view.getDOMNode().querySelector(".call-audio-only");
        model.trigger.withArgs("accept");
        TestUtils.Simulate.click(buttonAccept);

        /* Setting a model property triggers 2 events */
        sinon.assert.calledOnce(model.trigger.withArgs("accept"));
      });


      it("should set selectedCallType to audio", function() {
        var buttonAccept = view.getDOMNode().querySelector(".call-audio-only");
        sandbox.stub(model, "set");

        TestUtils.Simulate.click(buttonAccept);

        sinon.assert.calledOnce(model.set);
        sinon.assert.calledWithExactly(model.set, "selectedCallType", "audio");
      });
    });

    describe("click event on .btn-decline", function() {
      it("should trigger an 'decline' conversation model event", function() {
        var buttonDecline = view.getDOMNode().querySelector(".btn-decline");

        TestUtils.Simulate.click(buttonDecline);

        sinon.assert.calledOnce(model.trigger);
        sinon.assert.calledWith(model.trigger, "decline");
        });
    });

    describe("click event on .btn-block", function() {
      it("should trigger a 'block' conversation model event", function() {
        var buttonBlock = view.getDOMNode().querySelector(".btn-block");

        TestUtils.Simulate.click(buttonBlock);

        sinon.assert.calledOnce(model.trigger);
        sinon.assert.calledWith(model.trigger, "declineAndBlock");
      });
    });
  });
});
