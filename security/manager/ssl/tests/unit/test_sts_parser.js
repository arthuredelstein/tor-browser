/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * vim: sw=2 ts=2 sts=2
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// STS parser tests

let sss = Cc["@mozilla.org/ssservice;1"].getService(Ci.nsISiteSecurityService);
let sslStatus = new FakeSSLStatus();

function testSuccess(header, expectedMaxAge, expectedIncludeSubdomains) {
  let dummyUri = Services.io.newURI("https://foo.com/bar.html");
  let maxAge = {};
  let includeSubdomains = {};

  sss.processHeader(Ci.nsISiteSecurityService.HEADER_HSTS, dummyUri, header,
                    sslStatus, 0, {}, maxAge, includeSubdomains);

  equal(maxAge.value, expectedMaxAge, "Did not correctly parse maxAge");
  equal(includeSubdomains.value, expectedIncludeSubdomains,
        "Did not correctly parse presence/absence of includeSubdomains");
}

function testFailure(header) {
  let dummyUri = Services.io.newURI("https://foo.com/bar.html");
  throws(() => {
    sss.processHeader(Ci.nsISiteSecurityService.HEADER_HSTS, dummyUri, header,
                      sslStatus, 0, {}, maxAge, includeSubdomains);
  }, "Parsed invalid header: " + header);
}

function run_test() {
    // SHOULD SUCCEED:
<<<<<<< HEAD
    TestSuccess("max-age=100", false, 100, false, sss);
    TestSuccess("max-age  =100", false, 100, false, sss);
    TestSuccess(" max-age=100", false, 100, false, sss);
    TestSuccess("max-age = 100 ", false, 100, false, sss);
    TestSuccess("max-age = \"100\" ", false, 100, false, sss);
    TestSuccess("max-age=\"100\"", false, 100, false, sss);
    TestSuccess(" max-age =\"100\" ", false, 100, false, sss);
    TestSuccess("\tmax-age\t=\t\"100\"\t", false, 100, false, sss);
    TestSuccess("max-age  =       100             ", false, 100, false, sss);

    TestSuccess("maX-aGe=100", false, 100, false, sss);
    TestSuccess("MAX-age  =100", false, 100, false, sss);
    TestSuccess("max-AGE=100", false, 100, false, sss);
    TestSuccess("Max-Age = 100 ", false, 100, false, sss);
    TestSuccess("MAX-AGE = 100 ", false, 100, false, sss);

    TestSuccess("max-age=100;includeSubdomains", false, 100, true, sss);
    TestSuccess("max-age=100\t; includeSubdomains", false, 100, true, sss);
    TestSuccess(" max-age=100; includeSubdomains", false, 100, true, sss);
    TestSuccess("max-age = 100 ; includeSubdomains", false, 100, true, sss);
    TestSuccess("max-age  =       100             ; includeSubdomains",
                false, 100, true, sss);

    TestSuccess("maX-aGe=100; includeSUBDOMAINS", false, 100, true, sss);
    TestSuccess("MAX-age  =100; includeSubDomains", false, 100, true, sss);
    TestSuccess("max-AGE=100; iNcLuDeSuBdoMaInS", false, 100, true, sss);
    TestSuccess("Max-Age = 100; includesubdomains ", false, 100, true, sss);
    TestSuccess("INCLUDESUBDOMAINS;MaX-AgE = 100 ", false, 100, true, sss);
=======
    testSuccess("max-age=100", 100, false);
    testSuccess("max-age  =100", 100, false);
    testSuccess(" max-age=100", 100, false);
    testSuccess("max-age = 100 ", 100, false);
    testSuccess('max-age = "100" ', 100, false);
    testSuccess('max-age="100"', 100, false);
    testSuccess(' max-age ="100" ', 100, false);
    testSuccess("\tmax-age\t=\t\"100\"\t", 100, false);
    testSuccess("max-age  =       100             ", 100, false);

    testSuccess("maX-aGe=100", 100, false);
    testSuccess("MAX-age  =100", 100, false);
    testSuccess("max-AGE=100", 100, false);
    testSuccess("Max-Age = 100 ", 100, false);
    testSuccess("MAX-AGE = 100 ", 100, false);

    testSuccess("max-age=100;includeSubdomains", 100, true);
    testSuccess("max-age=100\t; includeSubdomains", 100, true);
    testSuccess(" max-age=100; includeSubdomains", 100, true);
    testSuccess("max-age = 100 ; includeSubdomains", 100, true);
    testSuccess("max-age  =       100             ; includeSubdomains", 100,
                true);

    testSuccess("maX-aGe=100; includeSUBDOMAINS", 100, true);
    testSuccess("MAX-age  =100; includeSubDomains", 100, true);
    testSuccess("max-AGE=100; iNcLuDeSuBdoMaInS", 100, true);
    testSuccess("Max-Age = 100; includesubdomains ", 100, true);
    testSuccess("INCLUDESUBDOMAINS;MaX-AgE = 100 ", 100, true);
>>>>>>> e28cb31... Bug 1336867 - Remove unsafeProcessHeader and isSecureHost in nsISiteSecurityService r=keeler,mgoodwin,past
    // Turns out, the actual directive is entirely optional (hence the
    // trailing semicolon)
    testSuccess("max-age=100;includeSubdomains;", 100, true);

    // these are weird tests, but are testing that some extended syntax is
    // still allowed (but it is ignored)
<<<<<<< HEAD
    TestSuccess("max-age=100 ; includesubdomainsSomeStuff",
                true, 100, false, sss);
    TestSuccess("\r\n\t\t    \tcompletelyUnrelated = foobar; max-age= 34520103"
                "\t \t; alsoUnrelated;asIsThis;\tincludeSubdomains\t\t \t",
                true, 34520103, true, sss);
    TestSuccess("max-age=100; unrelated=\"quoted \\\"thingy\\\"\"",
                true, 100, false, sss);
=======
    testSuccess("max-age=100 ; includesubdomainsSomeStuff", 100, false);
    testSuccess("\r\n\t\t    \tcompletelyUnrelated = foobar; max-age= 34520103"
                + "\t \t; alsoUnrelated;asIsThis;\tincludeSubdomains\t\t \t",
                34520103, true);
    testSuccess('max-age=100; unrelated="quoted \\"thingy\\""', 100, false);
>>>>>>> e28cb31... Bug 1336867 - Remove unsafeProcessHeader and isSecureHost in nsISiteSecurityService r=keeler,mgoodwin,past

    // SHOULD FAIL:
    // invalid max-ages
    testFailure("max-age");
    testFailure("max-age ");
    testFailure("max-age=p");
    testFailure("max-age=*1p2");
    testFailure("max-age=.20032");
    testFailure("max-age=!20032");
    testFailure("max-age==20032");

    // invalid headers
<<<<<<< HEAD
    TestFailure("foobar", sss);
    TestFailure("maxage=100", sss);
    TestFailure("maxa-ge=100", sss);
    TestFailure("max-ag=100", sss);
    TestFailure("includesubdomains", sss);
    TestFailure(";", sss);
    TestFailure("max-age=\"100", sss);
=======
    testFailure("foobar");
    testFailure("maxage=100");
    testFailure("maxa-ge=100");
    testFailure("max-ag=100");
    testFailure("includesubdomains");
    testFailure(";");
    testFailure('max-age="100');
>>>>>>> e28cb31... Bug 1336867 - Remove unsafeProcessHeader and isSecureHost in nsISiteSecurityService r=keeler,mgoodwin,past
    // The max-age directive here doesn't conform to the spec, so it MUST
    // be ignored. Consequently, the REQUIRED max-age directive is not
    // present in this header, and so it is invalid.
    testFailure("max-age=100, max-age=200; includeSubdomains");
    testFailure("max-age=100 includesubdomains");
    testFailure("max-age=100 bar foo");
    testFailure("max-age=100randomstuffhere");
    // All directives MUST appear only once in an STS header field.
    testFailure("max-age=100; max-age=200");
    testFailure("includeSubdomains; max-age=200; includeSubdomains");
    testFailure("max-age=200; includeSubdomains; includeSubdomains");
    // The includeSubdomains directive is valueless.
    testFailure("max-age=100; includeSubdomains=unexpected");
    // LWS must have at least one space or horizontal tab
    testFailure("\r\nmax-age=200");
}
