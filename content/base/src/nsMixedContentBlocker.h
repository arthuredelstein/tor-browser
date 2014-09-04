/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef nsMixedContentBlocker_h___
#define nsMixedContentBlocker_h___

#define NS_MIXEDCONTENTBLOCKER_CONTRACTID "@mozilla.org/mixedcontentblocker;1"
/* daf1461b-bf29-4f88-8d0e-4bcdf332c862 */
#define NS_MIXEDCONTENTBLOCKER_CID \
{ 0xdaf1461b, 0xbf29, 0x4f88, \
  { 0x8d, 0x0e, 0x4b, 0xcd, 0xf3, 0x32, 0xc8, 0x62 } }

// This enum defines type of content that is detected when an
// nsMixedContentEvent fires
enum MixedContentTypes {
  // "Active" content, such as fonts, plugin content, JavaScript, stylesheets,
  // iframes, WebSockets, and XHR
  eMixedScript,
  // "Display" content, such as images, audio, video, and <a ping>
  eMixedDisplay
};

#include "nsISupports.h"

class nsIChannel;
class nsIURI;

class nsMixedContentBlocker : public nsISupports
{
public:
  NS_DECL_ISUPPORTS

  nsMixedContentBlocker();
  virtual ~nsMixedContentBlocker();

  static NS_IMETHODIMP EvaluateMixedContent(nsIChannel *channel);

private:
  static NS_IMETHODIMP EvaluateMixedContent(uint32_t aContentType,
                                            nsIURI* aContentLocation,
                                            nsISupports* aRequestingContext,
                                            int16_t* aDecision);

  static bool sBlockMixedScript;
  static bool sBlockMixedDisplay;
};

#endif /* nsMixedContentBlocker_h___ */
