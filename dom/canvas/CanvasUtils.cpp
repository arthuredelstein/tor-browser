/* -*- Mode: C++; tab-width: 20; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <stdlib.h>
#include <stdarg.h>

#include "prprf.h"

#include "nsIServiceManager.h"

#include "nsIConsoleService.h"
#include "nsIDOMCanvasRenderingContext2D.h"
#include "nsICanvasRenderingContextInternal.h"
#include "nsIHTMLCollection.h"
#include "mozilla/dom/HTMLCanvasElement.h"
#include "nsIPrincipal.h"

#include "nsGfxCIID.h"

#include "nsTArray.h"

#include "CanvasUtils.h"
#include "mozilla/gfx/Matrix.h"
#include "WebGL2Context.h"

using namespace mozilla::gfx;

#include "nsIScriptObjectPrincipal.h"
#include "nsIPermissionManager.h"
#include "nsIObserverService.h"
#include "mozilla/Services.h"
#include "mozIThirdPartyUtil.h"
#include "nsContentUtils.h"
#include "nsUnicharUtils.h"
#include "nsPrintfCString.h"
#include "nsIConsoleService.h"
#include "jsapi.h"

#define TOPIC_CANVAS_PERMISSIONS_PROMPT "canvas-permissions-prompt"
#define PERMISSION_CANVAS_EXTRACT_DATA "canvas/extractData"

namespace mozilla {
namespace CanvasUtils {

// Check site-specific permission and display prompt if appropriate.
bool IsImageExtractionAllowed(nsIDocument *aDocument, JSContext *aCx)
{
    // Don't proceed if we don't have a document or JavaScript context.
    if (!aDocument || !aCx) {
        return false;
    }

    // Documents with system principal can always extract canvas data.
    nsPIDOMWindow *win = aDocument->GetWindow();
    nsCOMPtr<nsIScriptObjectPrincipal> sop(do_QueryInterface(win));
    if (sop && nsContentUtils::IsSystemPrincipal(sop->GetPrincipal())) {
        return true;
    }

    // Always give permission to chrome scripts (e.g. Page Inspector).
    if (nsContentUtils::ThreadsafeIsCallerChrome()) {
        return true;
    }

    // Get the document URI and its spec.
    nsIURI *docURI = aDocument->GetDocumentURI();
    nsCString docURISpec;
    docURI->GetSpec(docURISpec);

    // Allow local files to extract canvas data.
    bool isFileURL;
    (void) docURI->SchemeIs("file", &isFileURL);
    if (isFileURL) {
        return true;
    }

    // Get calling script file and line for logging.
    JS::AutoFilename scriptFile;
    unsigned scriptLine = 0;
    bool isScriptKnown = false;
    if (JS::DescribeScriptedCaller(aCx, &scriptFile, &scriptLine)) {
        isScriptKnown = true;
        // Don't show canvas prompt for PDF.js
        if (scriptFile.get() &&
            strcmp(scriptFile.get(), "resource://pdf.js/build/pdf.js") == 0) {
            return true;
        }
    }

    // Load Third Party Util service.
    nsresult rv;
    nsCOMPtr<mozIThirdPartyUtil> thirdPartyUtil =
        do_GetService(THIRDPARTYUTIL_CONTRACTID, &rv);
    NS_ENSURE_SUCCESS(rv, false);

    // Get the First Party URI and its spec.
    nsCOMPtr<nsIURI> firstPartyURI;
    rv = thirdPartyUtil->GetFirstPartyURI(NULL, aDocument,
                                                   getter_AddRefs(firstPartyURI));
    NS_ENSURE_SUCCESS(rv, false);
    nsCString firstPartySpec;
    firstPartyURI->GetSpec(firstPartySpec);

    // Block all third-party attempts to extract canvas.
    bool isThirdParty = true;
    rv = thirdPartyUtil->IsThirdPartyURI(firstPartyURI, docURI, &isThirdParty);
    NS_ENSURE_SUCCESS(rv, false);
    if (isThirdParty) {
        nsAutoCString message;
        message.AppendPrintf("Blocked third party %s in page %s from extracting canvas data.",
                             docURISpec.get(), firstPartySpec.get());
        if (isScriptKnown) {
          message.AppendPrintf(" %s:%u.", scriptFile.get(), scriptLine);
        }
        nsContentUtils::LogMessageToConsole(message.get());
        return false;
    }

    // Load Permission Manager service.
    nsCOMPtr<nsIPermissionManager> permissionManager =
        do_GetService(NS_PERMISSIONMANAGER_CONTRACTID);
    NS_ENSURE_SUCCESS(rv, false);

    // Check if the site has permission to extract canvas data.
    // Either permit or block extraction if a stored permission setting exists.
    uint32_t permission;
    rv = permissionManager->TestPermission(firstPartyURI,
                                           PERMISSION_CANVAS_EXTRACT_DATA, &permission);
    NS_ENSURE_SUCCESS(rv, false);
    if (permission == nsIPermissionManager::ALLOW_ACTION) {
      return true;
    } else if (permission == nsIPermissionManager::DENY_ACTION) {
      return false;
    }

    // At this point, permission is unknown (nsIPermissionManager::UNKNOWN_ACTION).
    nsAutoCString message;
    message.AppendPrintf("Blocked %s in page %s from extracting canvas data.",
                         docURISpec.get(), firstPartySpec.get());
    if (isScriptKnown) {
      message.AppendPrintf(" %s:%u.", scriptFile.get(), scriptLine);
    }
    nsContentUtils::LogMessageToConsole(message.get());

    // Prompt the user (asynchronous).
    nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService();
    obs->NotifyObservers(win, TOPIC_CANVAS_PERMISSIONS_PROMPT,
                         NS_ConvertUTF8toUTF16(firstPartySpec).get());

    // We don't extract the image for now -- user may override at prompt.
    return false;
}

bool
GetCanvasContextType(const nsAString& str, dom::CanvasContextType* const out_type)
{
  if (str.EqualsLiteral("2d")) {
    *out_type = dom::CanvasContextType::Canvas2D;
    return true;
  }

  if (str.EqualsLiteral("experimental-webgl")) {
    *out_type = dom::CanvasContextType::WebGL1;
    return true;
  }

#ifdef MOZ_WEBGL_CONFORMANT
  if (str.EqualsLiteral("webgl")) {
    /* WebGL 1.0, $2.1 "Context Creation":
     *   If the user agent supports both the webgl and experimental-webgl
     *   canvas context types, they shall be treated as aliases.
     */
    *out_type = dom::CanvasContextType::WebGL1;
    return true;
  }
#endif

  if (WebGL2Context::IsSupported()) {
    if (str.EqualsLiteral("webgl2")) {
      *out_type = dom::CanvasContextType::WebGL2;
      return true;
    }
  }

  return false;
}

/**
 * This security check utility might be called from an source that never taints
 * others. For example, while painting a CanvasPattern, which is created from an
 * ImageBitmap, onto a canvas. In this case, the caller could set the CORSUsed
 * true in order to pass this check and leave the aPrincipal to be a nullptr
 * since the aPrincipal is not going to be used.
 */
void
DoDrawImageSecurityCheck(dom::HTMLCanvasElement *aCanvasElement,
                         nsIPrincipal *aPrincipal,
                         bool forceWriteOnly,
                         bool CORSUsed)
{
    // Callers should ensure that mCanvasElement is non-null before calling this
    if (!aCanvasElement) {
        NS_WARNING("DoDrawImageSecurityCheck called without canvas element!");
        return;
    }

    if (aCanvasElement->IsWriteOnly())
        return;

    // If we explicitly set WriteOnly just do it and get out
    if (forceWriteOnly) {
        aCanvasElement->SetWriteOnly();
        return;
    }

    // No need to do a security check if the image used CORS for the load
    if (CORSUsed)
        return;

    NS_PRECONDITION(aPrincipal, "Must have a principal here");

    if (aCanvasElement->NodePrincipal()->Subsumes(aPrincipal)) {
        // This canvas has access to that image anyway
        return;
    }

    aCanvasElement->SetWriteOnly();
}

bool
CoerceDouble(JS::Value v, double* d)
{
    if (v.isDouble()) {
        *d = v.toDouble();
    } else if (v.isInt32()) {
        *d = double(v.toInt32());
    } else if (v.isUndefined()) {
        *d = 0.0;
    } else {
        return false;
    }
    return true;
}

} // namespace CanvasUtils
} // namespace mozilla
