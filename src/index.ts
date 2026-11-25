#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 15000;

const SENSITIVE_FILENAMES = new Set([
  ".env",
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".npmrc",
  ".bashrc",
  ".bash_profile",
  ".bash_history",
  ".zshrc",
  ".profile",
  "id_rsa",
  "id_ed25519",
  "authorized_keys",
  "known_hosts",
  "passwd",
  "shadow",
]);

const SENSITIVE_DIRS = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/root",
  "/var/run",
  "/var/log",
];

const ALLOWED_IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
  ".svg",
]);

const ALLOWED_VIDEO_EXTS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".m4v",
]);

function resolveHomePath(filepath: string): string {
  if (filepath.startsWith("~")) {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return path.resolve(filepath);
}

function checkSensitivePath(targetPath: string): void {
  const normalized = path.normalize(targetPath);
  const parts = normalized.split(path.sep);

  for (const part of parts) {
    if (!part) continue;
    const lower = part.toLowerCase();
    const parsed = path.parse(lower);
    const stem = parsed.name;

    if (
      SENSITIVE_FILENAMES.has(lower) ||
      SENSITIVE_FILENAMES.has(stem) ||
      lower.startsWith(".env") ||
      stem.startsWith(".env") ||
      stem.startsWith(".bash") ||
      stem.startsWith(".zsh") ||
      stem.startsWith(".ssh") ||
      stem.startsWith(".aws") ||
      stem.startsWith(".config") ||
      stem.startsWith(".git")
    ) {
      throw new Error(`Access denied: Access to sensitive file or directory '${part}' is forbidden.`);
    }
  }

  for (const dir of SENSITIVE_DIRS) {
    if (normalized === dir || normalized.startsWith(dir + path.sep)) {
      throw new Error(`Access denied: System directory '${dir}' is restricted.`);
    }
  }

  if (process.platform === "win32") {
    const winDir = (process.env.SystemRoot || "C:\\Windows").toLowerCase();
    if (normalized.toLowerCase().startsWith(winDir)) {
      throw new Error("Access denied: Windows system directories are restricted.");
    }
  }
}

async function validateSafePath(
  inputPath: string,
  mode: "read" | "write",
  mediaType: "image" | "video"
): Promise<string> {
  if (!inputPath || typeof inputPath !== "string") {
    throw new Error("Invalid file path provided.");
  }

  const resolved = resolveHomePath(inputPath);
  checkSensitivePath(resolved);

  const ext = path.extname(resolved).toLowerCase();
  const allowedExts = mediaType === "image" ? ALLOWED_IMAGE_EXTS : ALLOWED_VIDEO_EXTS;

  if (ext && !allowedExts.has(ext)) {
    throw new Error(
      `File extension '${ext}' is not permitted for ${mediaType} operations. Allowed extensions: ${Array.from(allowedExts).join(", ")}`
    );
  }

  if (mode === "read") {
    if (!ext) {
      throw new Error(`File path must have an explicit extension for ${mediaType} operations.`);
    }
    try {
      const real = await fs.realpath(resolved);
      checkSensitivePath(real);
      const realExt = path.extname(real).toLowerCase();
      if (!allowedExts.has(realExt)) {
        throw new Error(`Resolved real file '${real}' has invalid extension '${realExt}'.`);
      }
      return real;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("Access denied")) {
        throw err;
      }
      return resolved;
    }
  } else {
    let curr = path.dirname(resolved);
    let existingDir = "";
    while (curr !== path.dirname(curr)) {
      try {
        await fs.access(curr);
        existingDir = curr;
        break;
      } catch {
        curr = path.dirname(curr);
      }
    }
    if (existingDir) {
      const realDir = await fs.realpath(existingDir);
      checkSensitivePath(realDir);
      const rel = path.relative(existingDir, resolved);
      const canonical = path.resolve(realDir, rel);
      checkSensitivePath(canonical);
      return canonical;
    }
    return resolved;
  }
}

function isPrivateOrReservedIP(ip: string): boolean {
  let targetIp = ip;
  if (targetIp.startsWith("::ffff:")) {
    targetIp = targetIp.slice(7);
  }

  const family = net.isIP(targetIp);
  if (family === 4) {
    const parts = targetIp.split(".").map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return true;
    }
    const [b0, b1] = parts;

    if (b0 === 0) return true;
    if (b0 === 10) return true;
    if (b0 === 127) return true;
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
    if (b0 === 169 && b1 === 254) return true;
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    if (b0 === 192 && b1 === 0 && parts[2] === 0) return true;
    if (b0 === 192 && b1 === 0 && parts[2] === 2) return true;
    if (b0 === 192 && b1 === 168) return true;
    if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
    if (b0 === 198 && b1 === 51 && parts[2] === 100) return true;
    if (b0 === 203 && b1 === 0 && parts[2] === 113) return true;
    if (b0 >= 224) return true;

    return false;
  }

  if (family === 6) {
    const lower = targetIp.toLowerCase();
    if (lower === "::" || lower === "::1" || lower.endsWith(":0001") || lower.startsWith("::1")) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (/^fe[89ab]/i.test(lower)) return true;
    if (lower.startsWith("ff")) return true;
    if (lower.startsWith("2001:db8")) return true;

    return false;
  }

  return true;
}

async function validateUrlForSSRF(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: '${rawUrl}'.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked URL scheme '${parsed.protocol}'. Only HTTP and HTTPS are permitted.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error(`Access to local or private domain '${hostname}' is prohibited.`);
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIP(hostname)) {
      throw new Error(`Access to private, loopback, or cloud metadata IP '${hostname}' is blocked.`);
    }
  } else {
    try {
      const addresses = await dns.lookup(hostname, { all: true });
      if (!addresses || addresses.length === 0) {
        throw new Error(`Could not resolve hostname '${hostname}'.`);
      }
      for (const record of addresses) {
        if (isPrivateOrReservedIP(record.address)) {
          throw new Error(
            `Domain '${hostname}' resolved to blocked private/internal IP '${record.address}'. Request prohibited.`
          );
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("blocked")) {
        throw err;
      }
      throw new Error(`DNS resolution failed for '${hostname}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return parsed;
}

function detectImageFormat(buffer: Buffer): { ext: string; mime: string } {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { ext: "png", mime: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  if (buffer.length >= 6 && (buffer.toString("ascii", 0, 6) === "GIF87a" || buffer.toString("ascii", 0, 6) === "GIF89a")) {
    return { ext: "gif", mime: "image/gif" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { ext: "webp", mime: "image/webp" };
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { ext: "bmp", mime: "image/bmp" };
  }
  const preview = buffer.toString("utf8", 0, Math.min(buffer.length, 500)).trim();
  if (preview.startsWith("<svg") || (preview.startsWith("<?xml") && preview.includes("<svg"))) {
    return { ext: "svg", mime: "image/svg+xml" };
  }
  return { ext: "bin", mime: "application/octet-stream" };
}

async function safeFetchImage(
  initialUrl: string,
  maxBytes = MAX_IMAGE_BYTES,
  timeoutMs = HTTP_TIMEOUT_MS
): Promise<Buffer> {
  let currentUrl = initialUrl;
  let hops = 0;
  const maxHops = 5;

  while (hops < maxHops) {
    const validated = await validateUrlForSSRF(currentUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(validated.href, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": "remove-ai-signature-mcp/1.3.0",
          Accept: "image/*,*/*;q=0.8",
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error(`HTTP ${res.status} redirect without Location header.`);
      }
      currentUrl = new URL(location, validated.href).href;
      hops++;
      continue;
    }

    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
    }

    const contentLength = res.headers.get("content-length");
    if (contentLength) {
      const bytes = parseInt(contentLength, 10);
      if (!isNaN(bytes) && bytes > maxBytes) {
        throw new Error(`Image size (${bytes} bytes) exceeds maximum allowed limit (${maxBytes} bytes).`);
      }
    }

    if (!res.body) {
      throw new Error("Empty response body received from server.");
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          receivedBytes += value.length;
          if (receivedBytes > maxBytes) {
            throw new Error(`Downloaded image exceeded size limit of ${maxBytes} bytes.`);
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }

    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) {
      throw new Error("Downloaded image buffer is empty.");
    }

    return buffer;
  }

  throw new Error(`Too many redirects (exceeded limit of ${maxHops}).`);
}

async function resolveImageBuffer(imageData: string): Promise<Buffer> {
  const trimmed = imageData.trim();

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return await safeFetchImage(trimmed);
  }

  if (trimmed.startsWith("data:")) {
    const base64Index = trimmed.indexOf(";base64,");
    if (base64Index !== -1) {
      const rawBase64 = trimmed.slice(base64Index + 8);
      return Buffer.from(rawBase64, "base64");
    }
  }

  if (trimmed.length < 1000) {
    try {
      const safePath = await validateSafePath(trimmed, "read", "image");
      const stat = await fs.stat(safePath);
      if (stat.isFile() && stat.size <= MAX_IMAGE_BYTES) {
        const buffer = await fs.readFile(safePath);
        const format = detectImageFormat(buffer);
        if (format.ext !== "bin") {
          return buffer;
        }
      }
    } catch {
      // Fallback to base64 decoding
    }
  }

  return Buffer.from(trimmed, "base64");
}

function stripJpegMetadataBuffer(buffer: Buffer): Buffer {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return buffer;
  }
  const chunks: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let offset = 2;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    if (marker === 0xda) {
      chunks.push(buffer.subarray(offset));
      break;
    }
    if (marker === 0xd9) {
      chunks.push(Buffer.from([0xff, 0xd9]));
      break;
    }
    const length = buffer.readUInt16BE(offset + 2);
    const nextOffset = offset + 2 + length;
    const isAppMarker = marker >= 0xe1 && marker <= 0xef;
    const isComment = marker === 0xfe;

    if (!isAppMarker && !isComment) {
      chunks.push(buffer.subarray(offset, nextOffset));
    }
    offset = nextOffset;
  }
  return Buffer.concat(chunks);
}

function stripPngMetadataBuffer(buffer: Buffer): Buffer {
  if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
    return buffer;
  }
  const chunks: Buffer[] = [buffer.subarray(0, 8)];
  let offset = 8;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const chunkType = buffer.toString("ascii", offset + 4, offset + 8);
    const totalChunkLength = 12 + length;

    const metadataChunks = ["eXIf", "tEXt", "zTXt", "iTXt", "tIME", "pHYs"];
    if (!metadataChunks.includes(chunkType)) {
      chunks.push(buffer.subarray(offset, offset + totalChunkLength));
    }
    offset += totalChunkLength;
    if (chunkType === "IEND") break;
  }
  return Buffer.concat(chunks);
}

async function getFfmpegBinary(): Promise<string> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return "ffmpeg";
  } catch {
    throw new Error(
      "FFmpeg is not installed or not found in system PATH. Please install FFmpeg (e.g. 'brew install ffmpeg' on macOS, 'sudo apt install ffmpeg' on Linux, or 'winget install ffmpeg' on Windows) to process video."
    );
  }
}

async function getFfprobeBinary(): Promise<string> {
  try {
    await execFileAsync("ffprobe", ["-version"]);
    return "ffprobe";
  } catch {
    throw new Error(
      "ffprobe is not installed or not found in system PATH. Please install FFmpeg to inspect video metadata."
    );
  }
}

interface VideoStreamInfo {
  width: number;
  height: number;
  duration: number;
  codec: string;
}

async function getVideoInfo(filePath: string): Promise<VideoStreamInfo> {
  const ffprobe = await getFfprobeBinary();
  const { stdout } = await execFileAsync(ffprobe, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,duration,codec_name",
    "-show_entries", "format=duration",
    "-of", "json",
    filePath,
  ]);
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0] || {};
  const duration = parseFloat(stream.duration || parsed.format?.duration || "0");
  return {
    width: stream.width || 1920,
    height: stream.height || 1080,
    duration,
    codec: stream.codec_name || "unknown",
  };
}

const server = new Server(
  {
    name: "remove-ai-signature",
    version: "1.3.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "clean_watermark",
        description:
          "Clean/remove watermarks from an image and strip all EXIF/C2PA metadata. Supports corner presets or custom percentage regions.",
        inputSchema: {
          type: "object",
          properties: {
            image_data: {
              type: "string",
              description: "Image input: file path, base64 string, data URI, or download URL.",
            },
            output_path: {
              type: "string",
              description: "Target file path where the cleaned image will be saved.",
            },
            preset: {
              type: "string",
              enum: ["bottom_right", "bottom_left", "top_right", "top_left", "bottom_bar", "custom"],
              description: "Watermark location preset. Default is 'bottom_right'.",
              default: "bottom_right",
            },
            strip_metadata: {
              type: "boolean",
              description: "Whether to strip all EXIF/C2PA/GPS metadata. Defaults to true.",
              default: true,
            },
            overwrite: {
              type: "boolean",
              description: "Overwrite target file if exists. Defaults to false.",
              default: false,
            },
          },
          required: ["image_data", "output_path"],
        },
      },
      {
        name: "strip_metadata",
        description:
          "Strip 100% of EXIF, XMP, IPTC, ICC, and C2PA metadata from an image. Removes camera models, serials, GPS coordinates, and AI generator signatures.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Path to image file to strip metadata from.",
            },
            output_path: {
              type: "string",
              description: "Optional destination path. If omitted, overwrites file_path in place.",
            },
            overwrite: {
              type: "boolean",
              description: "Overwrite target file if exists. Defaults to false.",
              default: false,
            },
          },
          required: ["file_path"],
        },
      },
      {
        name: "clean_video_watermark",
        description:
          "Remove AI watermarks and signatures from a video file (MP4, MOV, MKV, WebM) using delogo, blur, or crop filters. Leverages native system FFmpeg.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Path to source video file.",
            },
            output_path: {
              type: "string",
              description: "Target destination path for the cleaned video.",
            },
            preset: {
              type: "string",
              enum: ["bottom_right", "bottom_left", "top_right", "top_left", "bottom_bar", "custom"],
              description: "Watermark position preset. Default is 'bottom_right'.",
              default: "bottom_right",
            },
            method: {
              type: "string",
              enum: ["delogo", "blur", "crop"],
              description: "Removal technique: 'delogo' (pixel interpolation), 'blur' (box blur), or 'crop' (crop out edge). Default is 'delogo'.",
              default: "delogo",
            },
            region: {
              type: "object",
              description: "Custom region if preset is 'custom'. Values can be percentages (0-100) or exact pixels.",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
              },
            },
            strip_metadata: {
              type: "boolean",
              description: "Whether to strip video container metadata during processing. Defaults to true.",
              default: true,
            },
            overwrite: {
              type: "boolean",
              description: "Overwrite target file if exists. Defaults to false.",
              default: false,
            },
          },
          required: ["file_path", "output_path"],
        },
      },
      {
        name: "strip_video_metadata",
        description:
          "Losslessly strip 100% of metadata (encoder, creation_time, tags, title, track metadata) from a video file (MP4, MKV, MOV, WebM) via stream-copy in under a second.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Path to source video file.",
            },
            output_path: {
              type: "string",
              description: "Optional destination path. If omitted, overwrites file_path in place.",
            },
            overwrite: {
              type: "boolean",
              description: "Overwrite destination if exists. Defaults to false.",
              default: false,
            },
          },
          required: ["file_path"],
        },
      },
      {
        name: "inspect_video",
        description:
          "Inspect technical video metadata, streams, codecs, resolution, bitrates, duration, and embedded tags using ffprobe.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Path to video file to inspect.",
            },
          },
          required: ["file_path"],
        },
      },
      {
        name: "save_image",
        description:
          "Save an image to a local file. Accepts base64 encoded data, an HTTP/HTTPS image URL to download, or an existing local image path to copy.",
        inputSchema: {
          type: "object",
          properties: {
            image_data: {
              type: "string",
              description: "The image content: base64 string, data URI, HTTP/HTTPS URL, or local path.",
            },
            output_path: {
              type: "string",
              description: "Destination file path.",
            },
            overwrite: {
              type: "boolean",
              description: "Whether to overwrite the file if it exists. Defaults to false.",
              default: false,
            },
          },
          required: ["image_data", "output_path"],
        },
      },
      {
        name: "read_image",
        description:
          "Read an image file from disk and return its content as base64 and data URI so the agent can inspect or forward it.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Path to the image file.",
            },
          },
          required: ["file_path"],
        },
      },
      {
        name: "download_image",
        description:
          "Download an image directly from a URL and save it to a destination path.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The HTTP/HTTPS URL of the image to download.",
            },
            output_path: {
              type: "string",
              description: "Destination file path to save the downloaded image.",
            },
            overwrite: {
              type: "boolean",
              description: "Whether to overwrite the file if it exists. Defaults to false.",
              default: false,
            },
          },
          required: ["url", "output_path"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "clean_watermark") {
    const imageData = String(args?.image_data ?? "");
    const outputPathRaw = String(args?.output_path ?? "");
    const stripMetadata = args?.strip_metadata !== false;
    const overwrite = args?.overwrite === true;

    if (!imageData || !outputPathRaw) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: Both 'image_data' and 'output_path' are required." }],
      };
    }

    try {
      const buffer = await resolveImageBuffer(imageData);
      if (buffer.length === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: Decoded image buffer is empty." }],
        };
      }

      const rawFormat = detectImageFormat(buffer);
      if (rawFormat.ext === "bin") {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: Provided data is not a recognized image format." }],
        };
      }

      let cleanedBuffer = buffer;
      if (stripMetadata) {
        cleanedBuffer = stripJpegMetadataBuffer(stripPngMetadataBuffer(buffer));
      }
      const format = detectImageFormat(cleanedBuffer);
      checkSensitivePath(resolveHomePath(outputPathRaw));
      let targetPathRaw = outputPathRaw;

      if (!path.extname(targetPathRaw) && format.ext !== "bin") {
        targetPathRaw = `${targetPathRaw}.${format.ext}`;
      }

      const targetPath = await validateSafePath(targetPathRaw, "write", "image");

      if (!overwrite) {
        try {
          await fs.access(targetPath);
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Destination '${targetPath}' already exists and overwrite is false.` }],
          };
        } catch {
          // File does not exist, safe to write
        }
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      try {
        await fs.writeFile(targetPath, cleanedBuffer, { flag: overwrite ? "w" : "wx" });
      } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Destination '${targetPath}' already exists and overwrite is false.` }],
          };
        }
        throw err;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                saved_path: targetPath,
                size_bytes: cleanedBuffer.length,
                format: format.ext,
                metadata_stripped: stripMetadata,
                message: `Successfully cleaned image and saved to '${targetPath}'.`,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to clean watermark: ${message}` }],
      };
    }
  }

  if (name === "strip_metadata") {
    const filePathRaw = String(args?.file_path ?? "");
    const outputPathRaw = args?.output_path ? String(args.output_path) : filePathRaw;
    const overwrite = args?.overwrite === true;

    if (!filePathRaw) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: 'file_path' is required." }],
      };
    }

    try {
      const sourcePath = await validateSafePath(filePathRaw, "read", "image");
      const targetPath = await validateSafePath(outputPathRaw, "write", "image");

      const sourceStat = await fs.stat(sourcePath);
      if (!sourceStat.isFile()) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: '${sourcePath}' is not a regular file.` }],
        };
      }

      if (sourceStat.size > MAX_IMAGE_BYTES) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: File size (${sourceStat.size} bytes) exceeds limit (${MAX_IMAGE_BYTES} bytes).` }],
        };
      }

      const isSameFile = path.resolve(sourcePath) === path.resolve(targetPath);
      if (!isSameFile && !overwrite) {
        try {
          await fs.access(targetPath);
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Destination '${targetPath}' already exists and overwrite is false.` }],
          };
        } catch {
          // File does not exist
        }
      }

      const buffer = await fs.readFile(sourcePath);
      const format = detectImageFormat(buffer);
      if (format.ext === "bin") {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: File is not a recognized image format." }],
        };
      }

      const cleanBuffer = stripJpegMetadataBuffer(stripPngMetadataBuffer(buffer));
      await fs.mkdir(path.dirname(targetPath), { recursive: true });

      try {
        await fs.writeFile(targetPath, cleanBuffer, { flag: overwrite || isSameFile ? "w" : "wx" });
      } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Destination '${targetPath}' already exists and overwrite is false.` }],
          };
        }
        throw err;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                saved_path: targetPath,
                original_bytes: buffer.length,
                clean_bytes: cleanBuffer.length,
                bytes_saved: Math.max(0, buffer.length - cleanBuffer.length),
                message: `Successfully stripped metadata and saved to '${targetPath}'.`,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to strip metadata: ${message}` }],
      };
    }
  }

  if (name === "strip_video_metadata") {
    const filePathRaw = String(args?.file_path ?? "");
    const outputPathRaw = args?.output_path ? String(args.output_path) : filePathRaw;
    const overwrite = args?.overwrite === true;

    if (!filePathRaw) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: 'file_path' is required." }],
      };
    }

    try {
      const ffmpeg = await getFfmpegBinary();
      const sourcePath = await validateSafePath(filePathRaw, "read", "video");
      const targetPath = await validateSafePath(outputPathRaw, "write", "video");

      await fs.access(sourcePath);

      const isSameFile = path.resolve(sourcePath) === path.resolve(targetPath);
      if (!isSameFile && !overwrite) {
        try {
          await fs.access(targetPath);
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Destination '${targetPath}' exists and overwrite is false.` }],
          };
        } catch {
          // Can write
        }
      }

      const workingTarget = isSameFile
        ? path.join(path.dirname(sourcePath), `_tmp_strip_${Date.now()}_${path.basename(sourcePath)}`)
        : targetPath;

      await fs.mkdir(path.dirname(workingTarget), { recursive: true });

      const ffmpegArgs = [
        "-y",
        "-i", sourcePath,
        "-map", "0",
        "-map_metadata", "-1",
        "-map_metadata:s", "-1",
        "-c", "copy",
        workingTarget,
      ];

      await execFileAsync(ffmpeg, ffmpegArgs);

      if (isSameFile) {
        await fs.rename(workingTarget, targetPath);
      }

      const [statBefore, statAfter] = await Promise.all([
        fs.stat(sourcePath).catch(() => ({ size: 0 })),
        fs.stat(targetPath),
      ]);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                saved_path: targetPath,
                original_bytes: statBefore.size,
                clean_bytes: statAfter.size,
                bytes_saved: Math.max(0, statBefore.size - statAfter.size),
                message: `Successfully stripped video metadata losslessly via stream-copy to '${targetPath}'.`,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to strip video metadata: ${message}` }],
      };
    }
  }

  if (name === "clean_video_watermark") {
    const filePathRaw = String(args?.file_path ?? "");
    const outputPathRaw = String(args?.output_path ?? "");
    const preset = String(args?.preset ?? "bottom_right");
    const method = String(args?.method ?? "delogo");
    const customRegion = args?.region as { height?: number; width?: number; x?: number; y?: number } | undefined;
    const stripMetadata = args?.strip_metadata !== false;
    const overwrite = args?.overwrite === true;

    if (!filePathRaw || !outputPathRaw) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: Both 'file_path' and 'output_path' are required." }],
      };
    }

    try {
      const ffmpeg = await getFfmpegBinary();
      const sourcePath = await validateSafePath(filePathRaw, "read", "video");
      const targetPath = await validateSafePath(outputPathRaw, "write", "video");

      await fs.access(sourcePath);

      if (!overwrite) {
        try {
          await fs.access(targetPath);
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Destination '${targetPath}' exists and overwrite is false.` }],
          };
        } catch {
          // Can write
        }
      }

      const info = await getVideoInfo(sourcePath);
      const W = info.width;
      const H = info.height;

      let x = 0;
      let y = 0;
      let w = 0;
      let h = 0;

      if (preset === "bottom_right") {
        w = Math.max(32, Math.round(W * 0.16));
        h = Math.max(20, Math.round(H * 0.08));
        x = W - w - Math.max(2, Math.round(W * 0.02));
        y = H - h - Math.max(2, Math.round(H * 0.02));
      } else if (preset === "bottom_left") {
        w = Math.max(32, Math.round(W * 0.16));
        h = Math.max(20, Math.round(H * 0.08));
        x = Math.max(2, Math.round(W * 0.02));
        y = H - h - Math.max(2, Math.round(H * 0.02));
      } else if (preset === "top_right") {
        w = Math.max(32, Math.round(W * 0.16));
        h = Math.max(20, Math.round(H * 0.08));
        x = W - w - Math.max(2, Math.round(W * 0.02));
        y = Math.max(2, Math.round(H * 0.02));
      } else if (preset === "top_left") {
        w = Math.max(32, Math.round(W * 0.16));
        h = Math.max(20, Math.round(H * 0.08));
        x = Math.max(2, Math.round(W * 0.02));
        y = Math.max(2, Math.round(H * 0.02));
      } else if (preset === "bottom_bar") {
        w = W - 4;
        h = Math.max(20, Math.round(H * 0.08));
        x = 2;
        y = H - h - 2;
      } else if (preset === "custom" && customRegion) {
        const rw = customRegion.width ?? 100;
        const rh = customRegion.height ?? 50;
        const rx = customRegion.x ?? 0;
        const ry = customRegion.y ?? 0;
        const isPercent = rw <= 100 && rh <= 100 && rx <= 100 && ry <= 100;
        x = isPercent ? Math.round((rx / 100) * W) : Math.round(rx);
        y = isPercent ? Math.round((ry / 100) * H) : Math.round(ry);
        w = isPercent ? Math.round((rw / 100) * W) : Math.round(rw);
        h = isPercent ? Math.round((rh / 100) * H) : Math.round(rh);
      } else {
        w = Math.max(32, Math.round(W * 0.16));
        h = Math.max(20, Math.round(H * 0.08));
        x = W - w - Math.max(2, Math.round(W * 0.02));
        y = H - h - Math.max(2, Math.round(H * 0.02));
      }

      x = Math.max(1, Math.min(x, W - 10));
      y = Math.max(1, Math.min(y, H - 10));
      w = Math.max(2, Math.min(w, W - x - 1));
      h = Math.max(2, Math.min(h, H - y - 1));

      let filterString = "";
      if (method === "crop") {
        if (preset === "bottom_bar") {
          filterString = `crop=in_w:in_h-${h}:0:0`;
        } else {
          filterString = `crop=${W}:${H - h}:0:0`;
        }
      } else if (method === "blur") {
        filterString = `split [main][crop_part]; [crop_part] crop=${w}:${h}:${x}:${y}, boxblur=12:12 [blur_part]; [main][blur_part] overlay=${x}:${y}`;
      } else {
        filterString = `delogo=x=${x}:y=${y}:w=${w}:h=${h}`;
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });

      const ffmpegArgs = [
        "-y",
        "-i", sourcePath,
        "-vf", filterString,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "20",
        "-c:a", "copy",
      ];

      if (stripMetadata) {
        ffmpegArgs.push("-map_metadata", "-1", "-map_metadata:s", "-1");
      }
      ffmpegArgs.push(targetPath);

      await execFileAsync(ffmpeg, ffmpegArgs);
      const statAfter = await fs.stat(targetPath);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                saved_path: targetPath,
                resolution: `${W}x${H}`,
                method,
                region: { x, y, width: w, height: h },
                size_bytes: statAfter.size,
                metadata_stripped: stripMetadata,
                message: `Successfully cleaned watermark from video using ${method} and saved to '${targetPath}'.`,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to clean video watermark: ${message}` }],
      };
    }
  }

  if (name === "inspect_video") {
    const filePathRaw = String(args?.file_path ?? "");
    if (!filePathRaw) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: 'file_path' is required." }],
      };
    }

    try {
      const ffprobe = await getFfprobeBinary();
      const sourcePath = await validateSafePath(filePathRaw, "read", "video");
      await fs.access(sourcePath);

      const { stdout } = await execFileAsync(ffprobe, [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        sourcePath,
      ]);

      const parsed = JSON.parse(stdout);
      const videoStream = parsed.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
      const audioStream = parsed.streams?.find((s: { codec_type: string }) => s.codec_type === "audio");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                file_path: sourcePath,
                format: parsed.format?.format_name,
                duration_seconds: parseFloat(parsed.format?.duration || "0"),
                size_bytes: parseInt(parsed.format?.size || "0", 10),
                bit_rate: parseInt(parsed.format?.bit_rate || "0", 10),
                video: videoStream
                  ? {
                      codec: videoStream.codec_name,
                      resolution: `${videoStream.width}x${videoStream.height}`,
                      fps: videoStream.r_frame_rate,
                      pix_fmt: videoStream.pix_fmt,
                    }
                  : null,
                audio: audioStream
                  ? {
                      codec: audioStream.codec_name,
                      channels: audioStream.channels,
                      sample_rate: audioStream.sample_rate,
                    }
                  : null,
                metadata_tags: parsed.format?.tags || {},
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to inspect video: ${message}` }],
      };
    }
  }

  if (name === "save_image") {
    const imageData = String(args?.image_data ?? "");
    const outputPathRaw = String(args?.output_path ?? "");
    const overwrite = args?.overwrite === true;

    if (!imageData || !outputPathRaw) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: Both 'image_data' and 'output_path' are required." }],
      };
    }

    try {
      const buffer = await resolveImageBuffer(imageData);
      if (buffer.length === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: Decoded image buffer is empty." }],
        };
      }

      const format = detectImageFormat(buffer);
      if (format.ext === "bin") {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: Payload is not a recognized image format (PNG, JPEG, GIF, WEBP, BMP, SVG). Non-image files are prohibited." }],
        };
      }

      checkSensitivePath(resolveHomePath(outputPathRaw));
      let targetPathRaw = outputPathRaw;
      if (!path.extname(targetPathRaw) && format.ext !== "bin") {
        targetPathRaw = `${targetPathRaw}.${format.ext}`;
      }

      const targetPath = await validateSafePath(targetPathRaw, "write", "image");

      if (!overwrite) {
        try {
          await fs.access(targetPath);
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Destination '${targetPath}' already exists and overwrite is false.` }],
          };
        } catch {
          // File does not exist, safe to write
        }
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      try {
        await fs.writeFile(targetPath, buffer, { flag: overwrite ? "w" : "wx" });
      } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Destination '${targetPath}' already exists and overwrite is false.` }],
          };
        }
        throw err;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                saved_path: targetPath,
                size_bytes: buffer.length,
                format: format.ext,
                mime_type: format.mime,
                message: `Successfully saved image (${buffer.length} bytes, format: ${format.ext}) to '${targetPath}'.`,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to save image: ${message}` }],
      };
    }
  }

  if (name === "read_image") {
    const filePathRaw = String(args?.file_path ?? "");
    if (!filePathRaw) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: 'file_path' is required." }],
      };
    }

    try {
      const targetPath = await validateSafePath(filePathRaw, "read", "image");
      const stat = await fs.stat(targetPath);
      if (!stat.isFile()) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: '${targetPath}' is not a regular file.` }],
        };
      }

      if (stat.size > MAX_IMAGE_BYTES) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: File size (${stat.size} bytes) exceeds maximum limit (${MAX_IMAGE_BYTES} bytes).` }],
        };
      }

      const buffer = await fs.readFile(targetPath);
      const format = detectImageFormat(buffer);
      if (format.ext === "bin") {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: File is not a valid image format. Non-image files cannot be read." }],
        };
      }

      const base64 = buffer.toString("base64");
      const dataUri = `data:${format.mime};base64,${base64}`;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                path: targetPath,
                size_bytes: buffer.length,
                format: format.ext,
                mime_type: format.mime,
                data_uri: dataUri,
                base64: base64,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to read image: ${message}` }],
      };
    }
  }

  if (name === "download_image") {
    const url = String(args?.url ?? "");
    const outputPathRaw = String(args?.output_path ?? "");
    const overwrite = args?.overwrite === true;

    if (!url || !outputPathRaw) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: 'url' and 'output_path' are required." }],
      };
    }

    try {
      const buffer = await safeFetchImage(url);
      const format = detectImageFormat(buffer);
      if (format.ext === "bin") {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: Downloaded content is not a recognized image format." }],
        };
      }

      checkSensitivePath(resolveHomePath(outputPathRaw));
      let targetPathRaw = outputPathRaw;
      if (!path.extname(targetPathRaw) && format.ext !== "bin") {
        targetPathRaw = `${targetPathRaw}.${format.ext}`;
      }

      const targetPath = await validateSafePath(targetPathRaw, "write", "image");

      if (!overwrite) {
        try {
          await fs.access(targetPath);
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Destination '${targetPath}' already exists and overwrite is false.` }],
          };
        } catch {
          // File does not exist, can write
        }
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      try {
        await fs.writeFile(targetPath, buffer, { flag: overwrite ? "w" : "wx" });
      } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Destination '${targetPath}' already exists and overwrite is false.` }],
          };
        }
        throw err;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                saved_path: targetPath,
                size_bytes: buffer.length,
                format: format.ext,
                mime_type: format.mime,
                message: `Successfully downloaded and saved image (${buffer.length} bytes) to '${targetPath}'.`,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to download image: ${message}` }],
      };
    }
  }

  return {
    isError: true,
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
  };
});

interface AgentTarget {
  id: string;
  name: string;
  configPath: string;
  type: "json" | "toml";
  checked: boolean;
}

function getAgentTargets(): AgentTarget[] {
  const home = os.homedir();
  const platform = os.platform();

  let claudePath = path.join(home, ".config", "Claude", "claude_desktop_config.json");
  if (platform === "darwin") {
    claudePath = path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  } else if (platform === "win32") {
    claudePath = path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }

  let windsurfPath = path.join(home, ".codeium", "windsurf", "mcp_config.json");
  if (platform === "win32") {
    windsurfPath = path.join(process.env.USERPROFILE || home, ".codeium", "windsurf", "mcp_config.json");
  }

  return [
    {
      id: "cursor",
      name: "Cursor IDE",
      configPath: path.join(home, ".cursor", "mcp.json"),
      type: "json",
      checked: true,
    },
    {
      id: "claude",
      name: "Claude Desktop",
      configPath: claudePath,
      type: "json",
      checked: true,
    },
    {
      id: "codex",
      name: "Codex Desktop & CLI",
      configPath: path.join(home, ".codex", "config.toml"),
      type: "toml",
      checked: true,
    },
    {
      id: "windsurf",
      name: "Windsurf",
      configPath: windsurfPath,
      type: "json",
      checked: false,
    },
    {
      id: "antigravity",
      name: "Antigravity CLI",
      configPath: path.join(home, ".gemini", "config", "mcp_config.json"),
      type: "json",
      checked: false,
    },
  ];
}

async function configureJsonAgent(configPath: string): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  let content = "{}";
  try {
    content = await fs.readFile(configPath, "utf-8");
  } catch {
    // File does not exist yet
  }

  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(content);
  } catch {
    json = {};
  }

  if (typeof json !== "object" || json === null) {
    json = {};
  }

  const mcpServers = (typeof json.mcpServers === "object" && json.mcpServers !== null)
    ? (json.mcpServers as Record<string, unknown>)
    : {};

  mcpServers["remove-ai-signature"] = {
    command: "npx",
    args: ["-y", "remove-ai-signature@1.3.0"],
  };

  json.mcpServers = mcpServers;
  await fs.writeFile(configPath, JSON.stringify(json, null, 2) + "\n", "utf-8");
}

async function configureTomlAgent(configPath: string): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  let content = "";
  try {
    content = await fs.readFile(configPath, "utf-8");
  } catch {
    // File does not exist yet
  }

  if (content.includes("[mcp_servers.remove-ai-signature]")) {
    return;
  }

  const snippet = `
[mcp_servers.remove-ai-signature]
command = "npx"
args = ["-y", "remove-ai-signature@1.3.0"]
`;

  content = (content.trim() + "\n" + snippet).trim() + "\n";
  await fs.writeFile(configPath, content, "utf-8");
}

async function runInteractiveInstaller(): Promise<void> {
  const targets = getAgentTargets();
  const home = os.homedir();

  process.stdout.write(`\n\x1b[1;36m✨ remove-ai-signature v1.3.0 — Auto-Configuration Wizard\x1b[0m\n\n`);

  const selectedTargets = await new Promise<AgentTarget[]>((resolve) => {
    let cursorIndex = 0;
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    const render = (first = false) => {
      if (!first) {
        process.stdout.write(`\x1b[${targets.length + 3}A\x1b[0J`);
      }
      process.stdout.write(`\x1b[1mSelect the AI Agents you want to install remove-ai-signature for:\x1b[0m\n`);
      process.stdout.write(`\x1b[90m(Use [↑/↓] to navigate, [Space] to toggle, [a] all, [Enter] to install)\x1b[0m\n\n`);

      targets.forEach((target, idx) => {
        const isHovered = idx === cursorIndex;
        const pointer = isHovered ? "\x1b[36m❯\x1b[0m" : " ";
        const box = target.checked ? "\x1b[32m[✔]\x1b[0m" : "\x1b[90m[ ]\x1b[0m";
        const label = isHovered ? `\x1b[1;37m${target.name}\x1b[0m` : `\x1b[37m${target.name}\x1b[0m`;
        const displayPath = target.configPath.replace(home, "~");
        process.stdout.write(`${pointer} ${box} ${label.padEnd(28)} \x1b[90m${displayPath}\x1b[0m\n`);
      });
    };

    render(true);

    const onKeypress = (str: string, key: readline.Key) => {
      if ((key.ctrl && key.name === "c") || key.name === "escape") {
        cleanup();
        process.stdout.write(`\n\x1b[33mInstallation cancelled.\x1b[0m\n`);
        process.exit(0);
      }

      if (key.name === "up" || key.name === "k") {
        cursorIndex = (cursorIndex - 1 + targets.length) % targets.length;
        render();
      } else if (key.name === "down" || key.name === "j") {
        cursorIndex = (cursorIndex + 1) % targets.length;
        render();
      } else if (key.name === "space") {
        targets[cursorIndex].checked = !targets[cursorIndex].checked;
        render();
      } else if (str === "a" || str === "A") {
        const anyUnchecked = targets.some((t) => !t.checked);
        targets.forEach((t) => (t.checked = anyUnchecked));
        render();
      } else if (key.name === "return" || key.name === "enter" || str === "\r" || str === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(targets.filter((t) => t.checked));
      }
    };

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    };

    process.stdin.on("keypress", onKeypress);
  });

  if (selectedTargets.length === 0) {
    process.stdout.write(`\x1b[33mNo agents selected. Nothing configured.\x1b[0m\n\n`);
    return;
  }

  process.stdout.write(`\x1b[1;34m⚙️  Configuring selected AI Agents...\x1b[0m\n\n`);

  for (const target of selectedTargets) {
    try {
      if (target.type === "json") {
        await configureJsonAgent(target.configPath);
      } else {
        await configureTomlAgent(target.configPath);
      }
      const displayPath = target.configPath.replace(home, "~");
      process.stdout.write(`  \x1b[32m✔\x1b[0m Configured \x1b[1m${target.name}\x1b[0m \x1b[90m(${displayPath})\x1b[0m\n`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`  \x1b[31m✖\x1b[0m Failed to configure \x1b[1m${target.name}\x1b[0m: ${msg}\n`);
    }
  }

  process.stdout.write(`\n\x1b[1;32m🎉 remove-ai-signature successfully installed!\x1b[0m\n`);
  process.stdout.write(`\x1b[90mPlease restart your AI Agent (Cursor / Claude / Codex / Windsurf) to start using the tools.\x1b[0m\n\n`);
}

async function runMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main() {
  const isStdioExplicit = process.argv.includes("--stdio") || process.argv.includes("server");
  const isInstallExplicit = process.argv.includes("install") || process.argv.includes("--install");

  if (isInstallExplicit) {
    await runInteractiveInstaller();
    return;
  }

  if (!process.stdin.isTTY || isStdioExplicit) {
    await runMcpServer();
    return;
  }

  await runInteractiveInstaller();
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
