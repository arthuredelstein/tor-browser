// Copyright (c) 2018, The Tor Project, Inc.
// See LICENSE for licensing information.
//
// vim: set sw=2 sts=2 ts=8 et syntax=javascript:

function init()
{
  let event = new CustomEvent("AboutTBUpdateLoad", { bubbles: true });
  document.dispatchEvent(event);
}

function showNewFeaturesOnboarding()
{
  let event = new CustomEvent("AboutTBUpdateNewFeaturesOnboarding",
                              { bubbles: true });
  document.dispatchEvent(event);
}
