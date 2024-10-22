/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/Hal.h"
#include "mozilla/dom/Event.h" // for nsIDOMEvent::InternalDOMEvent()
#include "mozilla/dom/ScreenBinding.h"
#include "nsScreen.h"
#include "nsIDocument.h"
#include "nsIDocShell.h"
#include "nsIDocument.h"
#include "nsPresContext.h"
#include "nsCOMPtr.h"
#include "nsIDocShellTreeItem.h"
#include "nsLayoutUtils.h"
#include "nsJSUtils.h"
#include "nsDeviceContext.h"

using namespace mozilla;
using namespace mozilla::dom;

/* static */ already_AddRefed<nsScreen>
nsScreen::Create(nsPIDOMWindow* aWindow)
{
  MOZ_ASSERT(aWindow);

  if (!aWindow->GetDocShell()) {
    return nullptr;
  }

  nsCOMPtr<nsIScriptGlobalObject> sgo =
    do_QueryInterface(static_cast<nsPIDOMWindow*>(aWindow));
  NS_ENSURE_TRUE(sgo, nullptr);

  nsRefPtr<nsScreen> screen = new nsScreen(aWindow);

  hal::RegisterScreenConfigurationObserver(screen);
  hal::ScreenConfiguration config;
  hal::GetCurrentScreenConfiguration(&config);
  screen->mOrientation = config.orientation();

  return screen.forget();
}

nsScreen::nsScreen(nsPIDOMWindow* aWindow)
  : DOMEventTargetHelper(aWindow)
  , mEventListener(nullptr)
{
}

nsScreen::~nsScreen()
{
  MOZ_ASSERT(!mEventListener);
  hal::UnregisterScreenConfigurationObserver(this);
}


// QueryInterface implementation for nsScreen
NS_INTERFACE_MAP_BEGIN(nsScreen)
  NS_INTERFACE_MAP_ENTRY(nsIDOMScreen)
NS_INTERFACE_MAP_END_INHERITING(DOMEventTargetHelper)

NS_IMPL_ADDREF_INHERITED(nsScreen, DOMEventTargetHelper)
NS_IMPL_RELEASE_INHERITED(nsScreen, DOMEventTargetHelper)

int32_t
nsScreen::GetPixelDepth(ErrorResult& aRv)
{
  // For non-chrome callers, always return 24 to prevent fingerprinting.
  if (!IsChrome()) return 24;

  nsDeviceContext* context = GetDeviceContext();

  if (!context) {
    aRv.Throw(NS_ERROR_FAILURE);
    return -1;
  }

  uint32_t depth;
  context->GetDepth(depth);
  return depth;
}

#define FORWARD_LONG_GETTER(_name)                                              \
  NS_IMETHODIMP                                                                 \
  nsScreen::Get ## _name(int32_t* aOut)                                         \
  {                                                                             \
    ErrorResult rv;                                                             \
    *aOut = Get ## _name(rv);                                                   \
    return rv.ErrorCode();                                                      \
  }

FORWARD_LONG_GETTER(AvailWidth)
FORWARD_LONG_GETTER(AvailHeight)
FORWARD_LONG_GETTER(Width)
FORWARD_LONG_GETTER(Height)

FORWARD_LONG_GETTER(Top)
FORWARD_LONG_GETTER(Left)
FORWARD_LONG_GETTER(AvailTop)
FORWARD_LONG_GETTER(AvailLeft)

FORWARD_LONG_GETTER(PixelDepth)
FORWARD_LONG_GETTER(ColorDepth)

nsDeviceContext*
nsScreen::GetDeviceContext()
{
  return nsLayoutUtils::GetDeviceContextForScreenInfo(GetOwner());
}

nsresult
nsScreen::GetRect(nsRect& aRect)
{
  // For non-chrome callers, return window inner rect to prevent fingerprinting.
  if (!IsChrome()) return GetWindowInnerRect(aRect);

  nsDeviceContext *context = GetDeviceContext();

  if (!context) {
    return NS_ERROR_FAILURE;
  }

  context->GetRect(aRect);

  aRect.x = nsPresContext::AppUnitsToIntCSSPixels(aRect.x);
  aRect.y = nsPresContext::AppUnitsToIntCSSPixels(aRect.y);
  aRect.height = nsPresContext::AppUnitsToIntCSSPixels(aRect.height);
  aRect.width = nsPresContext::AppUnitsToIntCSSPixels(aRect.width);

  return NS_OK;
}

nsresult
nsScreen::GetAvailRect(nsRect& aRect)
{
  // For non-chrome callers, return window inner rect to prevent fingerprinting.
  if (!IsChrome()) return GetWindowInnerRect(aRect);

  nsDeviceContext *context = GetDeviceContext();

  if (!context) {
    return NS_ERROR_FAILURE;
  }

  context->GetClientRect(aRect);

  aRect.x = nsPresContext::AppUnitsToIntCSSPixels(aRect.x);
  aRect.y = nsPresContext::AppUnitsToIntCSSPixels(aRect.y);
  aRect.height = nsPresContext::AppUnitsToIntCSSPixels(aRect.height);
  aRect.width = nsPresContext::AppUnitsToIntCSSPixels(aRect.width);

  return NS_OK;
}

void
nsScreen::Notify(const hal::ScreenConfiguration& aConfiguration)
{
  ScreenOrientation previousOrientation = mOrientation;
  mOrientation = aConfiguration.orientation();

  NS_ASSERTION(mOrientation == eScreenOrientation_PortraitPrimary ||
               mOrientation == eScreenOrientation_PortraitSecondary ||
               mOrientation == eScreenOrientation_LandscapePrimary ||
               mOrientation == eScreenOrientation_LandscapeSecondary,
               "Invalid orientation value passed to notify method!");

  if (mOrientation != previousOrientation) {
    DispatchTrustedEvent(NS_LITERAL_STRING("mozorientationchange"));
  }
}

void
nsScreen::GetMozOrientation(nsString& aOrientation)
{
  switch (mOrientation) {
  case eScreenOrientation_PortraitPrimary:
    aOrientation.AssignLiteral("portrait-primary");
    break;
  case eScreenOrientation_PortraitSecondary:
    aOrientation.AssignLiteral("portrait-secondary");
    break;
  case eScreenOrientation_LandscapePrimary:
    aOrientation.AssignLiteral("landscape-primary");
    break;
  case eScreenOrientation_LandscapeSecondary:
    aOrientation.AssignLiteral("landscape-secondary");
    break;
  case eScreenOrientation_None:
  default:
    MOZ_CRASH("Unacceptable mOrientation value");
  }
}

NS_IMETHODIMP
nsScreen::GetSlowMozOrientation(nsAString& aOrientation)
{
  nsString orientation;
  GetMozOrientation(orientation);
  aOrientation = orientation;
  return NS_OK;
}

nsScreen::LockPermission
nsScreen::GetLockOrientationPermission() const
{
  nsCOMPtr<nsPIDOMWindow> owner = GetOwner();
  if (!owner) {
    return LOCK_DENIED;
  }

  // Chrome can always lock the screen orientation.
  nsIDocShell* docShell = owner->GetDocShell();
  if (docShell && docShell->ItemType() == nsIDocShellTreeItem::typeChrome) {
    return LOCK_ALLOWED;
  }

  nsCOMPtr<nsIDocument> doc = owner->GetDoc();
  if (!doc || doc->Hidden()) {
    return LOCK_DENIED;
  }

  // Apps can always lock the screen orientation.
  if (doc->NodePrincipal()->GetAppStatus() >=
        nsIPrincipal::APP_STATUS_INSTALLED) {
    return LOCK_ALLOWED;
  }

  // Other content must be full-screen in order to lock orientation.
  return doc->MozFullScreen() ? FULLSCREEN_LOCK_ALLOWED : LOCK_DENIED;
}

bool
nsScreen::MozLockOrientation(const nsAString& aOrientation, ErrorResult& aRv)
{
  nsString orientation(aOrientation);
  Sequence<nsString> orientations;
  if (!orientations.AppendElement(orientation)) {
    aRv.Throw(NS_ERROR_OUT_OF_MEMORY);
    return false;
  }
  return MozLockOrientation(orientations, aRv);
}

bool
nsScreen::MozLockOrientation(const Sequence<nsString>& aOrientations,
                             ErrorResult& aRv)
{
  ScreenOrientation orientation = eScreenOrientation_None;

  for (uint32_t i = 0; i < aOrientations.Length(); ++i) {
    const nsString& item = aOrientations[i];

    if (item.EqualsLiteral("portrait")) {
      orientation |= eScreenOrientation_PortraitPrimary |
                     eScreenOrientation_PortraitSecondary;
    } else if (item.EqualsLiteral("portrait-primary")) {
      orientation |= eScreenOrientation_PortraitPrimary;
    } else if (item.EqualsLiteral("portrait-secondary")) {
      orientation |= eScreenOrientation_PortraitSecondary;
    } else if (item.EqualsLiteral("landscape")) {
      orientation |= eScreenOrientation_LandscapePrimary |
                     eScreenOrientation_LandscapeSecondary;
    } else if (item.EqualsLiteral("landscape-primary")) {
      orientation |= eScreenOrientation_LandscapePrimary;
    } else if (item.EqualsLiteral("landscape-secondary")) {
      orientation |= eScreenOrientation_LandscapeSecondary;
    } else if (item.EqualsLiteral("default")) {
      orientation |= eScreenOrientation_Default;
    } else {
      // If we don't recognize the token, we should just return 'false'
      // without throwing.
      return false;
    }
  }

  switch (GetLockOrientationPermission()) {
    case LOCK_DENIED:
      return false;
    case LOCK_ALLOWED:
      return hal::LockScreenOrientation(orientation);
    case FULLSCREEN_LOCK_ALLOWED: {
      // We need to register a listener so we learn when we leave full-screen
      // and when we will have to unlock the screen.
      // This needs to be done before LockScreenOrientation call to make sure
      // the locking can be unlocked.
      nsCOMPtr<EventTarget> target = do_QueryInterface(GetOwner()->GetDoc());
      if (!target) {
        return false;
      }

      if (!hal::LockScreenOrientation(orientation)) {
        return false;
      }

      // We are fullscreen and lock has been accepted.
      if (!mEventListener) {
        mEventListener = new FullScreenEventListener();
      }

      aRv = target->AddSystemEventListener(NS_LITERAL_STRING("mozfullscreenchange"),
                                           mEventListener, /* useCapture = */ true);
      return true;
    }
  }

  // This is only for compilers that don't understand that the previous switch
  // will always return.
  MOZ_CRASH("unexpected lock orientation permission value");
}

void
nsScreen::MozUnlockOrientation()
{
  hal::UnlockScreenOrientation();
}

bool
nsScreen::IsDeviceSizePageSize()
{
  nsPIDOMWindow* owner = GetOwner();
  if (owner) {
    nsIDocShell* docShell = owner->GetDocShell();
    if (docShell) {
      return docShell->GetDeviceSizeIsPageSize();
    }
  }
  return false;
}

/* virtual */
JSObject*
nsScreen::WrapObject(JSContext* aCx)
{
  return ScreenBinding::Wrap(aCx, this);
}

NS_IMPL_ISUPPORTS(nsScreen::FullScreenEventListener, nsIDOMEventListener)

NS_IMETHODIMP
nsScreen::FullScreenEventListener::HandleEvent(nsIDOMEvent* aEvent)
{
#ifdef DEBUG
  nsAutoString eventType;
  aEvent->GetType(eventType);

  MOZ_ASSERT(eventType.EqualsLiteral("mozfullscreenchange"));
#endif

  nsCOMPtr<EventTarget> target = aEvent->InternalDOMEvent()->GetCurrentTarget();
  MOZ_ASSERT(target);

  nsCOMPtr<nsIDocument> doc = do_QueryInterface(target);
  MOZ_ASSERT(doc);

  // We have to make sure that the event we got is the event sent when
  // fullscreen is disabled because we could get one when fullscreen
  // got enabled if the lock call is done at the same moment.
  if (doc->MozFullScreen()) {
    return NS_OK;
  }

  target->RemoveSystemEventListener(NS_LITERAL_STRING("mozfullscreenchange"),
                                    this, true);

  hal::UnlockScreenOrientation();

  return NS_OK;
}

bool
nsScreen::IsChrome()
{
  nsCOMPtr<nsPIDOMWindow> owner = GetOwner();
  if (owner && owner->GetDocShell()) {
    return owner->GetDocShell()->ItemType() == nsIDocShellTreeItem::typeChrome;
  }
  return false;
}

nsresult
nsScreen::GetDOMWindow(nsIDOMWindow **aResult)
{
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = NULL;

  nsCOMPtr<nsPIDOMWindow> owner = GetOwner();
  if (!owner)
    return NS_ERROR_FAILURE;

  nsCOMPtr<nsIDOMWindow> win = do_QueryInterface(owner);
  NS_ENSURE_STATE(win);
  win.swap(*aResult);

  return NS_OK;
}

nsresult
nsScreen::GetWindowInnerRect(nsRect& aRect)
{
  aRect.x = 0;
  aRect.y = 0;
  nsCOMPtr<nsIDOMWindow> win;
  nsresult rv = GetDOMWindow(getter_AddRefs(win));
  NS_ENSURE_SUCCESS(rv, rv);
  rv = win->GetInnerWidth(&aRect.width);
  NS_ENSURE_SUCCESS(rv, rv);
  return win->GetInnerHeight(&aRect.height);
}
