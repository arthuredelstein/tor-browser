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

  static nsCOMPtr<mozIThirdPartyUtil> gThirdPartyUtilService;

  static nsCString GetFirstPartyHost(nsIDocument* document)
  {
    if (!gThirdPartyUtilService) {
      gThirdPartyUtilService = do_GetService(THIRDPARTYUTIL_CONTRACTID);
    }
    nsCOMPtr<nsIURI> isolationURI;
    gThirdPartyUtilService->GetFirstPartyIsolationURI(nullptr, document, getter_AddRefs(isolationURI));
    nsCString firstPartyHost;
    gThirdPartyUtilService->GetFirstPartyHostForIsolation(isolationURI, firstPartyHost);
    return firstPartyHost;
  }

  static nsCString GetFirstPartyHost(nsIChannel* channel)
  {
    if (!gThirdPartyUtilService) {
      gThirdPartyUtilService = do_GetService(THIRDPARTYUTIL_CONTRACTID);
    }
    nsCOMPtr<nsIURI> isolationURI;
    gThirdPartyUtilService->GetFirstPartyIsolationURI(channel, nullptr, getter_AddRefs(isolationURI));
    nsCString firstPartyHost;
    gThirdPartyUtilService->GetFirstPartyHostForIsolation(isolationURI, firstPartyHost);
    return firstPartyHost;
  }

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

nsCOMPtr<mozIThirdPartyUtil> ThirdPartyUtil::gThirdPartyUtilService;

#endif

