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
cp Resources/AppIcon.icns Resources/PhoenixMark.png "$APP/Contents/Resources/"
codesign --force --sign - --identifier dev.phoenix.mac "$APP"
# On-device text recognition helper used by the core (images and PDFs).
cp .build/release/phoenix-ocr build/phoenix-ocr
codesign --force --sign - --identifier dev.phoenix.ocr build/phoenix-ocr
echo "Built $(pwd)/$APP"
