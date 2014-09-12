/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global loop:true */

var loop = loop || {};
loop.shared = loop.shared || {};
loop.shared.router = (function() {
  "use strict";

  /**
   * Base Router. Allows defining a main active view and ease toggling it when
   * the active route changes.
   *
   * @link http://mikeygee.com/blog/backbone.html
   */
  var BaseRouter = Backbone.Router.extend({
    /**
     * Notifications collection.
     * @type {loop.shared.models.NotificationCollection}
     */
    _notifications: undefined,

    /**
     * Constructor.
     *
     * Required options:
     * - {loop.shared.models.NotificationCollection} notifications
     *
     * @param  {Object} options Options object.
     */
    constructor: function(options) {
      options = options || {};
      if (!options.notifications) {
        throw new Error("missing required notifications");
      }
      this._notifications = options.notifications;

      Backbone.Router.apply(this, arguments);
    },

    /**
     * Renders a React component as current active view.
     *
     * @param {React} reactComponent React component.
     */
    loadReactComponent: function(reactComponent) {
      this.clearActiveView();
      React.renderComponent(reactComponent,
                            document.querySelector("#main"));
    },

    /**
     * Clears current active view.
     */
    clearActiveView: function() {
      React.unmountComponentAtNode(document.querySelector("#main"));
    }
  });

  /**
   * Base conversation router, implementing common behaviors when handling
   * a conversation.
   */
  var BaseConversationRouter = BaseRouter.extend({
    /**
     * Current conversation.
     * @type {loop.shared.models.ConversationModel}
     */
    _conversation: undefined,

    /**
     * Constructor. Defining it as `constructor` allows implementing an
     * `initialize` method in child classes without needing calling this parent
     * one. See http://backbonejs.org/#Model-constructor (same for Router)
     *
     * Required options:
     * - {loop.shared.model.ConversationModel}    model    Conversation model.
     *
     * @param {Object} options Options object.
     */
    constructor: function(options) {
      options = options || {};
      if (!options.conversation) {
        throw new Error("missing required conversation");
      }
      if (!options.client) {
        throw new Error("missing required client");
      }
      this._conversation = options.conversation;
      this._client = options.client;

      this.listenTo(this._conversation, "session:ended", this._onSessionEnded);
      this.listenTo(this._conversation, "session:peer-hungup",
                                        this._onPeerHungup);
      this.listenTo(this._conversation, "session:network-disconnected",
                                        this._onNetworkDisconnected);
      this.listenTo(this._conversation, "session:connection-error",
                    this._notifyError);

      BaseRouter.apply(this, arguments);
    },

    /**
     * Notify the user that the connection was not possible
     * @param {{code: number, message: string}} error
     */
    _notifyError: function(error) {
      console.log(error);
      this._notifications.errorL10n("connection_error_see_console_notification");
      this.endCall();
    },

    /**
     * Ends the call. This method should be overriden.
     */
    endCall: function() {},

    /**
     * Session has ended. Notifies the user and ends the call.
     */
    _onSessionEnded: function() {
      this.endCall();
    },

    /**
     * Peer hung up. Notifies the user and ends the call.
     *
     * Event properties:
     * - {String} connectionId: OT session id
     *
     * @param {Object} event
     */
    _onPeerHungup: function() {
      this._notifications.warnL10n("peer_ended_conversation2");
      this.endCall();
    },

    /**
     * Network disconnected. Notifies the user and ends the call.
     */
    _onNetworkDisconnected: function() {
      this._notifications.warnL10n("network_disconnected");
      this.endCall();
    }
  });

  return {
    BaseRouter: BaseRouter,
    BaseConversationRouter: BaseConversationRouter
  };
})();
