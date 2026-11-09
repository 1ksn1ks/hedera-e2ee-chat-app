#!/usr/bin/env bash
# Smoke test on the CI emulator: install the APK, open the app, wait, and
# report. A crash puts Android's crash lines into a public annotation (job
# logs need a signed-in admin, annotations do not). A running app reports
# the text on its first screen. Leaves logcat.txt, ui.xml and screen.png.
set -u
APK="$1"
PKG=com.hederae2eechat

# One annotation per message: GitHub needs % and newlines escaped.
esc() { sed 's/%/%25/g; s/\r//g' "$1" | awk '{printf "%s%%0A", $0}'; }

if ! adb install -r "$APK" > install.txt 2>&1; then
  echo "::error title=APK did not install::$(esc install.txt)"
  exit 1
fi

adb logcat -c
adb shell am start -W -n "$PKG/.MainActivity" > start.txt 2>&1 || true
sleep 30
adb logcat -d -v brief > logcat.txt 2>&1
adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 && adb pull /sdcard/ui.xml ui.xml > /dev/null 2>&1
adb exec-out screencap -p > screen.png 2>/dev/null || true

PID=$(adb shell pidof "$PKG" 2>/dev/null | tr -d '\r')

grep -E "AndroidRuntime|ReactNativeJS|ReactNative|Fatal signal|F/DEBUG|F/libc|UnsatisfiedLinkError|ClassNotFoundException|SoLoader|TurboModuleRegistry|Invariant Violation|hermes" logcat.txt \
  | head -80 > why.txt

if [ -z "$PID" ]; then
  [ -s why.txt ] || tail -60 logcat.txt > why.txt
  echo "::error title=App closed on launch::$(esc why.txt)"
  exit 1
fi

TEXT=$(grep -o 'text="[^"]\+"' ui.xml 2>/dev/null | sed 's/^text="//; s/"$//' | head -25 | paste -sd'|' -)
echo "::notice title=App is running (pid ${PID})::Screen text: ${TEXT:-none found}"

grep -E "^[EW]/ReactNativeJS" logcat.txt | head -25 > js.txt
if [ -s js.txt ]; then
  echo "::warning title=JS errors or warnings at startup::$(esc js.txt)"
fi
exit 0
