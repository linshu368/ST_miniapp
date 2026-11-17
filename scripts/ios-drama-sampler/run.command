#!/bin/bash
set -euo pipefail
SAMPLER_ROOT="$(cd "$(dirname "$0")" && pwd)"
SETUP_ROOT="${MINIAPP_IOS_SETUP_ROOT:-$HOME/Downloads/miniapp-ios-setup}"
if [ ! -f "$SETUP_ROOT/common.sh" ]; then
  printf '找不到安装包 common.sh；请设置 MINIAPP_IOS_SETUP_ROOT。\n' >&2
  exit 1
fi
source "$SETUP_ROOT/common.sh"
require_mac
require_appium
exec node "$SAMPLER_ROOT/cli.mjs" "$@"
