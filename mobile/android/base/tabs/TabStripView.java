/* -*- Mode: Java; c-basic-offset: 4; tab-width: 20; indent-tabs-mode: nil; -*-
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.gecko.tabs;

import android.content.Context;
import android.content.res.Resources;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.util.AttributeSet;
import android.view.View;
import android.view.ViewGroup;

import java.util.ArrayList;
import java.util.List;

import org.mozilla.gecko.R;
import org.mozilla.gecko.Tab;
import org.mozilla.gecko.Tabs;
import org.mozilla.gecko.widget.TwoWayView;

public class TabStripView extends TwoWayView {
    private static final String LOGTAG = "GeckoTabStrip";

    private final TabStripAdapter adapter;
    private final TabsListener tabsListener;

    private final Drawable divider;

    private boolean isPrivate;

    public TabStripView(Context context, AttributeSet attrs) {
        super(context, attrs);

        setOrientation(Orientation.HORIZONTAL);
        setChoiceMode(ChoiceMode.SINGLE);
        setItemsCanFocus(true);
        setChildrenDrawingOrderEnabled(true);
        setWillNotDraw(false);

        final Resources resources = getResources();

        divider = resources.getDrawable(R.drawable.new_tablet_tab_strip_divider);

        final int itemMargin =
                resources.getDimensionPixelSize(R.dimen.new_tablet_tab_strip_item_margin);
        setItemMargin(itemMargin);

        tabsListener = new TabsListener();

        adapter = new TabStripAdapter(context);
        setAdapter(adapter);
    }

    private View getViewForTab(Tab tab) {
        final int position = adapter.getPositionForTab(tab);
        return getChildAt(position - getFirstVisiblePosition());
    }

    private int getPositionForSelectedTab() {
        return adapter.getPositionForTab(Tabs.getInstance().getSelectedTab());
    }

    private void updateSelectedStyle(int selected) {
        setItemChecked(selected, true);
    }

    private void updateSelectedPosition() {
        final int selected = getPositionForSelectedTab();
        if (selected != -1) {
            updateSelectedStyle(selected);
        }
    }

    private int getCheckedIndex(int childCount) {
        final int checkedIndex = getCheckedItemPosition() - getFirstVisiblePosition();
        if (checkedIndex < 0 || checkedIndex > childCount - 1) {
            return INVALID_POSITION;
        }

        return checkedIndex;
    }

    private void refreshTabs() {
        // Store a different copy of the tabs, so that we don't have
        // to worry about accidentally updating it on the wrong thread.
        final List<Tab> tabs = new ArrayList<Tab>();

        for (Tab tab : Tabs.getInstance().getTabsInOrder()) {
            if (tab.isPrivate() == isPrivate) {
                tabs.add(tab);
            }
        }

        adapter.refresh(tabs);
        updateSelectedPosition();
    }

    private void removeTab(Tab tab) {
        adapter.removeTab(tab);
        updateSelectedPosition();
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();

        Tabs.registerOnTabsChangedListener(tabsListener);
        refreshTabs();
    }

    @Override
    protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();

        Tabs.unregisterOnTabsChangedListener(tabsListener);
        adapter.clear();
    }

    @Override
    protected int getChildDrawingOrder(int childCount, int i) {
        final int checkedIndex = getCheckedIndex(childCount);
        if (checkedIndex == INVALID_POSITION) {
            return i;
        }

        // Always draw the currently selected tab on top of all
        // other child views so that its curve is fully visible.
        if (i == childCount - 1) {
            return checkedIndex;
        } else if (checkedIndex <= i) {
            return i + 1;
        } else {
            return i;
        }
    }

    @Override
    public void draw(Canvas canvas) {
        super.draw(canvas);

        final int bottom = getHeight() - getPaddingBottom();
        final int top = bottom - divider.getIntrinsicHeight();

        final int dividerWidth = divider.getIntrinsicWidth();
        final int itemMargin = getItemMargin();

        final int childCount = getChildCount();
        final int checkedIndex = getCheckedIndex(childCount);

        for (int i = 1; i < childCount; i++) {
            final View child = getChildAt(i);

            final boolean pressed = (child.isPressed() || getChildAt(i - 1).isPressed());
            final boolean checked = (i == checkedIndex || i == checkedIndex + 1);

            // Don't draw dividers for around checked or pressed items
            // so that they are not drawn on top of the tab curves.
            if (pressed || checked) {
                continue;
            }

            final int left = child.getLeft() - (itemMargin / 2) - dividerWidth;
            final int right = left + dividerWidth;

            divider.setBounds(left, top, right, bottom);
            divider.draw(canvas);
        }
    }

    private class TabsListener implements Tabs.OnTabsChangedListener {
        @Override
        public void onTabChanged(Tab tab, Tabs.TabEvents msg, Object data) {
            switch (msg) {
                case RESTORED:
                case ADDED:
                    // Refresh the list to make sure the new tab is
                    // added in the right position.
                    refreshTabs();
                    break;

                case CLOSED:
                    removeTab(tab);
                    break;

                case SELECTED:
                    // Update the selected position, then fall through...
                    if (tab.isPrivate() != isPrivate) {
                        isPrivate = tab.isPrivate();
                        refreshTabs();
                    } else {
                        updateSelectedPosition();
                    }
                case UNSELECTED:
                    // We just need to update the style for the unselected tab...
                case TITLE:
                case RECORDING_CHANGE:
                    final TabStripItemView item = (TabStripItemView) getViewForTab(tab);
                    if (item != null) {
                        item.updateFromTab(tab);
                    }
                    break;
            }
        }
    }
}