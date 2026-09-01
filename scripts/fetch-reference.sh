#!/usr/bin/env bash
# Refresh the third-party reference material in ./reference:
#   1. official OpenCode plugin docs page (HTML snapshot)
#   2. opencode-quota-sidebar-plus — a working sidebar-panel plugin (npm)
#   3. @opencode-ai/plugin — official plugin type definitions (npm)
#
# Usage: bash scripts/fetch-reference.sh
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf reference
mkdir -p reference

curl -fsSL https://opencode.ai/docs/plugins/ -o reference/opencode-plugin-docs.html

npm pack opencode-quota-sidebar-plus --pack-destination reference/ >/dev/null
tar -xzf reference/opencode-quota-sidebar-plus-*.tgz -C reference/
mv reference/package reference/opencode-quota-sidebar-plus
rm reference/opencode-quota-sidebar-plus-*.tgz

npm pack @opencode-ai/plugin --pack-destination reference/ >/dev/null
tar -xzf reference/opencode-ai-plugin-*.tgz -C reference/
mv reference/package reference/plugin-types
rm reference/opencode-ai-plugin-*.tgz

echo "reference/ refreshed."
