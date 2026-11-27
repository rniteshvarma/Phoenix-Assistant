#!/bin/bash
# Builds Phoenix.app with the Swift command line tools (no Xcode needed) and signs it ad hoc.
set -euo pipefail
cd "$(dirname "$0")"
swift build -c release
APP=build/Phoenix.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/Phoenix "$APP/Contents/MacOS/Phoenix"
cp Resources/Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - --identifier dev.phoenix.mac "$APP"
echo "Built $(pwd)/$APP"
