#!/bin/bash
#
# Godot MCP Addon Installer for Linux/macOS
# Installs Auto Reload, Editor Bridge, and Runtime addons to your Godot project
#
# Usage: Run this script in your Godot project folder
#   curl -sL https://raw.githubusercontent.com/HaD0Yun/Gopeak-godot-mcp/main/install-addon.sh | bash
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

REPO_URL="https://raw.githubusercontent.com/HaD0Yun/Gopeak-godot-mcp/main"
FROM_LOCAL=""

AUTO_RELOAD_ONLY=false
RUNTIME_ONLY=false
FORCE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --auto-reload-only)
            AUTO_RELOAD_ONLY=true
            shift
            ;;
        --runtime-only)
            RUNTIME_ONLY=true
            shift
            ;;
        --from-local)
            if [ -z "${2:-}" ]; then
                echo -e "${RED}ERROR: --from-local requires a path to a local gopeak-godot-mcp checkout${NC}"
                exit 1
            fi
            FROM_LOCAL="$2"
            shift 2
            ;;
        --from-local=*)
            FROM_LOCAL="${1#*=}"
            shift
            ;;
        -f|--force)
            FORCE=true
            shift
            ;;
        -h|--help)
            echo "Godot MCP Addon Installer"
            echo ""
            echo "Usage: install-addon.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --auto-reload-only    Install only Auto Reload addon"
            echo "  --runtime-only        Install only Runtime addon"
            echo "  --from-local <path>   Copy from a local gopeak-godot-mcp checkout"
            echo "                        (useful for testing fork edits without pushing)"
            echo "  -f, --force           Overwrite existing addons"
            echo "  -h, --help            Show this help message"
            echo ""
            echo "Run this script from your Godot project folder (where project.godot is located)."
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

if [ -n "$FROM_LOCAL" ]; then
    if [ ! -d "$FROM_LOCAL/src/addon" ]; then
        echo -e "${RED}ERROR: --from-local path does not contain src/addon/${NC}"
        echo -e "${YELLOW}Expected: $FROM_LOCAL/src/addon/${NC}"
        exit 1
    fi
    for required_dir in auto_reload godot_mcp_editor godot_mcp_runtime; do
        if [ ! -d "$FROM_LOCAL/src/addon/$required_dir" ]; then
            echo -e "${RED}ERROR: --from-local path missing $required_dir${NC}"
            echo -e "${YELLOW}Expected: $FROM_LOCAL/src/addon/$required_dir${NC}"
            exit 1
        fi
    done
fi

echo -e "${CYAN}=====================================${NC}"
echo -e "${CYAN}  Godot MCP Addon Installer${NC}"
echo -e "${CYAN}=====================================${NC}"
echo ""

if [ ! -f "project.godot" ]; then
    echo -e "${RED}ERROR: project.godot not found!${NC}"
    echo -e "${YELLOW}Please run this script from your Godot project folder.${NC}"
    exit 1
fi

echo -e "${GREEN}[✓]${NC} Found project.godot"

if [ ! -d "addons" ]; then
    mkdir -p addons
    echo -e "${GREEN}[✓]${NC} Created addons/ directory"
fi

copy_from_local() {
    local rel_path="$1"
    local dest="$2"
    local dir
    dir=$(dirname "$dest")
    mkdir -p "$dir"

    local src="$FROM_LOCAL/src/addon/$rel_path"
    if [ ! -f "$src" ]; then
        echo -e "${RED}ERROR: local source missing: $src${NC}"
        return 1
    fi
    cp -f "$src" "$dest"
}

download_file() {
    local url="$1"
    local dest="$2"
    local dir
    dir=$(dirname "$dest")

    mkdir -p "$dir"

    if command -v curl &> /dev/null; then
        curl -sL "$url" -o "$dest"
    elif command -v wget &> /dev/null; then
        wget -q "$url" -O "$dest"
    else
        echo -e "${RED}ERROR: Neither curl nor wget found. Please install one of them.${NC}"
        exit 1
    fi
}

fetch_addon_file() {
    # rel_path is the path inside src/addon/ (e.g. "auto_reload/auto_reload.gd")
    local rel_path="$1"
    local dest="$2"

    if [ -n "$FROM_LOCAL" ]; then
        copy_from_local "$rel_path" "$dest"
    else
        download_file "$REPO_URL/src/addon/$rel_path" "$dest"
    fi
}

# stash_uids copies every *.uid file under $1 into $2, preserving
# relative paths. `install-addon.sh` deletes the addon dir before
# re-copying from source; Godot projects rely on stable `.uid` files
# (editor-generated, not shipped by the fork) so autoload /.tscn
# references keep resolving across refreshes.
stash_uids() {
    local addon_path="$1"
    local stash_dir="$2"
    if [ ! -d "$addon_path" ]; then
        return 0
    fi
    (cd "$addon_path" && find . -type f -name "*.uid" -print0 2>/dev/null | tar --null -cf - -T - 2>/dev/null) | \
        (cd "$stash_dir" && tar -xf - 2>/dev/null) || true
}

# restore_uids puts stashed .uid files back next to any matching
# source file that survived into the new install (e.g. foo.gd.uid
# restored only if foo.gd exists post-copy). Unmatched stashes are
# discarded.
restore_uids() {
    local addon_path="$1"
    local stash_dir="$2"
    if [ ! -d "$stash_dir" ]; then
        return 0
    fi
    (cd "$stash_dir" && find . -type f -name "*.uid" -print) 2>/dev/null | while read -r rel; do
        local rel_clean="${rel#./}"
        local base_path="${rel_clean%.uid}"
        if [ -f "$addon_path/$base_path" ]; then
            mkdir -p "$(dirname "$addon_path/$rel_clean")"
            cp -f "$stash_dir/$rel_clean" "$addon_path/$rel_clean"
        fi
    done
}

install_auto_reload() {
    echo ""
    echo -e "${YELLOW}Installing Auto Reload addon...${NC}"
    
    local addon_path="addons/auto_reload"
    
    if [ -d "$addon_path" ] && [ "$FORCE" = false ]; then
        echo -e "${YELLOW}Auto Reload addon already exists. Use --force to overwrite.${NC}"
        return 1
    fi

    local uid_stash
    uid_stash=$(mktemp -d)
    stash_uids "$addon_path" "$uid_stash"

    if [ -d "$addon_path" ]; then
        rm -rf "$addon_path"
    fi

    mkdir -p "$addon_path"

    local files=("auto_reload.gd" "plugin.cfg")
    local success=true

    for file in "${files[@]}"; do
        if [ -n "$FROM_LOCAL" ]; then
            echo -e "  Copying $file from local..."
        else
            echo -e "  Downloading $file..."
        fi
        if ! fetch_addon_file "auto_reload/$file" "$addon_path/$file"; then
            echo -e "  ${RED}Failed to fetch $file${NC}"
            success=false
        fi
    done

    restore_uids "$addon_path" "$uid_stash"
    rm -rf "$uid_stash"

    if [ "$success" = true ]; then
        echo -e "${GREEN}[✓]${NC} Auto Reload addon installed successfully!"
        return 0
    fi
    return 1
}

install_runtime() {
    echo ""
    echo -e "${YELLOW}Installing Runtime addon...${NC}"
    
    local addon_path="addons/godot_mcp_runtime"
    
    if [ -d "$addon_path" ] && [ "$FORCE" = false ]; then
        echo -e "${YELLOW}Runtime addon already exists. Use --force to overwrite.${NC}"
        return 1
    fi

    local uid_stash
    uid_stash=$(mktemp -d)
    stash_uids "$addon_path" "$uid_stash"

    if [ -d "$addon_path" ]; then
        rm -rf "$addon_path"
    fi

    mkdir -p "$addon_path"

    local files=("godot_mcp_runtime.gd" "mcp_runtime_autoload.gd" "plugin.cfg")
    local success=true

    for file in "${files[@]}"; do
        if [ -n "$FROM_LOCAL" ]; then
            echo -e "  Copying $file from local..."
        else
            echo -e "  Downloading $file..."
        fi
        if ! fetch_addon_file "godot_mcp_runtime/$file" "$addon_path/$file"; then
            echo -e "  ${RED}Failed to fetch $file${NC}"
            success=false
        fi
    done

    restore_uids "$addon_path" "$uid_stash"
    rm -rf "$uid_stash"

    if [ "$success" = true ]; then
        echo -e "${GREEN}[✓]${NC} Runtime addon installed successfully!"
        return 0
    fi
    return 1
}

install_editor_plugin() {
    echo ""
    echo -e "${YELLOW}Installing Editor Bridge addon...${NC}"

    local addon_path="addons/godot_mcp_editor"

    if [ -d "$addon_path" ] && [ "$FORCE" = false ]; then
        echo -e "${YELLOW}Editor Bridge addon already exists. Use --force to overwrite.${NC}"
        return 1
    fi

    local uid_stash
    uid_stash=$(mktemp -d)
    stash_uids "$addon_path" "$uid_stash"

    if [ -d "$addon_path" ]; then
        rm -rf "$addon_path"
    fi

    mkdir -p "$addon_path/tools"

    local files=(
        "plugin.cfg"
        "plugin.gd"
        "mcp_client.gd"
        "tool_executor.gd"
        "dap_relay.gd"
        "tools/animation_tools.gd"
        "tools/resource_tools.gd"
        "tools/scene_tools.gd"
    )
    local success=true

    for file in "${files[@]}"; do
        if [ -n "$FROM_LOCAL" ]; then
            echo -e "  Copying $file from local..."
        else
            echo -e "  Downloading $file..."
        fi
        if ! fetch_addon_file "godot_mcp_editor/$file" "$addon_path/$file"; then
            echo -e "  ${RED}Failed to fetch $file${NC}"
            success=false
        fi
    done

    restore_uids "$addon_path" "$uid_stash"
    rm -rf "$uid_stash"

    if [ "$success" = true ]; then
        echo -e "${GREEN}[✓]${NC} Editor Bridge addon installed successfully!"
        return 0
    fi
    return 1
}

if [ "$AUTO_RELOAD_ONLY" = true ]; then
    install_auto_reload
elif [ "$RUNTIME_ONLY" = true ]; then
    install_runtime
else
    install_auto_reload
    install_editor_plugin
    install_runtime
fi

echo ""
echo -e "${CYAN}=====================================${NC}"
echo -e "${GREEN}  Installation Complete!${NC}"
echo -e "${CYAN}=====================================${NC}"
echo ""
echo -e "${BOLD}Next steps:${NC}"
echo "  1. Open your project in Godot"
echo "  2. Go to Project > Project Settings > Plugins"
echo "  3. Enable the installed addon(s), including ${BOLD}godot_mcp_editor${NC} for bridge-backed tools"
echo ""
echo "For more info: https://github.com/HaD0Yun/Gopeak-godot-mcp"
