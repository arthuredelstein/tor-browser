#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

#
# Code shared by update packaging scripts.
# Author: Darin Fisher
#

# -----------------------------------------------------------------------------
QUIET=0

# By default just assume that these tools exist on our path
MAR=${MAR:-mar}
BZIP2=${BZIP2:-bzip2}
MBSDIFF=${MBSDIFF:-mbsdiff}

# -----------------------------------------------------------------------------
# Helper routines

notice() {
  echo "$*" 1>&2
}

verbose_notice() {
  if [ $QUIET -eq 0 ]; then
    notice "$*"
  fi
}

get_file_size() {
  info=($(ls -ln "$1"))
  echo ${info[4]}
}

copy_perm() {
  reference="$1"
  target="$2"

  if [ -x "$reference" ]; then
    chmod 0755 "$target"
  else
    chmod 0644 "$target"
  fi
}

make_add_instruction() {
  f="$1"
  filev2="$2"
  # The third param will be an empty string when a file add instruction is only
  # needed in the version 2 manifest. This only happens when the file has an
  # add-if-not instruction in the version 3 manifest. This is due to the
  # precomplete file prior to the version 3 manifest having a remove instruction
  # for this file so the file is removed before applying a complete update.
  filev3="$3"

  # Used to log to the console
  if [ $4 ]; then
    forced=" (forced)"
  else
    forced=
  fi

  is_extension=$(echo "$f" | grep -c 'distribution/extensions/.*/')
  if [ $is_extension = "1" ]; then
    # Use the subdirectory of the extensions folder as the file to test
    # before performing this add instruction.
    testdir=$(echo "$f" | sed 's/\(.*distribution\/extensions\/[^\/]*\)\/.*/\1/')
    verbose_notice "     add-if \"$testdir\" \"$f\""
    echo "add-if \"$testdir\" \"$f\"" >> "$filev2"
    if [ ! "$filev3" = "" ]; then
      echo "add-if \"$testdir\" \"$f\"" >> "$filev3"
    fi
  else
    verbose_notice "        add \"$f\"$forced"
    echo "add \"$f\"" >> "$filev2"
    if [ ! "$filev3" = "" ]; then
      echo "add \"$f\"" >> "$filev3"
    fi
  fi
}

check_for_add_if_not_update() {
  add_if_not_file_chk="$1"

  if [ `basename $add_if_not_file_chk` = "channel-prefs.js" -o \
       `basename $add_if_not_file_chk` = "update-settings.ini" ]; then
    ## "true" *giggle*
    return 0;
  fi
  ## 'false'... because this is bash. Oh yay!
  return 1;
}

check_for_add_to_manifestv2() {
  add_if_not_file_chk="$1"

  if [ `basename $add_if_not_file_chk` = "update-settings.ini" ]; then
    ## "true" *giggle*
    return 0;
  fi
  ## 'false'... because this is bash. Oh yay!
  return 1;
}

make_add_if_not_instruction() {
  f="$1"
  filev3="$2"

  verbose_notice " add-if-not \"$f\" \"$f\""
  echo "add-if-not \"$f\" \"$f\"" >> "$filev3"
}

make_addsymlink_instruction() {
  link="$1"
  target="$2"
  filev3="$3"

  verbose_notice "        addsymlink: $link -> $target"
  echo "addsymlink \"$link\" \"$target\"" >> "$filev3"
}

make_patch_instruction() {
  f="$1"
  filev2="$2"
  filev3="$3"

  is_extension=$(echo "$f" | grep -c 'distribution/extensions/.*/')
  if [ $is_extension = "1" ]; then
    # Use the subdirectory of the extensions folder as the file to test
    # before performing this add instruction.
    testdir=$(echo "$f" | sed 's/\(.*distribution\/extensions\/[^\/]*\)\/.*/\1/')
    verbose_notice "   patch-if \"$testdir\" \"$f.patch\" \"$f\""
    echo "patch-if \"$testdir\" \"$f.patch\" \"$f\"" >> "$filev2"
    echo "patch-if \"$testdir\" \"$f.patch\" \"$f\"" >> "$filev3"
  else
    verbose_notice "      patch \"$f.patch\" \"$f\""
    echo "patch \"$f.patch\" \"$f\"" >> "$filev2"
    echo "patch \"$f.patch\" \"$f\"" >> "$filev3"
  fi
}

append_remove_instructions() {
  dir="$1"
  filev2="$2"
  filev3="$3"

  if [ -f "$dir/removed-files" ]; then
    prefix=
    listfile="$dir/removed-files"
  elif [ -f "$dir/Contents/MacOS/removed-files" ]; then
    prefix=Contents/MacOS/
    listfile="$dir/Contents/MacOS/removed-files"
  fi
  if [ -n "$listfile" ]; then
    # Map spaces to pipes so that we correctly handle filenames with spaces.
    files=($(cat "$listfile" | tr " " "|"  | sort -r))
    num_files=${#files[*]}
    for ((i=0; $i<$num_files; i=$i+1)); do
      # Map pipes back to whitespace and remove carriage returns
      f=$(echo ${files[$i]} | tr "|" " " | tr -d '\r')
      # Trim whitespace
      f=$(echo $f)
      # Exclude blank lines.
      if [ -n "$f" ]; then
        # Exclude comments
        if [ ! $(echo "$f" | grep -c '^#') = 1 ]; then
          # Normalize the path to the root of the Mac OS X bundle if necessary
          fixedprefix="$prefix"
          if [ $prefix ]; then
            if [ $(echo "$f" | grep -c '^\.\./') = 1 ]; then
              if [ $(echo "$f" | grep -c '^\.\./\.\./') = 1 ]; then
                f=$(echo $f | sed -e 's:^\.\.\/\.\.\/::')
                fixedprefix=""
              else
                f=$(echo $f | sed -e 's:^\.\.\/::')
                fixedprefix=$(echo "$prefix" | sed -e 's:[^\/]*\/$::')
              fi
            fi
          fi
          if [ $(echo "$f" | grep -c '\/$') = 1 ]; then
            verbose_notice "      rmdir \"$fixedprefix$f\""
            echo "rmdir \"$fixedprefix$f\"" >> "$filev2"
            echo "rmdir \"$fixedprefix$f\"" >> "$filev3"
          elif [ $(echo "$f" | grep -c '\/\*$') = 1 ]; then
            # Remove the *
            f=$(echo "$f" | sed -e 's:\*$::')
            verbose_notice "    rmrfdir \"$fixedprefix$f\""
            echo "rmrfdir \"$fixedprefix$f\"" >> "$filev2"
            echo "rmrfdir \"$fixedprefix$f\"" >> "$filev3"
          else
            verbose_notice "     remove \"$fixedprefix$f\""
            echo "remove \"$fixedprefix$f\"" >> "$filev2"
            echo "remove \"$fixedprefix$f\"" >> "$filev3"
          fi
        fi
      fi
    done
  fi
}

# List all files in the current directory, stripping leading "./"
# Pass a variable name and it will be filled as an array.
# To support Tor Browser updates, skip the following files:
#    TorBrowser/Data/Browser/profiles.ini
#    TorBrowser/Data/Browser/profile.default/bookmarks.html
#    TorBrowser/Data/Tor/torrc
list_files() {
  count=0

  find . -type f \
    ! -name "update.manifest" \
    ! -name "updatev2.manifest" \
    ! -name "updatev3.manifest" \
    ! -name "temp-dirlist" \
    ! -name "temp-filelist" \
    | sed 's/\.\/\(.*\)/\1/' \
    | sort -r > "temp-filelist"
  while read file; do
    if [ "$file" = "TorBrowser/Data/Browser/profiles.ini" -o                   \
         "$file" = "TorBrowser/Data/Browser/profile.default/bookmarks.html" -o \
         "$file" = "TorBrowser/Data/Tor/torrc" ]; then
      continue;
    fi
    eval "${1}[$count]=\"$file\""
    (( count++ ))
  done < "temp-filelist"
  rm "temp-filelist"
}

# List all directories in the current directory, stripping leading "./"
list_dirs() {
  count=0

  find . -type d \
    ! -name "." \
    ! -name ".." \
    | sed 's/\.\/\(.*\)/\1/' \
    | sort -r > "temp-dirlist"
  while read dir; do
    eval "${1}[$count]=\"$dir\""
    (( count++ ))
  done < "temp-dirlist"
  rm "temp-dirlist"
}

# List all symbolic links in the current directory, stripping leading "./"
list_symlinks() {
  count=0

  find . -type l \
    | sed 's/\.\/\(.*\)/\1/' \
    | sort -r > "temp-symlinklist"
  while read symlink; do
	target=$(readlink "$symlink")
    eval "${1}[$count]=\"$symlink\""
    eval "${2}[$count]=\"$target\""
    (( count++ ))
  done < "temp-symlinklist"
  rm "temp-symlinklist"
}
