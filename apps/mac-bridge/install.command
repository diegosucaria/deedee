#!/bin/bash

# Get the directory where this script is located
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PLIST_NAME="com.deedee.bridge.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "🤖 DeeDee Mac Bridge Installer"
echo "=============================="
echo "Detected Directory: $DIR"

# Detect Node.js Path
NODE_PATH=$(which node)
if [ -z "$NODE_PATH" ]; then
    # Try common locations
    if [ -f "/usr/local/bin/node" ]; then
        NODE_PATH="/usr/local/bin/node"
    elif [ -f "$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | head -n 1)/bin/node" ]; then
        NODE_PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | head -n 1)/bin/node"
    else
        echo "❌ Node.js not found! Please install Node.js."
        exit 1
    fi
fi
echo "Detected Node: $NODE_PATH"

# Check dependencies
if [ ! -d "$DIR/node_modules" ]; then
    echo "📦 Installing dependencies..."
    cd "$DIR"
    npm install
fi

# Generate Plist content dynamically

# Generate Plist content dynamically
cat <<EOF > "$DIR/$PLIST_NAME"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.deedee.bridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$DIR/src/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/deedee-bridge.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/deedee-bridge.err.log</string>
</dict>
</plist>
EOF

echo "📝 Generated config file: $DIR/$PLIST_NAME"

# Install Plist
cp "$DIR/$PLIST_NAME" "$PLIST_DEST"
echo "📂 Copied to LaunchAgents"

# Unload previous instance (if any) and Load new one
launchctl unload "$PLIST_DEST" 2>/dev/null
launchctl load "$PLIST_DEST"

echo ""
echo "✅ Success! Mac Bridge is running in the background."
echo "Logs: tail -f /tmp/deedee-bridge.out.log"
echo ""
echo "✅ Success! Mac Bridge is running in the background."
echo "Logs: tail -f /tmp/deedee-bridge.out.log"

