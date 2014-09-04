/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsMixedContentBlocker.h"

#include "nsContentPolicyUtils.h"
#include "nsThreadUtils.h"
#include "nsINode.h"
#include "nsCOMPtr.h"
#include "nsIDocShell.h"
#include "nsISecurityEventSink.h"
#include "nsIWebProgressListener.h"
#include "nsContentUtils.h"
#include "nsNetUtil.h"
#include "nsIRequest.h"
#include "nsIDocument.h"
#include "nsIContentViewer.h"
#include "nsIChannel.h"
#include "nsIHttpChannel.h"
#include "mozilla/Preferences.h"
#include "nsIScriptObjectPrincipal.h"
#include "nsISecureBrowserUI.h"
#include "nsIDocumentLoader.h"
#include "nsIWebNavigation.h"
#include "nsLoadGroup.h"
#include "nsIScriptError.h"
#include "nsIContentPolicy.h"
#include "nsIURI.h"

#include "prlog.h"

using namespace mozilla;

enum nsMixedContentBlockerMessageType {
  eBlocked = 0x00,
  eUserOverride = 0x01
};

// Is mixed script blocking (fonts, plugin content, scripts, stylesheets,
// iframes, websockets, XHR) enabled?
bool nsMixedContentBlocker::sBlockMixedScript = false;

// Is mixed display content blocking (images, audio, video, <a ping>) enabled?
bool nsMixedContentBlocker::sBlockMixedDisplay = false;

// Fired at the document that attempted to load mixed content.  The UI could
// handle this event, for example, by displaying an info bar that offers the
// choice to reload the page with mixed content permitted.
class nsMixedContentEvent : public nsRunnable
{
public:
  nsMixedContentEvent(nsISupports *aContext, MixedContentTypes aType)
    : mContext(aContext), mType(aType)
  {}

  NS_IMETHOD Run()
  {
    NS_ASSERTION(mContext,
                 "You can't call this runnable without a requesting context");

    // To update the security UI in the tab with the blocked mixed content, call
    // nsISecurityEventSink::OnSecurityChange.  You can get to the event sink by
    // calling NS_CP_GetDocShellFromContext on the context, and QI'ing to
    // nsISecurityEventSink.


    // Mixed content was allowed and is about to load; get the document and
    // set the approriate flag to true if we are about to load Mixed Active
    // Content.
    nsCOMPtr<nsIDocShell> docShell = NS_CP_GetDocShellFromContext(mContext);
    if (!docShell) {
        return NS_OK;
    }
    nsCOMPtr<nsIDocShellTreeItem> sameTypeRoot;
    docShell->GetSameTypeRootTreeItem(getter_AddRefs(sameTypeRoot));
    NS_ASSERTION(sameTypeRoot, "No document shell root tree item from document shell tree item!");

    // now get the document from sameTypeRoot
    nsCOMPtr<nsIDocument> rootDoc = do_GetInterface(sameTypeRoot);
    NS_ASSERTION(rootDoc, "No root document from document shell root tree item.");


    if (mType == eMixedScript) {
       // See if the pref will change here. If it will, only then do we need to call OnSecurityChange() to update the UI.
       if (rootDoc->GetHasMixedActiveContentLoaded()) {
         return NS_OK;
       }
       rootDoc->SetHasMixedActiveContentLoaded(true);

      // Update the security UI in the tab with the allowed mixed active content
      nsCOMPtr<nsISecurityEventSink> eventSink = do_QueryInterface(docShell);
      if (eventSink) {
        // If mixed display content is loaded, make sure to include that in the state.
        if (rootDoc->GetHasMixedDisplayContentLoaded()) {
          eventSink->OnSecurityChange(mContext, (nsIWebProgressListener::STATE_IS_BROKEN |
          nsIWebProgressListener::STATE_LOADED_MIXED_ACTIVE_CONTENT |
          nsIWebProgressListener::STATE_LOADED_MIXED_DISPLAY_CONTENT));
        } else {
          eventSink->OnSecurityChange(mContext, (nsIWebProgressListener::STATE_IS_BROKEN |
          nsIWebProgressListener::STATE_LOADED_MIXED_ACTIVE_CONTENT));
        }
      }

    } else if (mType == eMixedDisplay) {
      // See if the pref will change here. If it will, only then do we need to call OnSecurityChange() to update the UI.
      if (rootDoc->GetHasMixedDisplayContentLoaded()) {
        return NS_OK;
      }
      rootDoc->SetHasMixedDisplayContentLoaded(true);

      // Update the security UI in the tab with the allowed mixed display content.
      nsCOMPtr<nsISecurityEventSink> eventSink = do_QueryInterface(docShell);
      if (eventSink) {
        // If mixed active content is loaded, make sure to include that in the state.
        if (rootDoc->GetHasMixedActiveContentLoaded()) {
          eventSink->OnSecurityChange(mContext, (nsIWebProgressListener::STATE_IS_BROKEN |
          nsIWebProgressListener::STATE_LOADED_MIXED_DISPLAY_CONTENT |
          nsIWebProgressListener::STATE_LOADED_MIXED_ACTIVE_CONTENT));
        } else {
          eventSink->OnSecurityChange(mContext, (nsIWebProgressListener::STATE_IS_BROKEN |
          nsIWebProgressListener::STATE_LOADED_MIXED_DISPLAY_CONTENT));
        }
      }
    }

    return NS_OK;
  }
private:
  // The requesting context for the content load. Generally, a DOM node from
  // the document that caused the load.
  nsCOMPtr<nsISupports> mContext;

  // The type of mixed content detected, e.g. active or display
  const MixedContentTypes mType;
};


nsMixedContentBlocker::nsMixedContentBlocker()
{
  // Cache the pref for mixed script blocking
  Preferences::AddBoolVarCache(&sBlockMixedScript,
                               "security.mixed_content.block_active_content");

  // Cache the pref for mixed display blocking
  Preferences::AddBoolVarCache(&sBlockMixedDisplay,
                               "security.mixed_content.block_display_content");
}

nsMixedContentBlocker::~nsMixedContentBlocker()
{
}

NS_IMPL_ISUPPORTS(nsMixedContentBlocker, nsISupports)

static void
LogMixedContentMessage(MixedContentTypes aClassification,
                       nsIURI* aContentLocation,
                       nsIDocument* aRootDoc,
                       nsMixedContentBlockerMessageType aMessageType)
{
  nsAutoCString messageCategory;
  uint32_t severityFlag;
  nsAutoCString messageLookupKey;

  if (aMessageType == eBlocked) {
    severityFlag = nsIScriptError::errorFlag;
    messageCategory.AssignLiteral("Mixed Content Blocker");
    if (aClassification == eMixedDisplay) {
      messageLookupKey.AssignLiteral("BlockMixedDisplayContent");
    } else {
      messageLookupKey.AssignLiteral("BlockMixedActiveContent");
    }
  } else {
    severityFlag = nsIScriptError::warningFlag;
    messageCategory.AssignLiteral("Mixed Content Message");
    if (aClassification == eMixedDisplay) {
      messageLookupKey.AssignLiteral("LoadingMixedDisplayContent");
    } else {
      messageLookupKey.AssignLiteral("LoadingMixedActiveContent");
    }
  }

  nsAutoCString locationSpec;
  aContentLocation->GetSpec(locationSpec);
  NS_ConvertUTF8toUTF16 locationSpecUTF16(locationSpec);

  const char16_t* strings[] = { locationSpecUTF16.get() };
  nsContentUtils::ReportToConsole(severityFlag, messageCategory, aRootDoc,
                                  nsContentUtils::eSECURITY_PROPERTIES,
                                  messageLookupKey.get(), strings, ArrayLength(strings));
}

NS_IMETHODIMP
nsMixedContentBlocker::EvaluateMixedContent(nsIChannel *channel) 
{
  if (!channel) {
    NS_ERROR("No channel when evaluating mixed content!");
    return NS_OK;
  }

  uint32_t contentPolicyType;
  nsresult rv = channel->GetContentPolicyType(&contentPolicyType);
  if (NS_FAILED(rv)) {
    NS_ERROR("No contentPolicyType when evaluating mixed content!");
    return NS_OK;
  }

  // 1) try to get the requesting context from the channel
  nsCOMPtr<nsISupports> requestingContext;
  rv = channel->GetRequestingContext(getter_AddRefs(requestingContext));
  if (NS_FAILED(rv)) {
    NS_ERROR("No requestingContext when evaluating mixed content!");
    return NS_OK;
  }

  // 2) if we do not have a context yet, try to get it from the window or the node
  if(!requestingContext) {
    nsCOMPtr<nsIInterfaceRequestor> callbacks;
    channel->GetNotificationCallbacks(getter_AddRefs(callbacks));
    if (!callbacks) {
      nsCOMPtr<nsILoadGroup> loadGroup;
      channel->GetLoadGroup(getter_AddRefs(loadGroup));
      if (loadGroup) {
       loadGroup->GetNotificationCallbacks(getter_AddRefs(callbacks));
      }
    }

    if (callbacks) {
      nsCOMPtr<nsIDOMWindow> domWin;
      callbacks->GetInterface(NS_GET_IID(nsIDOMWindow), getter_AddRefs(domWin));
      requestingContext = domWin;
      if (!requestingContext) {
        nsCOMPtr<nsINode> node;
        callbacks->GetInterface(NS_GET_IID(nsINode), getter_AddRefs(node));
        requestingContext = node;
      }
    }
  }

  // NEEDINFO: is it safe to assume this happens only
  // for SafeBrowsing and also OCSP?
  // currently this also returns for favicons
  if (!requestingContext) {
    return NS_OK;
  }

  nsCOMPtr<nsIURI> uri;
  rv = channel->GetURI(getter_AddRefs(uri));
  if (NS_FAILED(rv)) {
    NS_ERROR("No uri when evaluating mixed content!");
    return NS_OK;
  }

  int16_t decision = nsIContentPolicy::REJECT_REQUEST;
  rv = EvaluateMixedContent(contentPolicyType,
                            uri,
                            requestingContext,
                            &decision);

  if (NS_FAILED(rv)) {
    NS_ERROR("EvaluateMixedContent did not return a decision!");
    return NS_OK;
  }

  // if the channel is about to load mixed content
  // we cancel the request on the channel
  if (decision != nsIContentPolicy::ACCEPT) {
    channel->Cancel(NS_BINDING_ABORTED);
  }

  return NS_OK;
}

NS_IMETHODIMP
nsMixedContentBlocker::EvaluateMixedContent(uint32_t aContentType,
                                            nsIURI* aContentLocation,
                                            nsISupports* aRequestingContext,
                                            int16_t* aDecision)
{
  // Asserting that we are on the main thread here and hence do not have to lock
  // and unlock sBlockMixedScript and sBlockMixedDisplay before reading/writing
  // to them.
  MOZ_ASSERT(NS_IsMainThread());

  // Assume active (high risk) content and blocked by default
  MixedContentTypes classification = eMixedScript;

  // Notes on non-obvious decisions:
  //
  // TYPE_DTD: A DTD can contain entity definitions that expand to scripts.
  //
  // TYPE_FONT: The TrueType hinting mechanism is basically a scripting
  // language that gets interpreted by the operating system's font rasterizer.
  // Mixed content web fonts are relatively uncommon, and we can can fall back
  // to built-in fonts with minimal disruption in almost all cases.
  //
  // TYPE_OBJECT_SUBREQUEST could actually be either active content (e.g. a
  // script that a plugin will execute) or display content (e.g. Flash video
  // content).  Until we have a way to determine active vs passive content
  // from plugin requests (bug 836352), we will treat this as passive content.
  // This is to prevent false positives from causing users to become
  // desensitized to the mixed content blocker.
  //
  // TYPE_CSP_REPORT: High-risk because they directly leak information about
  // the content of the page, and because blocking them does not have any
  // negative effect on the page loading.
  //
  // TYPE_PING: Ping requests are POSTS, not GETs like images and media.
  // Also, PING requests have no bearing on the rendering or operation of
  // the page when used as designed, so even though they are lower risk than
  // scripts, blocking them is basically risk-free as far as compatibility is
  // concerned.  Ping is turned off by default in Firefox, so unless a user
  // opts into ping, no request will be made.  Categorizing this as Mixed
  // Display Content for now, but this is subject to change.
  //
  // TYPE_STYLESHEET: XSLT stylesheets can insert scripts. CSS positioning
  // and other advanced CSS features can possibly be exploited to cause
  // spoofing attacks (e.g. make a "grant permission" button look like a
  // "refuse permission" button).
  //
  // TYPE_BEACON: Beacon requests are similar to TYPE_PING, but are default on.
  //
  // TYPE_WEBSOCKET: The Websockets API requires browsers to
  // reject mixed-content websockets: "If secure is false but the origin of
  // the entry script has a scheme component that is itself a secure protocol,
  // e.g. HTTPS, then throw a SecurityError exception." We already block mixed
  // content websockets within the websockets implementation, so we don't need
  // to do any blocking here, nor do we need to provide a way to undo or
  // override the blocking. Websockets without TLS are very flaky anyway in the
  // face of many HTTP-aware proxies. Compared to psasive content, there is
  // additional risk that the script using WebSockets will disclose sensitive
  // information from the HTTPS page and/or eval (directly or indirectly)
  // received data.
  //
  // TYPE_XMLHTTPREQUEST: XHR requires either same origin or CORS, so most
  // mixed-content XHR will already be blocked by that check. This will also
  // block HTTPS-to-HTTP XHR with CORS. The same security concerns mentioned
  // above for WebSockets apply to XHR, and XHR should have the same security
  // properties as WebSockets w.r.t. mixed content. XHR's handling of redirects
  // amplifies these concerns.


  static_assert(nsIContentPolicy::TYPE_DATAREQUEST == nsIContentPolicy::TYPE_XMLHTTPREQUEST,
                "TYPE_DATAREQUEST is not a synonym for "
                "TYPE_XMLHTTPREQUEST");

  switch (aContentType) {
    // The top-level document cannot be mixed content by definition
    case nsIContentPolicy::TYPE_DOCUMENT:
      *aDecision = nsIContentPolicy::ACCEPT;
      return NS_OK;
    // Creating insecure websocket connections in a secure page is blocked already
    // in the websocket constructor. We don't need to check the blocking here
    // and we don't want to un-block
    case nsIContentPolicy::TYPE_WEBSOCKET:
      *aDecision = nsIContentPolicy::ACCEPT;
      return NS_OK;


    // Static display content is considered moderate risk for mixed content so
    // these will be blocked according to the mixed display preference
    case nsIContentPolicy::TYPE_IMAGE:
    case nsIContentPolicy::TYPE_MEDIA:
    case nsIContentPolicy::TYPE_OBJECT_SUBREQUEST:
    case nsIContentPolicy::TYPE_PING:
    case nsIContentPolicy::TYPE_BEACON:
      classification = eMixedDisplay;
      break;

    // Active content (or content with a low value/risk-of-blocking ratio)
    // that has been explicitly evaluated; listed here for documentation
    // purposes and to avoid the assertion and warning for the default case.
    case nsIContentPolicy::TYPE_CSP_REPORT:
    case nsIContentPolicy::TYPE_DTD:
    case nsIContentPolicy::TYPE_FONT:
    case nsIContentPolicy::TYPE_OBJECT:
    case nsIContentPolicy::TYPE_SCRIPT:
    case nsIContentPolicy::TYPE_STYLESHEET:
    case nsIContentPolicy::TYPE_SUBDOCUMENT:
    case nsIContentPolicy::TYPE_XBL:
    case nsIContentPolicy::TYPE_XMLHTTPREQUEST:
    case nsIContentPolicy::TYPE_XSLT:
    case nsIContentPolicy::TYPE_OTHER:
      break;


    // This content policy works as a whitelist.
    default:
      MOZ_ASSERT(false, "Mixed content of unknown type");
      break;
  }

 /* Get the scheme of the sub-document resource to be requested. If it is
  * a safe to load in an https context then mixed content doesn't apply.
  *
  * Check Protocol Flags to determine if scheme is safe to load:
  * URI_DOES_NOT_RETURN_DATA - e.g.
  *   "mailto"
  * URI_IS_LOCAL_RESOURCE - e.g.
  *   "data",
  *   "resource",
  *   "moz-icon"
  * URI_INHERITS_SECURITY_CONTEXT - e.g.
  *   "javascript"
  * URI_SAFE_TO_LOAD_IN_SECURE_CONTEXT - e.g.
  *   "https",
  *   "moz-safe-about"
  *
  */
  bool schemeLocal = false;
  bool schemeNoReturnData = false;
  bool schemeInherits = false;
  bool schemeSecure = false;
  if (NS_FAILED(NS_URIChainHasFlags(aContentLocation, nsIProtocolHandler::URI_IS_LOCAL_RESOURCE , &schemeLocal))  ||
      NS_FAILED(NS_URIChainHasFlags(aContentLocation, nsIProtocolHandler::URI_DOES_NOT_RETURN_DATA, &schemeNoReturnData)) ||
      NS_FAILED(NS_URIChainHasFlags(aContentLocation, nsIProtocolHandler::URI_INHERITS_SECURITY_CONTEXT, &schemeInherits)) ||
      NS_FAILED(NS_URIChainHasFlags(aContentLocation, nsIProtocolHandler::URI_SAFE_TO_LOAD_IN_SECURE_CONTEXT, &schemeSecure))) {
    *aDecision = nsIContentPolicy::REJECT_REQUEST;
    return NS_ERROR_FAILURE;
  }

  if (schemeLocal || schemeNoReturnData || schemeInherits || schemeSecure) {
     *aDecision = nsIContentPolicy::ACCEPT;
     return NS_OK;
  }

  // Since there are cases where aRequestingLocation and aRequestPrincipal are
  // definitely not the owning document, we try to ignore them by extracting the
  // requestingLocation in the following order:
  // 1) from the aRequestingContext, either extracting
  //    a) the node's principal, or the
  //    b) script object's principal.
  // 2) if aRequestingContext yields a principal but no location, we check
  //    if its the system principal. If it is, allow the load.
  // 3) If we still end up not having a requestingLocation, we reject the load.

  nsCOMPtr<nsIPrincipal> principal;
  // 1a) Try to get the principal if aRequestingContext is a node.
  nsCOMPtr<nsINode> node = do_QueryInterface(aRequestingContext);
  if (node) {
    principal = node->NodePrincipal();
  }

  // 1b) Try using the window's script object principal if it's not a node.
  if (!principal) {
    nsCOMPtr<nsIScriptObjectPrincipal> scriptObjPrin = do_QueryInterface(aRequestingContext);
    if (scriptObjPrin) {
      principal = scriptObjPrin->GetPrincipal();
    }
  }

  nsCOMPtr<nsIURI> requestingLocation;
  if (principal) {
    principal->GetURI(getter_AddRefs(requestingLocation));
  }

  // 2) if aRequestingContext yields a principal but no location, we check if its a system principal.
  if (principal && !requestingLocation) {
    if (nsContentUtils::IsSystemPrincipal(principal)) {
      *aDecision = nsIContentPolicy::ACCEPT;
      return NS_OK;
    }
  }

  // 3) Giving up. We still don't have a requesting location, therefore we can't tell
  //    if this is a mixed content load. Deny to be safe.
  if (!requestingLocation) {
    *aDecision = nsIContentPolicy::REJECT_REQUEST;
    return NS_OK;
  }

  // Check the parent scheme. If it is not an HTTPS page then mixed content
  // restrictions do not apply.
  bool parentIsHttps;
  nsresult rv = requestingLocation->SchemeIs("https", &parentIsHttps);
  if (NS_FAILED(rv)) {
    NS_ERROR("requestingLocation->SchemeIs failed");
    *aDecision = nsIContentPolicy::REJECT_REQUEST;
    return NS_OK;
  }
  if (!parentIsHttps) {
    *aDecision = nsIContentPolicy::ACCEPT;
    return NS_OK;
  }

  // Determine if the rootDoc is https and if the user decided to allow Mixed Content
  nsCOMPtr<nsIDocShell> docShell = NS_CP_GetDocShellFromContext(aRequestingContext);
  NS_ENSURE_TRUE(docShell, NS_OK);
  bool rootHasSecureConnection = false;
  bool allowMixedContent = false;
  bool isRootDocShell = false;
  rv = docShell->GetAllowMixedContentAndConnectionData(&rootHasSecureConnection, &allowMixedContent, &isRootDocShell);
  if (NS_FAILED(rv)) {
     *aDecision = nsIContentPolicy::REJECT_REQUEST;
     return rv;
  }

  // Get the sameTypeRoot tree item from the docshell
  nsCOMPtr<nsIDocShellTreeItem> sameTypeRoot;
  docShell->GetSameTypeRootTreeItem(getter_AddRefs(sameTypeRoot));
  NS_ASSERTION(sameTypeRoot, "No root tree item from docshell!");

  // When navigating an iframe, the iframe may be https
  // but its parents may not be.  Check the parents to see if any of them are https.
  // If none of the parents are https, allow the load.
  if (aContentType == nsIContentPolicy::TYPE_SUBDOCUMENT && !rootHasSecureConnection) {

    bool httpsParentExists = false;

    nsCOMPtr<nsIDocShellTreeItem> parentTreeItem;
    parentTreeItem = docShell;

    while(!httpsParentExists && parentTreeItem) {
      nsCOMPtr<nsIWebNavigation> parentAsNav(do_QueryInterface(parentTreeItem));
      NS_ASSERTION(parentAsNav, "No web navigation object from parent's docshell tree item");
      nsCOMPtr<nsIURI> parentURI;

      parentAsNav->GetCurrentURI(getter_AddRefs(parentURI));
      if (!parentURI || NS_FAILED(parentURI->SchemeIs("https", &httpsParentExists))) {
        // if getting the URI or the scheme fails, assume there is a https parent and break.
        httpsParentExists = true;
        break;
      }

      // When the parent and the root are the same, we have traversed all the way up
      // the same type docshell tree.  Break out of the while loop.
      if(sameTypeRoot == parentTreeItem) {
        break;
      }

      // update the parent to the grandparent.
      nsCOMPtr<nsIDocShellTreeItem> newParentTreeItem;
      parentTreeItem->GetSameTypeParent(getter_AddRefs(newParentTreeItem));
      parentTreeItem = newParentTreeItem;
    } // end while loop.

    if (!httpsParentExists) {
      *aDecision = nsIContentPolicy::ACCEPT;
      return NS_OK;
    }
  }

  // Get the root document from the sameTypeRoot
  nsCOMPtr<nsIDocument> rootDoc = do_GetInterface(sameTypeRoot);
  NS_ASSERTION(rootDoc, "No root document from document shell root tree item.");

  // Get eventSink and the current security state from the docShell
  nsCOMPtr<nsISecurityEventSink> eventSink = do_QueryInterface(docShell);
  NS_ASSERTION(eventSink, "No eventSink from docShell.");
  nsCOMPtr<nsIDocShell> rootShell = do_GetInterface(sameTypeRoot);
  NS_ASSERTION(rootShell, "No root docshell from document shell root tree item.");
  uint32_t State = nsIWebProgressListener::STATE_IS_BROKEN;
  nsCOMPtr<nsISecureBrowserUI> securityUI;
  rootShell->GetSecurityUI(getter_AddRefs(securityUI));
  // If there is no securityUI, document doesn't have a security state.
  // Allow load and return early.
  if (!securityUI) {
    *aDecision = nsIContentPolicy::ACCEPT;
    return NS_OK;
  }
  nsresult stateRV = securityUI->GetState(&State);

  // If the content is display content, and the pref says display content should be blocked, block it.
  if (sBlockMixedDisplay && classification == eMixedDisplay) {
    if (allowMixedContent) {
      LogMixedContentMessage(classification, aContentLocation, rootDoc, eUserOverride);
      *aDecision = nsIContentPolicy::ACCEPT;
      rootDoc->SetHasMixedActiveContentLoaded(true);
      if (!rootDoc->GetHasMixedDisplayContentLoaded() && NS_SUCCEEDED(stateRV)) {
        rootDoc->SetHasMixedDisplayContentLoaded(true);
        eventSink->OnSecurityChange(aRequestingContext, (State | nsIWebProgressListener::STATE_LOADED_MIXED_DISPLAY_CONTENT));
      }
    } else {
      *aDecision = nsIContentPolicy::REJECT_REQUEST;
      LogMixedContentMessage(classification, aContentLocation, rootDoc, eBlocked);
      if (!rootDoc->GetHasMixedDisplayContentBlocked() && NS_SUCCEEDED(stateRV)) {
        rootDoc->SetHasMixedDisplayContentBlocked(true);
        eventSink->OnSecurityChange(aRequestingContext, (State | nsIWebProgressListener::STATE_BLOCKED_MIXED_DISPLAY_CONTENT));
      }
    }
    return NS_OK;

  } else if (sBlockMixedScript && classification == eMixedScript) {
    // If the content is active content, and the pref says active content should be blocked, block it
    // unless the user has choosen to override the pref
    if (allowMixedContent) {
       LogMixedContentMessage(classification, aContentLocation, rootDoc, eUserOverride);
       *aDecision = nsIContentPolicy::ACCEPT;
       // See if the pref will change here. If it will, only then do we need to call OnSecurityChange() to update the UI.
       if (rootDoc->GetHasMixedActiveContentLoaded()) {
         return NS_OK;
       }
       rootDoc->SetHasMixedActiveContentLoaded(true);

       if (rootHasSecureConnection) {
         // User has decided to override the pref and the root is https, so change the Security State.
         if (rootDoc->GetHasMixedDisplayContentLoaded()) {
           // If mixed display content is loaded, make sure to include that in the state.
           eventSink->OnSecurityChange(aRequestingContext, (nsIWebProgressListener::STATE_IS_BROKEN |
           nsIWebProgressListener::STATE_LOADED_MIXED_ACTIVE_CONTENT |
           nsIWebProgressListener::STATE_LOADED_MIXED_DISPLAY_CONTENT));
         } else {
           eventSink->OnSecurityChange(aRequestingContext, (nsIWebProgressListener::STATE_IS_BROKEN |
           nsIWebProgressListener::STATE_LOADED_MIXED_ACTIVE_CONTENT));
         }
         return NS_OK;
       } else {
         // User has already overriden the pref and the root is not https;
         // mixed content was allowed on an https subframe.
         if (NS_SUCCEEDED(stateRV)) {
           eventSink->OnSecurityChange(aRequestingContext, (State | nsIWebProgressListener::STATE_LOADED_MIXED_ACTIVE_CONTENT));
         }
         return NS_OK;
       }
    } else {
       //User has not overriden the pref by Disabling protection. Reject the request and update the security state.
       *aDecision = nsIContentPolicy::REJECT_REQUEST;
       LogMixedContentMessage(classification, aContentLocation, rootDoc, eBlocked);
       // See if the pref will change here. If it will, only then do we need to call OnSecurityChange() to update the UI.
       if (rootDoc->GetHasMixedActiveContentBlocked()) {
         return NS_OK;
       }
       rootDoc->SetHasMixedActiveContentBlocked(true);

       // The user has not overriden the pref, so make sure they still have an option by calling eventSink
       // which will invoke the doorhanger
       if (NS_SUCCEEDED(stateRV)) {
          eventSink->OnSecurityChange(aRequestingContext, (State | nsIWebProgressListener::STATE_BLOCKED_MIXED_ACTIVE_CONTENT));
       }
       return NS_OK;
    }

  } else {
    // The content is not blocked by the mixed content prefs.

    // Log a message that we are loading mixed content.
    LogMixedContentMessage(classification, aContentLocation, rootDoc, eUserOverride);

    // Fire the event from a script runner as it is unsafe to run script
    // from within ShouldLoad
    nsContentUtils::AddScriptRunner(
      new nsMixedContentEvent(aRequestingContext, classification));
    *aDecision = nsIContentPolicy::ACCEPT;
    return NS_OK;
  }
  *aDecision = nsIContentPolicy::REJECT_REQUEST;
  return NS_OK;
}
