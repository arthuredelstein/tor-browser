#!/usr/bin/env python

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this file,
# You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import tempfile
import unittest

import mozfile

from mozversion import errors, get_version


class BinaryTest(unittest.TestCase):
    """test getting application version information from a binary path"""

    application_ini = """[App]
Name = AppName
CodeName = AppCodeName
Version = AppVersion
BuildID = AppBuildID
SourceRepository = AppSourceRepo
SourceStamp = AppSourceStamp
"""
    platform_ini = """[Build]
BuildID = PlatformBuildID
SourceStamp = PlatformSourceStamp
SourceRepository = PlatformSourceRepo
"""

    def setUp(self):
        self.cwd = os.getcwd()
        self.tempdir = tempfile.mkdtemp()

        self.binary = os.path.join(self.tempdir, 'binary')
        with open(self.binary, 'w') as f:
            f.write('foobar')

    def tearDown(self):
        os.chdir(self.cwd)
        mozfile.remove(self.tempdir)

    @unittest.skipIf(not os.environ.get('BROWSER_PATH'),
                     'No binary has been specified.')
    def test_real_binary(self):
        v = get_version(os.environ.get('BROWSER_PATH'))
        self.assertTrue(isinstance(v, dict))

    def test_binary(self):
        with open(os.path.join(self.tempdir, 'application.ini'), 'w') as f:
            f.writelines(self.application_ini)

        with open(os.path.join(self.tempdir, 'platform.ini'), 'w') as f:
            f.writelines(self.platform_ini)

        self._check_version(get_version(self.binary))

    def test_binary_in_current_path(self):
        with open(os.path.join(self.tempdir, 'application.ini'), 'w') as f:
            f.writelines(self.application_ini)

        with open(os.path.join(self.tempdir, 'platform.ini'), 'w') as f:
            f.writelines(self.platform_ini)
        os.chdir(self.tempdir)
        self._check_version(get_version())

    def test_invalid_binary_path(self):
        self.assertRaises(IOError, get_version,
                          os.path.join(self.tempdir, 'invalid'))

    def test_without_ini_files(self):
        """With missing ini files an exception should be thrown"""
        self.assertRaises(errors.AppNotFoundError, get_version,
                          self.binary)

    def test_without_platform_file(self):
        """With a missing platform file no exception should be thrown"""
        with open(os.path.join(self.tempdir, 'application.ini'), 'w') as f:
            f.writelines(self.application_ini)

        v = get_version(self.binary)
        self.assertTrue(isinstance(v, dict))

    def _check_version(self, version):
        self.assertEqual(version.get('application_name'), 'AppName')
        self.assertEqual(version.get('application_display_name'), 'AppCodeName')
        self.assertEqual(version.get('application_version'), 'AppVersion')
        self.assertEqual(version.get('application_buildid'), 'AppBuildID')
        self.assertEqual(
            version.get('application_repository'), 'AppSourceRepo')
        self.assertEqual(
            version.get('application_changeset'), 'AppSourceStamp')
        self.assertIsNone(version.get('platform_name'))
        self.assertIsNone(version.get('platform_version'))
        self.assertEqual(version.get('platform_buildid'), 'PlatformBuildID')
        self.assertEqual(
            version.get('platform_repository'), 'PlatformSourceRepo')
        self.assertEqual(
            version.get('platform_changeset'), 'PlatformSourceStamp')
        self.assertIsNone(version.get('invalid_key'))


if __name__ == '__main__':
    unittest.main()
