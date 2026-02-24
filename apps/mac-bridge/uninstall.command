#!/bin/bash
PLIST_NAME="com.deedee.bridge.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "🗑️ DeeDee Mac Bridge Uninstaller"
echo "================================"

if [ -f "$PLIST_DEST" ]; then
    echo "Stopping service..."
    launchctl unload "$PLIST_DEST" 2>/dev/null
    
    echo "Removing plist..."
    rm "$PLIST_DEST"
    echo "✅ Service removed."
else
    echo "⚠️ Service not found (was it installed?)."
fi

echo "Note: The 'apps/mac-bridge' folder was NOT deleted."
echo "You can manually delete it if you want to remove the files."
