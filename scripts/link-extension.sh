#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_ROOT="${PI_EXTENSION_DIR:-$HOME/.pi/agent/extensions}"
TARGET_NAME="${1:-$(basename "$SOURCE_DIR")}"
TARGET_PATH="$TARGET_ROOT/$TARGET_NAME"

mkdir -p "$TARGET_ROOT"
ln -sfn "$SOURCE_DIR" "$TARGET_PATH"

echo "Linked package directory:"
echo "  $TARGET_PATH -> $SOURCE_DIR"
echo
echo "Next steps:"
echo "  1. Start Pi normally, or run /reload in an existing Pi session."
echo "  2. Validate the extension by checking the startup header and asking Pi to use reviewer_bridge."
