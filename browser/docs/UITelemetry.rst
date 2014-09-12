=======================
UITelemetry data format
=======================

UI Telemetry sends its data as a JSON blob. This document describes the different parts
of the JSON blob.

``toolbars``
------------

This tracks the state of the user's UI customizations. It has the following properties:

- ``sizemode`` - string indicating whether the window is in maximized, normal (restored) or
  fullscreen mode;
- ``bookmarksBarEnabled`` - boolean indicating whether the bookmarks bar is visible;
- ``menuBarEnabled`` - boolean indicating whether the menu bar is visible (always false on OS X);
- ``titleBarEnabled`` - boolean indicating whether the (real) titlebar is visible (rather than
  having tabs in the titlebar);
- ``defaultKept`` - list of strings identifying toolbar buttons and items that are still in their
  default position. Only the IDs of builtin widgets are sent (ie not add-on widgets);
- ``defaultMoved`` - list of strings identifying toolbar buttons and items that are no longer in
  their default position, but have not been removed to the palette. Only the IDs of builtin widgets
  are sent (ie not add-on widgets);
- ``nondefaultAdded`` - list of strings identifying toolbar buttons and items that have been added
  from the palette. Only the IDs of builtin widgets are sent (ie not add-on widgets);
- ``defaultRemoved`` - list of strings identifying toolbar buttons and items that are in the
  palette that are elsewhere by default. Only the IDs of builtin widgets are sent
  (ie not add-on widgets);
- ``addonToolbars`` - the number of non-default toolbars that are customizable. 1 by default
  because it counts the add-on bar shim;
- ``visibleTabs`` - array of the number of visible tabs per window;
- ``hiddenTabs`` - array of the number of hidden tabs per window (ie tabs in panorama groups which
  are not the current group);
- ``countableEvents`` - please refer to the next section.
- ``durations`` - an object mapping descriptions to duration records, which records the amount of
  time a user spent doing something. Currently only has one property:
   - ``customization`` - how long a user spent customizing the browser. This is an array of
     objects, where each object has a ``duration`` property indicating the time in milliseconds,
     and a ``bucket`` property indicating a bucket in which the duration info falls.

``countableEvents``
-------------------

Countable events are stored under the ``toolbars`` section. They count the number of times certain
events happen. No timing or other correlating information is stored - purely the number of times
things happen.

``countableEvents`` is an object with properties representing buckets. In each bucket, there is an
object with the following properties:

- ``click-builtin-item`` is an object tracking clicks on builtin customizable toolbar items, keyed
  off the item IDs, with an object for each item with keys ``left``, ``middle`` and ``right`` each
  storing a number indicating how often the respective type of click has happened.
- ``click-menu-button`` is the same, except the item ID is always 'button'.
- ``click-bookmarks-bar`` is the same, with the item IDs being replaced by either ``container`` for
  clicks on bookmark or livemark folders, and ``item`` for individual bookmarks.
- ``click-menubar`` is similar, with the item IDs being replaced by one of ``menu``, ``menuitem``
  or ``other``, depending on the kind of item clicked. Note that this is not tracked on OS X, where
  we can't listen for these events because of the global menubar.
- ``click-bookmarks-menu-button`` is also similar, with the item IDs being replaced by:
   - ``menu`` for clicks on the 'menu' part of the item;
   - ``add`` for clicks that add a bookmark;
   - ``edit`` for clicks that open the panel to edit an existing bookmark;
   - ``in-panel`` for clicks when the button is in the menu panel, and clicking it does none of the
     above;
- ``customize`` tracks different types of customization events without the ``left``, ``middle`` and
  ``right`` distinctions. The different events are the following, with each storing a count of the
  number of times they occurred:
   - ``start`` counts the number of times the user starts customizing;
   - ``add`` counts the number of times an item is added somewhere from the palette;
   - ``move`` counts the number of times an item is moved somewhere else (but not to the palette);
   - ``remove`` counts the number of times an item is removed to the palette;
   - ``reset`` counts the number of times the 'restore defaults' button is used;
- ``search`` is an object tracking searches of various types, keyed off the search
    location, storing a number indicating how often the respective type of search
    has happened.
  - There are also two special keys that mean slightly different things.
    - ``urlbar-keyword`` records searches that would have been an invalid-protocol
      error, but are now keyword searches.  They are also counted in the ``urlbar``
      keyword (along with all the other urlbar searches).
    - ``selection`` searches records selections of search suggestions.  They include
      the source, the index of the selection, and the kind of selection (mouse or
      enter key).  Selection searches are also counted in their sources.



``UITour``
----------
The UI Tour has its own section in the UI Telemetry output, outside of the ``toolbars`` section.
It has a single property ``seenPageIDs`` which tracks which UI Tour pages have been run.

``contextmenu``
---------------
We track context menu interactions to figure out which ones are most often used and/or how
effective they are. In the ``contextmenu`` object, we first store things per-bucket. Next, we
divide the following different context menu situations:

- ``selection`` if there is content on the page that's selected on which the user clicks;
- ``link`` if the user opened the context menu for a link
- ``image-link`` if the user opened the context menu on an image or canvas that's a link;
- ``image`` if the user opened the context menu on an image (that isn't a link);
- ``canvas`` if the user opened the context menu on a canvas (that isn't a link);
- ``media`` if the user opened the context menu on an HTML video or audio element;
- ``input`` if the user opened the context menu on a text input element;
- ``social`` if the user opened the context menu inside a social frame;
- ``other`` for all other openings of the content menu;

Each of these objects (if they exist) then gets a "withcustom" and/or a "withoutcustom" property
for context menus opened with custom page-created items and without them, and each of those
properties holds an object with IDs corresponding to a count of how often an item with that ID was
activated in the context menu. Only builtin context menu items are tracked, and besides those items
there are four special items which get counts:

- ``close-without-interaction`` is incremented when the user closes the context menu without interacting with it;
- ``custom-page-item`` is incremented when the user clicks an item that was created by the page;
- ``unknown`` is incremented when an item without an ID was clicked;
- ``other-item`` is incremented when an add-on-provided menuitem is clicked.

