# VSCodium

## Fragment Link 失效

使用 VSCodium + Markdown All in One，无其他插件。
- 跨文档的 fragment link 若包含中文等非 ASCII 字符或为纯数字，则无法在 preview 中正常工作；
- 任何 link 可以在 editor 中正常工作；
- 文档内的 fragment link 可以在 preview 中正常工作。
  
原因未知，疑似 Linux 平台限定 bug，网上也没什么人讨论。

正常来说在 editor 状态下，我 Ctrl + Click `[](...)` 里的 link（即 `...` 指代的东西），得可以打开一个 editor 页面；fragment link 就是指 `[](doc.md#section-header)` 这样的链接格式，点击后则跳转到对应文档 `doc.md` 的对应节；在 preview 当中，我直接点击这个显示的链接（实际上可能被 preview 渲染为一个网页元素？），则可以在 preview 中打开该文档，并跳转到对应节。

然而最后一个行为并不总是能成功。也就是说，实际上是 **navigation**，而且是 preview 在文档内的 navigation 出了问题。

### 定位到了问题！

`markdown-language-features/media/index.js` 中的 fragment scroll 逻辑：

旧版 VS Code 的 heading ID 曾经是 URL-encoded 的，而现在 heading ID 改成 raw Unicode 了，所以

```js
let i;try{i=encodeURIComponent(h.settings.fragment)}catch{i=h.settings.fragment}
```

需要改成

```js
let i=h.settings.fragment
```

此外纯数字其实有另一个原因，数字会被当作行号来解析而不会进行 heading lookup，需要把 heading lookup 移动到前面。

### patch

使用下面这个脚本可以修复我 Linux 上的 VSCodium 1.126。如果 VSCode 出现同款问题则需要相应调整。

```sh
#!/bin/bash
# patch.sh — targeted patches for VSCodium markdown preview bugs.
# Uses perl for multi-line S/R. Survives minor VSCodium updates.
set -e

EXT_DIR="${1:-}"
if [ -z "$EXT_DIR" ]; then
    for d in \
        /opt/vscodium-bin/resources/app/extensions/markdown-language-features \
        /opt/vscodium/resources/app/extensions/markdown-language-features \
        /usr/lib/codium/resources/app/extensions/markdown-language-features \
        /usr/share/codium/resources/app/extensions/markdown-language-features \
        ; do
        [ -f "$d/media/index.js" ] && { EXT_DIR="$d"; break; }
    done
fi
[ -z "$EXT_DIR" ] && { echo "Usage: sudo ./patch.sh /path/to/markdown-language-features"; exit 1; }
echo "Patching: $EXT_DIR"

bak() { local f="$EXT_DIR/$1"; [ -f "$f.orig" ] || cp "$f" "$f.orig"; }

# ── 1. media/index.js ───────────────────────────────────────
# BUG: fragment scroll code does encodeURIComponent before getElementById.
#      Heading IDs are now raw Unicode, so this fails for non-ASCII.
# FIX: remove the encodeURIComponent wrapper.
bak "media/index.js"
sed -i 's/{let i;try{i=encodeURIComponent(h.settings.fragment)}catch{i=h.settings.fragment}/{let i=h.settings.fragment/' \
    "$EXT_DIR/media/index.js"
echo "  [1/2] media/index.js: removed encodeURIComponent"

# ── 2. serverWorkerMain.js ──────────────────────────────────
bak "dist/serverWorkerMain.js"

perl -i -0777 -pe '
# ── Fix 1: move heading lookup BEFORE line-number parsing ──
# Pattern:
#   if (!linkData.fragment) { return ... }
#   const loc = parseLocationInfoFromFragment(...);
#   if (loc) { return { ..., positionOrRange: loc }; }
#   const doc = await ...openMarkdownDocument(target);
#
# Replace with:
#   if (!linkData.fragment) { return ... }
#   const doc = await ...openMarkdownDocument(target);
#   ... (heading lookup) ...
#   // Fallback: line-number
#   const loc = parseLocationInfoFromFragment(...);
#   if (loc) { return { ..., positionOrRange: loc }; }

s{
    (if\s*\(\!linkData\.fragment\)\s*\{\s*return\s*\{[^}]+\}\s*\})\s*
    const\s+locationLinkPosition\s*=\s*parseLocationInfoFromFragment\(linkData\.fragment\);\s*
    if\s*\(locationLinkPosition\)\s*\{\s*return\s*\{[^}]+\}\s*;\s*\}\s*
    (const\s+doc\s*=\s*await\s+this\.\#workspace\.openMarkdownDocument\(target\);)
}
{$1 $2}x
    or print STDERR "WARNING: Fix 1 (heading-before-line) pattern not matched — may need manual update\n";

# ── Fix 2: decodeURIComponent fallback ──
# After each lookByLink call, add a decodeURIComponent retry.
s{
    (entry\s*=\s*toc\.lookByLink\(\{[^}]+\}\))
}
{$1;if(!entry){try{let d=decodeURIComponent(linkData.fragment);if(d!==linkData.fragment)entry=toc.lookByLink({fragment:d,isAngleBracketLink:linkData.isAngleBracketLink})}catch(e){}}}g
    or print STDERR "WARNING: Fix 2 (decodeURIComponent) pattern not matched\n";

s{
    (entry\s*=\s*tocWithHtmlIds\.lookByLink\(\{[^}]+\}\))
}
{$1;if(!entry){try{let d=decodeURIComponent(linkData.fragment);if(d!==linkData.fragment)entry=tocWithHtmlIds.lookByLink({fragment:d,isAngleBracketLink:linkData.isAngleBracketLink})}catch(e){}}}g

' "$EXT_DIR/dist/serverWorkerMain.js"

echo "  [2/2] serverWorkerMain.js: heading-before-line + decodeURIComponent fallback"

echo ""
echo "=== Done. Restart VSCodium. ==="
```