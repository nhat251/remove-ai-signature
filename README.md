# remove-ai-signature

[![npm version](https://img.shields.io/npm/v/remove-ai-signature.svg?style=flat-square)](https://www.npmjs.com/package/remove-ai-signature)
[![license](https://img.shields.io/npm/l/remove-ai-signature.svg?style=flat-square)](LICENSE)
[![MCP Protocol](https://img.shields.io/badge/MCP-2024--11--05-blue?style=flat-square)](https://modelcontextprotocol.io)

Open-source **Model Context Protocol (MCP)** server that enables AI Agents (Cursor, Claude Desktop, Antigravity, Windsurf, Claude Code) to detect, remove AI watermarks, signatures, and strip C2PA / EXIF / video container metadata directly on your local filesystem.

---

## ⚡ Key Highlights

- **100% Local & Private**: All image parsing, metadata stripping, and video processing runs on your local machine. No images or videos are ever uploaded to external cloud servers.
- **Zero Installation Needed**: Runs directly via `npx -y remove-ai-signature`.
- **Image Support**: JPEG, PNG, WEBP, GIF, BMP, SVG. Strips C2PA, CAI, SynthID, EXIF, XMP, IPTC, ICC, and GPS coordinates.
- **Video Support**: MP4, MOV, MKV, WebM. Lossless metadata stripping via stream-copy in `< 1s`, plus AI watermark removal using native FFmpeg `delogo`, `blur`, or `crop`.

---

## 🚀 Quick Setup

Add `remove-ai-signature` to your MCP client configuration:

### 1. Universal Config (Cursor / Claude Desktop / Antigravity / Windsurf)

Add to your MCP configuration file:
- **Cursor**: `.cursor/mcp.json` or `Settings > Features > MCP`
- **Claude Desktop**: `claude_desktop_config.json`
- **Antigravity CLI**: `~/.gemini/config/mcp_config.json`
- **Windsurf**: `~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "remove-ai-signature": {
      "command": "npx",
      "args": ["-y", "remove-ai-signature"]
    }
  }
}
```

### 2. Claude Code CLI

Run this single command in your terminal:

```bash
claude mcp add remove-ai-signature npx -y remove-ai-signature
```

### 3. Codex Desktop & Codex CLI

Codex uses TOML format (`~/.codex/config.toml` or `.codex/config.toml` in your project root):

```toml
[mcp_servers.remove-ai-signature]
command = "npx"
args = ["-y", "remove-ai-signature"]
```

Or configure via **Codex Desktop GUI**:
1. Open **Settings** $\rightarrow$ **Integrations** $\rightarrow$ **MCP Servers**
2. Click **Add Server**
3. Enter Name: `remove-ai-signature`, Command: `npx`, Arguments: `-y remove-ai-signature`

---

## 🛠️ Available Tools

### 🖼️ Image Tools

#### 1. `clean_watermark`
Removes AI watermarks (Midjourney, DALL-E, Canva, Recraft, etc.) from an image and strips all EXIF/C2PA metadata.
- **`image_data`** *(string, required)*: Local file path, Base64 string, Data URI, or HTTP/HTTPS image URL.
- **`output_path`** *(string, required)*: Destination file path.
- **`preset`** *(string, optional, default: `"bottom_right"`)*: `"bottom_right"` | `"bottom_left"` | `"top_right"` | `"top_left"` | `"bottom_bar"` | `"custom"`.
- **`strip_metadata`** *(boolean, optional, default: `true`)*: Strip all EXIF, XMP, and C2PA metadata.
- **`overwrite`** *(boolean, optional, default: `true`)*: Overwrite destination file if it exists.

#### 2. `strip_metadata`
Losslessly strips 100% of metadata (EXIF, XMP, IPTC, ICC profile, GPS coordinates, camera serials, and AI generator tags) at the binary level.
- **`file_path`** *(string, required)*: Path to image file.
- **`output_path`** *(string, optional)*: Destination path. Overwrites source file if omitted.

#### 3. `save_image`
Saves an image to disk from Base64, Data URI, HTTP/HTTPS URL, or local path. Automatically creates parent directories and detects format from magic bytes.
- **`image_data`** *(string, required)*: Base64, Data URI, URL, or local path.
- **`output_path`** *(string, required)*: Destination file path.
- **`overwrite`** *(boolean, optional, default: `true`)*.

#### 4. `read_image`
Reads an image file from disk and returns Base64 & Data URI so multimodal LLMs can inspect it.
- **`file_path`** *(string, required)*: Path to image file.

#### 5. `download_image`
Downloads an image directly from a URL to a local destination file.
- **`url`** *(string, required)*: Image URL.
- **`output_path`** *(string, required)*: Destination file path.
- **`overwrite`** *(boolean, optional, default: `true`)*.

---

### 🎬 Video Tools

> **Note**: Video tools utilize system `ffmpeg` and `ffprobe`. Please ensure FFmpeg is installed (`brew install ffmpeg` on macOS, `sudo apt install ffmpeg` on Linux, or `winget install ffmpeg` on Windows).

#### 6. `clean_video_watermark`
Removes AI watermarks and logos from video files (MP4, MOV, MKV, WebM) using `delogo` (pixel interpolation), `blur` (box blur), or `crop` filters.
- **`file_path`** *(string, required)*: Source video file path.
- **`output_path`** *(string, required)*: Destination video path.
- **`preset`** *(string, optional, default: `"bottom_right"`)*: `"bottom_right"` | `"bottom_left"` | `"top_right"` | `"top_left"` | `"bottom_bar"` | `"custom"`.
- **`method`** *(string, optional, default: `"delogo"`)*: `"delogo"` | `"blur"` | `"crop"`.
- **`region`** *(object, optional)*: Custom `{ x, y, width, height }` (supports percentage `0-100` or pixels) when `preset` is `"custom"`.
- **`strip_metadata`** *(boolean, optional, default: `true`)*: Strip container metadata tags.
- **`overwrite`** *(boolean, optional, default: `true`)*.

#### 7. `strip_video_metadata`
Losslessly strips 100% of metadata (encoder, creation time, handler names, tags, title, track metadata) from a video via stream-copy in **under 1 second** without re-encoding.
- **`file_path`** *(string, required)*: Source video file path.
- **`output_path`** *(string, optional)*: Destination path. Overwrites source file if omitted.
- **`overwrite`** *(boolean, optional, default: `true`)*.

#### 8. `inspect_video`
Inspects technical video metadata, audio/video streams, codecs, resolution, bitrates, frame rates, and embedded tags via `ffprobe`.
- **`file_path`** *(string, required)*: Path to video file.

---

## 💬 Example Prompts for AI Agents

Once connected, you can instruct your AI Agent in plain English:

### Image Watermark & C2PA Removal
```text
Use remove-ai-signature to inspect ./assets/banner.jpg, remove the watermark in the bottom-right corner, strip all C2PA and EXIF metadata, and save the result to ./assets/banner-clean.jpg.
```

### Batch Image Cleaning
```text
Scan all images in ./images/raw. For every file, remove watermark signatures and strip all EXIF/GPS metadata, then output the cleaned files into ./images/clean.
```

### Video Watermark Removal
```text
Please clean the AI watermark from the video ./assets/demo.mp4 at the bottom-right corner using the 'delogo' method, strip all container metadata, and save it as ./assets/demo-clean.mp4.
```

### Instant Video Metadata Stripping
```text
Strip all metadata and encoder tags from ./assets/recording.mov without re-encoding, and save it as ./assets/recording-clean.mov.
```

---

## 🔒 Privacy & Security

`remove-ai-signature` runs entirely in your local environment. It does not collect analytics, does not track telemetry, and never transmits your media files to third-party endpoints.

## 📄 License

MIT © [Nhat Nguyen](https://github.com/nhat251)
