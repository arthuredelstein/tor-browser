#include <winnetwk.h>
#include "nsWindowsDllInterceptor.h"

static mozilla::WindowsDllInterceptor sMprDllIntercept;

typedef DWORD(WINAPI* WNetGetResourceInformationWFnPtr)(
  _In_    LPNETRESOURCEW lpNetResource,
  _Out_   LPVOID         lpBuffer,
  _Inout_ LPDWORD        lpcbBuffer,
  _Out_   LPWSTR         *lplpSystem
);

static WNetGetResourceInformationWFnPtr original_WNetGetResourceInformationW = nullptr;

DWORD patched_WNetGetResourceInformationW(
  _In_    LPNETRESOURCEW lpNetResource,
  _Out_   LPVOID        lpBuffer,
  _Inout_ LPDWORD       lpcbBuffer,
  _Out_   LPTSTR        *lplpSystem
)
{

  return ERROR_BAD_NET_NAME;
  //printf("lpNetResource->lpRemoteName: %S\n", lpNetResource->lpRemoteName);
  //  return original_WNetGetResourceInformationW(lpNetResource, lpBuffer, lpcbBuffer, lplpSystem);
}

static bool preventMprLeaks()
{
    sMprDllIntercept.Init("mpr.dll");
    bool ok = sMprDllIntercept.AddHook(
      "WNetGetResourceInformationW",
      reinterpret_cast<intptr_t>(patched_WNetGetResourceInformationW),
      (void**)(&original_WNetGetResourceInformationW));
    return ok;
}
