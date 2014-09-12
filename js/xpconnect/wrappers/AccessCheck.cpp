/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim: set ts=8 sts=4 et sw=4 tw=99: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "AccessCheck.h"

#include "nsJSPrincipals.h"
#include "nsGlobalWindow.h"

#include "XPCWrapper.h"
#include "XrayWrapper.h"

#include "jsfriendapi.h"
#include "mozilla/dom/BindingUtils.h"
#include "mozilla/dom/LocationBinding.h"
#include "mozilla/dom/WindowBinding.h"
#include "nsIDOMWindowCollection.h"
#include "nsJSUtils.h"

using namespace mozilla;
using namespace JS;
using namespace js;

namespace xpc {

nsIPrincipal *
GetCompartmentPrincipal(JSCompartment *compartment)
{
    return nsJSPrincipals::get(JS_GetCompartmentPrincipals(compartment));
}

nsIPrincipal *
GetObjectPrincipal(JSObject *obj)
{
    return GetCompartmentPrincipal(js::GetObjectCompartment(obj));
}

// Does the principal of compartment a subsume the principal of compartment b?
bool
AccessCheck::subsumes(JSCompartment *a, JSCompartment *b)
{
    nsIPrincipal *aprin = GetCompartmentPrincipal(a);
    nsIPrincipal *bprin = GetCompartmentPrincipal(b);
    return aprin->Subsumes(bprin);
}

bool
AccessCheck::subsumes(JSObject *a, JSObject *b)
{
    return subsumes(js::GetObjectCompartment(a), js::GetObjectCompartment(b));
}

// Same as above, but considering document.domain.
bool
AccessCheck::subsumesConsideringDomain(JSCompartment *a, JSCompartment *b)
{
    nsIPrincipal *aprin = GetCompartmentPrincipal(a);
    nsIPrincipal *bprin = GetCompartmentPrincipal(b);
    return aprin->SubsumesConsideringDomain(bprin);
}

// Does the compartment of the wrapper subsumes the compartment of the wrappee?
bool
AccessCheck::wrapperSubsumes(JSObject *wrapper)
{
    MOZ_ASSERT(js::IsWrapper(wrapper));
    JSObject *wrapped = js::UncheckedUnwrap(wrapper);
    return AccessCheck::subsumes(js::GetObjectCompartment(wrapper),
                                 js::GetObjectCompartment(wrapped));
}

bool
AccessCheck::isChrome(JSCompartment *compartment)
{
    bool privileged;
    nsIPrincipal *principal = GetCompartmentPrincipal(compartment);
    return NS_SUCCEEDED(nsXPConnect::SecurityManager()->IsSystemPrincipal(principal, &privileged)) && privileged;
}

bool
AccessCheck::isChrome(JSObject *obj)
{
    return isChrome(js::GetObjectCompartment(obj));
}

nsIPrincipal *
AccessCheck::getPrincipal(JSCompartment *compartment)
{
    return GetCompartmentPrincipal(compartment);
}

// Hardcoded policy for cross origin property access. See the HTML5 Spec.
static bool
IsPermitted(const char *name, JSFlatString *prop, bool set)
{
    size_t propLength = JS_GetStringLength(JS_FORGET_STRING_FLATNESS(prop));
    if (!propLength)
        return false;

    char16_t propChar0 = JS_GetFlatStringCharAt(prop, 0);
    if (name[0] == 'L' && !strcmp(name, "Location"))
        return dom::LocationBinding::IsPermitted(prop, propChar0, set);
    if (name[0] == 'W' && !strcmp(name, "Window"))
        return dom::WindowBinding::IsPermitted(prop, propChar0, set);

    return false;
}

static bool
IsFrameId(JSContext *cx, JSObject *objArg, jsid idArg)
{
    RootedObject obj(cx, objArg);
    RootedId id(cx, idArg);

    obj = JS_ObjectToInnerObject(cx, obj);
    MOZ_ASSERT(!js::IsWrapper(obj));
    nsGlobalWindow* win = WindowOrNull(obj);
    if (!win) {
        return false;
    }

    nsCOMPtr<nsIDOMWindowCollection> col;
    win->GetFrames(getter_AddRefs(col));
    if (!col) {
        return false;
    }

    nsCOMPtr<nsIDOMWindow> domwin;
    if (JSID_IS_INT(id)) {
        col->Item(JSID_TO_INT(id), getter_AddRefs(domwin));
    } else if (JSID_IS_STRING(id)) {
        nsAutoJSString idAsString;
        if (!idAsString.init(cx, JSID_TO_STRING(id))) {
            return false;
        }
        col->NamedItem(idAsString, getter_AddRefs(domwin));
    }

    return domwin != nullptr;
}

static bool
IsWindow(const char *name)
{
    return name[0] == 'W' && !strcmp(name, "Window");
}

bool
AccessCheck::isCrossOriginAccessPermitted(JSContext *cx, HandleObject wrapper, HandleId id,
                                          Wrapper::Action act)
{
    if (act == Wrapper::CALL)
        return false;

    if (act == Wrapper::ENUMERATE)
        return true;

    // For the case of getting a property descriptor, we allow if either GET or SET
    // is allowed, and rely on FilteringWrapper to filter out any disallowed accessors.
    if (act == Wrapper::GET_PROPERTY_DESCRIPTOR) {
        return isCrossOriginAccessPermitted(cx, wrapper, id, Wrapper::GET) ||
               isCrossOriginAccessPermitted(cx, wrapper, id, Wrapper::SET);
    }

    RootedObject obj(cx, Wrapper::wrappedObject(wrapper));

    const char *name;
    const js::Class *clasp = js::GetObjectClass(obj);
    MOZ_ASSERT(!XrayUtils::IsXPCWNHolderClass(Jsvalify(clasp)), "shouldn't have a holder here");
    if (clasp->ext.innerObject)
        name = "Window";
    else
        name = clasp->name;

    if (JSID_IS_STRING(id)) {
        if (IsPermitted(name, JSID_TO_FLAT_STRING(id), act == Wrapper::SET))
            return true;
    }

    if (act != Wrapper::GET)
        return false;

    // Check for frame IDs. If we're resolving named frames, make sure to only
    // resolve ones that don't shadow native properties. See bug 860494.
    if (IsWindow(name)) {
        if (JSID_IS_STRING(id) && !XrayUtils::IsXrayResolving(cx, wrapper, id)) {
            bool wouldShadow = false;
            if (!XrayUtils::HasNativeProperty(cx, wrapper, id, &wouldShadow) ||
                wouldShadow)
            {
                // If the named subframe matches the name of a DOM constructor,
                // the global resolve triggered by the HasNativeProperty call
                // above will try to perform a CheckedUnwrap on |wrapper|, and
                // throw a security error if it fails. That exception isn't
                // really useful for our callers, so we silence it and just
                // deny access to the property (since it matched a builtin).
                //
                // Note that this would be a problem if the resolve code ever
                // tried to CheckedUnwrap the wrapper _before_ concluding that
                // the name corresponds to a builtin global property, since it
                // would mean that we'd never permit cross-origin named subframe
                // access (something we regrettably need to support).
                JS_ClearPendingException(cx);
                return false;
            }
        }
        return IsFrameId(cx, obj, id);
    }
    return false;
}

enum Access { READ = (1<<0), WRITE = (1<<1), NO_ACCESS = 0 };

static void
EnterAndThrow(JSContext *cx, JSObject *wrapper, const char *msg)
{
    JSAutoCompartment ac(cx, wrapper);
    JS_ReportError(cx, msg);
}

bool
ExposedPropertiesOnly::check(JSContext *cx, HandleObject wrapper, HandleId id, Wrapper::Action act)
{
    RootedObject wrappedObject(cx, Wrapper::wrappedObject(wrapper));

    if (act == Wrapper::CALL)
        return true;


    // For the case of getting a property descriptor, we allow if either GET or SET
    // is allowed, and rely on FilteringWrapper to filter out any disallowed accessors.
    if (act == Wrapper::GET_PROPERTY_DESCRIPTOR) {
        return check(cx, wrapper, id, Wrapper::GET) ||
               check(cx, wrapper, id, Wrapper::SET);
    }

    RootedId exposedPropsId(cx, GetRTIdByIndex(cx, XPCJSRuntime::IDX_EXPOSEDPROPS));

    // We need to enter the wrappee's compartment to look at __exposedProps__,
    // but we want to be in the wrapper's compartment if we call Deny().
    //
    // Unfortunately, |cx| can be in either compartment when we call ::check. :-(
    JSAutoCompartment ac(cx, wrappedObject);

    bool found = false;
    if (!JS_HasPropertyById(cx, wrappedObject, exposedPropsId, &found))
        return false;

    // Always permit access to "length" and indexed properties of arrays.
    if ((JS_IsArrayObject(cx, wrappedObject) ||
         JS_IsTypedArrayObject(wrappedObject)) &&
        ((JSID_IS_INT(id) && JSID_TO_INT(id) >= 0) ||
         (JSID_IS_STRING(id) && JS_FlatStringEqualsAscii(JSID_TO_FLAT_STRING(id), "length")))) {
        return true; // Allow
    }

    // If no __exposedProps__ existed, deny access.
    if (!found) {
        return false;
    }

    if (id == JSID_VOID)
        return true;

    RootedValue exposedProps(cx);
    if (!JS_LookupPropertyById(cx, wrappedObject, exposedPropsId, &exposedProps))
        return false;

    if (exposedProps.isNullOrUndefined())
        return false;

    if (!exposedProps.isObject()) {
        EnterAndThrow(cx, wrapper, "__exposedProps__ must be undefined, null, or an Object");
        return false;
    }

    RootedObject hallpass(cx, &exposedProps.toObject());

    if (!AccessCheck::subsumes(js::UncheckedUnwrap(hallpass), wrappedObject)) {
        EnterAndThrow(cx, wrapper, "Invalid __exposedProps__");
        return false;
    }

    Access access = NO_ACCESS;

    Rooted<JSPropertyDescriptor> desc(cx);
    if (!JS_GetPropertyDescriptorById(cx, hallpass, id, &desc)) {
        return false; // Error
    }
    if (!desc.object() || !desc.isEnumerable())
        return false;

    if (!desc.value().isString()) {
        EnterAndThrow(cx, wrapper, "property must be a string");
        return false;
    }

    JSFlatString *flat = JS_FlattenString(cx, desc.value().toString());
    if (!flat)
        return false;

    size_t length = JS_GetStringLength(JS_FORGET_STRING_FLATNESS(flat));

    for (size_t i = 0; i < length; ++i) {
        char16_t ch = JS_GetFlatStringCharAt(flat, i);
        switch (ch) {
        case 'r':
            if (access & READ) {
                EnterAndThrow(cx, wrapper, "duplicate 'readable' property flag");
                return false;
            }
            access = Access(access | READ);
            break;

        case 'w':
            if (access & WRITE) {
                EnterAndThrow(cx, wrapper, "duplicate 'writable' property flag");
                return false;
            }
            access = Access(access | WRITE);
            break;

        default:
            EnterAndThrow(cx, wrapper, "properties can only be readable or read and writable");
            return false;
        }
    }

    if (access == NO_ACCESS) {
        EnterAndThrow(cx, wrapper, "specified properties must have a permission bit set");
        return false;
    }

    if ((act == Wrapper::SET && !(access & WRITE)) ||
        (act != Wrapper::SET && !(access & READ))) {
        return false;
    }

    return true;
}

}
