# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import imp
import os
import re
import functools
import sys
import socket
import time
import types
import unittest
import weakref
import warnings

from errors import (
        ErrorCodes, MarionetteException, InstallGeckoError, TimeoutException, InvalidResponseException,
        JavascriptException, NoSuchElementException, XPathLookupException, NoSuchWindowException,
        StaleElementException, ScriptTimeoutException, ElementNotVisibleException,
        NoSuchFrameException, InvalidElementStateException, NoAlertPresentException,
        InvalidCookieDomainException, UnableToSetCookieException, InvalidSelectorException,
        MoveTargetOutOfBoundsException, FrameSendNotInitializedError, FrameSendFailureError
        )
from marionette import Marionette
from mozlog.structured.structuredlog import get_default_logger
from wait import Wait
from expected import element_present, element_not_present


class SkipTest(Exception):
    """
    Raise this exception in a test to skip it.

    Usually you can use TestResult.skip() or one of the skipping decorators
    instead of raising this directly.
    """
    pass

class _ExpectedFailure(Exception):
    """
    Raise this when a test is expected to fail.

    This is an implementation detail.
    """

    def __init__(self, exc_info):
        super(_ExpectedFailure, self).__init__()
        self.exc_info = exc_info

class _UnexpectedSuccess(Exception):
    """
    The test was supposed to fail, but it didn't!
    """
    pass

def skip(reason):
    """
    Unconditionally skip a test.
    """
    def decorator(test_item):
        if not isinstance(test_item, (type, types.ClassType)):
            @functools.wraps(test_item)
            def skip_wrapper(*args, **kwargs):
                raise SkipTest(reason)
            test_item = skip_wrapper

        test_item.__unittest_skip__ = True
        test_item.__unittest_skip_why__ = reason
        return test_item
    return decorator

def expectedFailure(func):
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            func(*args, **kwargs)
        except Exception:
            raise _ExpectedFailure(sys.exc_info())
        raise _UnexpectedSuccess
    return wrapper

def skip_if_b2g(target):
    def wrapper(self, *args, **kwargs):
        if not self.marionette.session_capabilities['device'] == 'qemu':
            return target(self, *args, **kwargs)
        else:
            raise SkipTest('skipping due to b2g')
    return wrapper

def parameterized(func_suffix, *args, **kwargs):
    """
    A decorator that can generate methods given a base method and some data.

    **func_suffix** is used as a suffix for the new created method and must be
    unique given a base method. if **func_suffix** countains characters that
    are not allowed in normal python function name, these characters will be
    replaced with "_".

    This decorator can be used more than once on a single base method. The class
    must have a metaclass of :class:`MetaParameterized`.

    Example::

      # This example will generate two methods:
      #
      # - MyTestCase.test_it_1
      # - MyTestCase.test_it_2
      #
      class MyTestCase(MarionetteTestCase):
          @parameterized("1", 5, named='name')
          @parameterized("2", 6, named='name2')
          def test_it(self, value, named=None):
              print value, named

    :param func_suffix: will be used as a suffix for the new method
    :param \*args: arguments to pass to the new method
    :param \*\*kwargs: named arguments to pass to the new method
    """
    def wrapped(func):
        if not hasattr(func, 'metaparameters'):
            func.metaparameters = []
        func.metaparameters.append((func_suffix, args, kwargs))
        return func
    return wrapped

def with_parameters(parameters):
    """
    A decorator that can generate methods given a base method and some data.
    Acts like :func:`parameterized`, but define all methods in one call.

    Example::

      # This example will generate two methods:
      #
      # - MyTestCase.test_it_1
      # - MyTestCase.test_it_2
      #

      DATA = [("1", [5], {'named':'name'}), ("2", [6], {'named':'name2'})]

      class MyTestCase(MarionetteTestCase):
          @with_parameters(DATA)
          def test_it(self, value, named=None):
              print value, named

    :param parameters: list of tuples (**func_suffix**, **args**, **kwargs**)
                       defining parameters like in :func:`todo`.
    """
    def wrapped(func):
        func.metaparameters = parameters
        return func
    return wrapped

def wraps_parameterized(func, func_suffix, args, kwargs):
    """Internal: for MetaParameterized"""
    def wrapper(self):
        return func(self, *args, **kwargs)
    wrapper.__name__ = func.__name__ + '_' + str(func_suffix)
    wrapper.__doc__ = '[%s] %s' % (func_suffix, func.__doc__)
    return wrapper

class MetaParameterized(type):
    """
    A metaclass that allow a class to use decorators like :func:`parameterized`
    or :func:`with_parameters` to generate new methods.
    """
    RE_ESCAPE_BAD_CHARS = re.compile(r'[\.\(\) -/]')
    def __new__(cls, name, bases, attrs):
        for k, v in attrs.items():
            if callable(v) and hasattr(v, 'metaparameters'):
                for func_suffix, args, kwargs in v.metaparameters:
                    func_suffix = cls.RE_ESCAPE_BAD_CHARS.sub('_', func_suffix)
                    wrapper = wraps_parameterized(v, func_suffix, args, kwargs)
                    if wrapper.__name__ in attrs:
                        raise KeyError("%s is already a defined method on %s" %
                                        (wrapper.__name__, name))
                    attrs[wrapper.__name__] = wrapper
                del attrs[k]

        return type.__new__(cls, name, bases, attrs)

class CommonTestCase(unittest.TestCase):

    __metaclass__ = MetaParameterized
    match_re = None
    failureException = AssertionError

    def __init__(self, methodName, **kwargs):
        unittest.TestCase.__init__(self, methodName)
        self.loglines = []
        self.duration = 0
        self.start_time = 0
        self.expected = kwargs.pop('expected', 'pass')

    def _addSkip(self, result, reason):
        addSkip = getattr(result, 'addSkip', None)
        if addSkip is not None:
            addSkip(self, reason)
        else:
            warnings.warn("TestResult has no addSkip method, skips not reported",
                          RuntimeWarning, 2)
            result.addSuccess(self)

    def run(self, result=None):
        # Bug 967566 suggests refactoring run, which would hopefully
        # mean getting rid of this inner function, which only sits
        # here to reduce code duplication:
        def expected_failure(result, exc_info):
            addExpectedFailure = getattr(result, "addExpectedFailure", None)
            if addExpectedFailure is not None:
                addExpectedFailure(self, exc_info)
            else:
                warnings.warn("TestResult has no addExpectedFailure method, "
                              "reporting as passes", RuntimeWarning)
                result.addSuccess(self)

        self.start_time = time.time()
        orig_result = result
        if result is None:
            result = self.defaultTestResult()
            startTestRun = getattr(result, 'startTestRun', None)
            if startTestRun is not None:
                startTestRun()

        result.startTest(self)

        testMethod = getattr(self, self._testMethodName)
        if (getattr(self.__class__, "__unittest_skip__", False) or
            getattr(testMethod, "__unittest_skip__", False)):
            # If the class or method was skipped.
            try:
                skip_why = (getattr(self.__class__, '__unittest_skip_why__', '')
                            or getattr(testMethod, '__unittest_skip_why__', ''))
                self._addSkip(result, skip_why)
            finally:
                result.stopTest(self)
            self.stop_time = time.time()
            return
        try:
            success = False
            try:
                if self.expected == "fail":
                    try:
                        self.setUp()
                    except Exception:
                        raise _ExpectedFailure(sys.exc_info())
                else:
                    self.setUp()
            except SkipTest as e:
                self._addSkip(result, str(e))
            except KeyboardInterrupt:
                raise
            except _ExpectedFailure as e:
                expected_failure(result, e.exc_info)
            except:
                result.addError(self, sys.exc_info())
            else:
                try:
                    if self.expected == 'fail':
                        try:
                            testMethod()
                        except:
                            raise _ExpectedFailure(sys.exc_info())
                        raise _UnexpectedSuccess
                    else:
                        testMethod()
                except self.failureException:
                    result.addFailure(self, sys.exc_info())
                except KeyboardInterrupt:
                    raise
                except _ExpectedFailure as e:
                    expected_failure(result, e.exc_info)
                except _UnexpectedSuccess:
                    addUnexpectedSuccess = getattr(result, 'addUnexpectedSuccess', None)
                    if addUnexpectedSuccess is not None:
                        addUnexpectedSuccess(self)
                    else:
                        warnings.warn("TestResult has no addUnexpectedSuccess method, reporting as failures",
                                      RuntimeWarning)
                        result.addFailure(self, sys.exc_info())
                except SkipTest as e:
                    self._addSkip(result, str(e))
                except:
                    result.addError(self, sys.exc_info())
                else:
                    success = True
                try:
                    if self.expected == "fail":
                        try:
                            self.tearDown()
                        except:
                            raise _ExpectedFailure(sys.exc_info())
                    else:
                        self.tearDown()
                except KeyboardInterrupt:
                    raise
                except _ExpectedFailure as e:
                    expected_failure(result, e.exc_info)
                except:
                    result.addError(self, sys.exc_info())
                    success = False
            # Here we could handle doCleanups() instead of calling cleanTest directly
            self.cleanTest()

            if success:
                result.addSuccess(self)

        finally:
            result.stopTest(self)
            if orig_result is None:
                stopTestRun = getattr(result, 'stopTestRun', None)
                if stopTestRun is not None:
                    stopTestRun()

    @classmethod
    def match(cls, filename):
        """
        Determines if the specified filename should be handled by this
        test class; this is done by looking for a match for the filename
        using cls.match_re.
        """
        if not cls.match_re:
            return False
        m = cls.match_re.match(filename)
        return m is not None

    @classmethod
    def add_tests_to_suite(cls, mod_name, filepath, suite, testloader, marionette, testvars):
        """
        Adds all the tests in the specified file to the specified suite.
        """
        raise NotImplementedError

    @property
    def test_name(self):
        if hasattr(self, 'jsFile'):
            return os.path.basename(self.jsFile)
        else:
            return '%s.py %s.%s' % (self.__class__.__module__,
                                    self.__class__.__name__,
                                    self._testMethodName)

    def id(self):
        # TBPL starring requires that the "test name" field of a failure message
        # not differ over time. The test name to be used is passed to
        # mozlog.structured via the test id, so this is overriden to maintain
        # consistency.
        return self.test_name

    def set_up_test_page(self, emulator, url="test.html", permissions=None):
        emulator.set_context("content")
        url = emulator.absolute_url(url)
        emulator.navigate(url)

        if not permissions:
            return

        emulator.set_context("chrome")
        emulator.execute_script("""
Components.utils.import("resource://gre/modules/Services.jsm");
let [url, permissions] = arguments;
let uri = Services.io.newURI(url, null, null);
permissions.forEach(function (perm) {
    Services.perms.add(uri, "sms", Components.interfaces.nsIPermissionManager.ALLOW_ACTION);
});
        """, [url, permissions])
        emulator.set_context("content")

    def setUp(self):
        # Convert the marionette weakref to an object, just for the
        # duration of the test; this is deleted in tearDown() to prevent
        # a persistent circular reference which in turn would prevent
        # proper garbage collection.
        self.start_time = time.time()
        self.marionette = self._marionette_weakref()
        if self.marionette.session is None:
            self.marionette.start_session()
        if self.marionette.timeout is not None:
            self.marionette.timeouts(self.marionette.TIMEOUT_SEARCH, self.marionette.timeout)
            self.marionette.timeouts(self.marionette.TIMEOUT_SCRIPT, self.marionette.timeout)
            self.marionette.timeouts(self.marionette.TIMEOUT_PAGE, self.marionette.timeout)
        else:
            self.marionette.timeouts(self.marionette.TIMEOUT_PAGE, 30000)
        if hasattr(self, 'test_container') and self.test_container:
            self.switch_into_test_container()
        else:
            if self.marionette.session_capabilities.has_key('b2g') \
            and self.marionette.session_capabilities['b2g'] == True:
                self.close_test_container()

    def tearDown(self):
        pass

    def cleanTest(self):
        self._deleteSession()

    def _deleteSession(self):
        if hasattr(self, 'start_time'):
            self.duration = time.time() - self.start_time
        if hasattr(self.marionette, 'session'):
            if self.marionette.session is not None:
                try:
                    self.loglines.extend(self.marionette.get_logs())
                except Exception, inst:
                    self.loglines = [['Error getting log: %s' % inst]]
                try:
                    self.marionette.delete_session()
                except (socket.error, MarionetteException, IOError):
                    # Gecko has crashed?
                    self.marionette.session = None
                    try:
                        self.marionette.client.close()
                    except socket.error:
                        pass
        self.marionette = None

    def switch_into_test_container(self):
        self.marionette.set_context("content")
        frame = None
        try:
            frame = self.marionette.find_element(
                'css selector',
                'iframe[src*="app://test-container.gaiamobile.org/index.html"]'
            )
        except NoSuchElementException:
            result = self.marionette.execute_async_script("""
if((navigator.mozSettings == undefined) || (navigator.mozSettings == null) || (navigator.mozApps == undefined) || (navigator.mozApps == null)) {
    marionetteScriptFinished(false);
    return;
}
let setReq = navigator.mozSettings.createLock().set({'lockscreen.enabled': false});
setReq.onsuccess = function() {
    let appsReq = navigator.mozApps.mgmt.getAll();
    appsReq.onsuccess = function() {
        let apps = appsReq.result;
        for (let i = 0; i < apps.length; i++) {
            let app = apps[i];
            if (app.manifest.name === 'Test Container') {
                app.launch();
                window.addEventListener('apploadtime', function apploadtime(){
                    window.removeEventListener('apploadtime', apploadtime);
                    marionetteScriptFinished(true);
                });
                return;
            }
        }
        marionetteScriptFinished(false);
    }
    appsReq.onerror = function() {
        marionetteScriptFinished(false);
    }
}
setReq.onerror = function() {
    marionetteScriptFinished(false);
}""", script_timeout=60000)

            self.assertTrue(result)
            frame = Wait(self.marionette, timeout=10, interval=0.2).until(element_present(
                'css selector',
                'iframe[src*="app://test-container.gaiamobile.org/index.html"]'
            ))

        self.marionette.switch_to_frame(frame)

    def close_test_container(self):
        self.marionette.set_context("content")
        self.marionette.switch_to_frame()
        result = self.marionette.execute_async_script("""
if((navigator.mozSettings == undefined) || (navigator.mozSettings == null) || (navigator.mozApps == undefined) || (navigator.mozApps == null)) {
    marionetteScriptFinished(false);
    return;
}
let setReq = navigator.mozSettings.createLock().set({'lockscreen.enabled': false});
setReq.onsuccess = function() {
    let appsReq = navigator.mozApps.mgmt.getAll();
    appsReq.onsuccess = function() {
        let apps = appsReq.result;
        for (let i = 0; i < apps.length; i++) {
            let app = apps[i];
            if (app.manifest.name === 'Test Container') {
                let manager = window.wrappedJSObject.AppWindowManager || window.wrappedJSObject.WindowManager;
                if (!manager) {
                    marionetteScriptFinished(false);
                    return;
                }
                manager.kill(app.origin);
                marionetteScriptFinished(true);
                return;
            }
        }
        marionetteScriptFinished(false);
    }
    appsReq.onerror = function() {
        marionetteScriptFinished(false);
    }
}
setReq.onerror = function() {
    marionetteScriptFinished(false);
}""", script_timeout=60000)

        frame = Wait(self.marionette, timeout=10, interval=0.2).until(element_not_present(
            'css selector',
            'iframe[src*="app://test-container.gaiamobile.org/index.html"]'
        ))


class MarionetteTestCase(CommonTestCase):

    match_re = re.compile(r"test_(.*)\.py$")

    def __init__(self, marionette_weakref, methodName='runTest',
                 filepath='', **kwargs):
        self._marionette_weakref = marionette_weakref
        self.marionette = None
        self.extra_emulator_index = -1
        self.methodName = methodName
        self.filepath = filepath
        self.testvars = kwargs.pop('testvars', None)
        self.test_container = kwargs.pop('test_container', False)
        CommonTestCase.__init__(self, methodName, **kwargs)

    @classmethod
    def add_tests_to_suite(cls, mod_name, filepath, suite, testloader, marionette, testvars, **kwargs):
        test_mod = imp.load_source(mod_name, filepath)

        for name in dir(test_mod):
            obj = getattr(test_mod, name)
            if (isinstance(obj, (type, types.ClassType)) and
                issubclass(obj, unittest.TestCase)):
                testnames = testloader.getTestCaseNames(obj)
                for testname in testnames:
                    suite.addTest(obj(weakref.ref(marionette),
                                  methodName=testname,
                                  filepath=filepath,
                                  testvars=testvars,
                                  **kwargs))

    def setUp(self):
        CommonTestCase.setUp(self)
        self.marionette.test_name = self.test_name
        self.marionette.execute_script("log('TEST-START: %s:%s')" %
                                       (self.filepath.replace('\\', '\\\\'), self.methodName))

    def tearDown(self):
        self.marionette.check_for_crash()
        self.marionette.set_context("content")
        self.marionette.execute_script("log('TEST-END: %s:%s')" %
                                       (self.filepath.replace('\\', '\\\\'), self.methodName))
        self.marionette.test_name = None
        CommonTestCase.tearDown(self)

    def get_new_emulator(self):
        self.extra_emulator_index += 1
        if len(self.marionette.extra_emulators) == self.extra_emulator_index:
            qemu  = Marionette(emulator=self.marionette.emulator.arch,
                               emulatorBinary=self.marionette.emulator.binary,
                               homedir=self.marionette.homedir,
                               baseurl=self.marionette.baseurl,
                               noWindow=self.marionette.noWindow,
                               gecko_path=self.marionette.gecko_path)
            qemu.start_session()
            self.marionette.extra_emulators.append(qemu)
        else:
            qemu = self.marionette.extra_emulators[self.extra_emulator_index]
        return qemu

    def wait_for_condition(self, method, timeout=30):
        timeout = float(timeout) + time.time()
        while time.time() < timeout:
            value = method(self.marionette)
            if value:
                return value
            time.sleep(0.5)
        else:
            raise TimeoutException("wait_for_condition timed out")

class MarionetteJSTestCase(CommonTestCase):

    head_js_re = re.compile(r"MARIONETTE_HEAD_JS(\s*)=(\s*)['|\"](.*?)['|\"];")
    context_re = re.compile(r"MARIONETTE_CONTEXT(\s*)=(\s*)['|\"](.*?)['|\"];")
    timeout_re = re.compile(r"MARIONETTE_TIMEOUT(\s*)=(\s*)(\d+);")
    inactivity_timeout_re = re.compile(r"MARIONETTE_INACTIVITY_TIMEOUT(\s*)=(\s*)(\d+);")
    match_re = re.compile(r"test_(.*)\.js$")

    def __init__(self, marionette_weakref, methodName='runTest', jsFile=None, **kwargs):
        assert(jsFile)
        self.jsFile = jsFile
        self._marionette_weakref = marionette_weakref
        self.marionette = None
        self.test_container = kwargs.pop('test_container', False)
        CommonTestCase.__init__(self, methodName)

    @classmethod
    def add_tests_to_suite(cls, mod_name, filepath, suite, testloader, marionette, testvars, **kwargs):
        suite.addTest(cls(weakref.ref(marionette), jsFile=filepath, **kwargs))

    def runTest(self):
        if self.marionette.session is None:
            self.marionette.start_session()
        self.marionette.test_name = os.path.basename(self.jsFile)
        self.marionette.execute_script("log('TEST-START: %s');" % self.jsFile.replace('\\', '\\\\'))

        f = open(self.jsFile, 'r')
        js = f.read()
        args = []

        if os.path.basename(self.jsFile).startswith('test_'):
            head_js = self.head_js_re.search(js);
            if head_js:
                head_js = head_js.group(3)
                head = open(os.path.join(os.path.dirname(self.jsFile), head_js), 'r')
                js = head.read() + js;

        context = self.context_re.search(js)
        if context:
            context = context.group(3)
            self.marionette.set_context(context)

        if context != "chrome":
            self.marionette.navigate('data:text/html,<html>test page</html>')

        timeout = self.timeout_re.search(js)
        if timeout:
            timeout = timeout.group(3)
            self.marionette.set_script_timeout(timeout)

        inactivity_timeout = self.inactivity_timeout_re.search(js)
        if inactivity_timeout:
            inactivity_timeout = inactivity_timeout.group(3)

        try:
            results = self.marionette.execute_js_script(js,
                                                        args,
                                                        special_powers=True,
                                                        inactivity_timeout=inactivity_timeout,
                                                        filename=os.path.basename(self.jsFile))

            self.assertTrue(not 'timeout' in self.jsFile,
                            'expected timeout not triggered')

            if 'fail' in self.jsFile:
                self.assertTrue(len(results['failures']) > 0,
                                "expected test failures didn't occur")
            else:
                logger = get_default_logger()
                for failure in results['failures']:
                    diag = "" if failure.get('diag') is None else failure['diag']
                    name = "got false, expected true" if failure.get('name') is None else failure['name']
                    logger.test_status(self.test_name, name, 'FAIL',
                                       message=diag)
                for failure in results['expectedFailures']:
                    diag = "" if failure.get('diag') is None else failure['diag']
                    name = "got false, expected false" if failure.get('name') is None else failure['name']
                    logger.test_status(self.test_name, name, 'FAIL',
                                       expected='FAIL', message=diag)
                for failure in results['unexpectedSuccesses']:
                    diag = "" if failure.get('diag') is None else failure['diag']
                    name = "got true, expected false" if failure.get('name') is None else failure['name']
                    logger.test_status(self.test_name, name, 'PASS',
                                       expected='FAIL', message=diag)
                self.assertEqual(0, len(results['failures']),
                                 '%d tests failed' % len(results['failures']))
                if len(results['unexpectedSuccesses']) > 0:
                    raise _UnexpectedSuccess('')
                if len(results['expectedFailures']) > 0:
                    raise _ExpectedFailure((AssertionError, AssertionError(''), None))

            self.assertTrue(results['passed']
                            + len(results['failures'])
                            + len(results['expectedFailures'])
                            + len(results['unexpectedSuccesses']) > 0,
                            'no tests run')

        except ScriptTimeoutException:
            if 'timeout' in self.jsFile:
                # expected exception
                pass
            else:
                self.loglines = self.marionette.get_logs()
                raise

        self.marionette.execute_script("log('TEST-END: %s');" % self.jsFile.replace('\\', '\\\\'))
        self.marionette.test_name = None
