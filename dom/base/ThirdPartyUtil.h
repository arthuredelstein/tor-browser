/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef ThirdPartyUtil_h__
#define ThirdPartyUtil_h__

#include "nsCOMPtr.h"
#include "nsString.h"
#include "mozIThirdPartyUtil.h"
#include "nsIEffectiveTLDService.h"
#include "nsICookiePermission.h"
#include "mozilla/Attributes.h"

class nsIURI;
class nsIChannel;
class nsIDOMWindow;

class ThirdPartyUtil final : public mozIThirdPartyUtil
{
public:
  NS_DECL_ISUPPORTS
  NS_DECL_MOZITHIRDPARTYUTIL

  nsresult Init();

private:
  ~ThirdPartyUtil() {}

  nsresult IsThirdPartyInternal(const nsCString& aFirstDomain,
    nsIURI* aSecondURI, bool* aResult);
  bool IsFirstPartyIsolationActive(nsIChannel* aChannel, nsIDocument* aDoc);
  bool SchemeIsWhiteListed(nsIURI *aURI);
  static nsresult GetOriginatingURI(nsIChannel  *aChannel, nsIURI **aURI);
  nsresult GetFirstPartyURIInternal(nsIChannel *aChannel, nsIDocument *aDoc,
                                    bool aLogErrors, nsIURI **aOutput);

  nsCOMPtr<nsIEffectiveTLDService> mTLDService;
  nsCOMPtr<nsICookiePermission> mCookiePermissions;
};

#endif

