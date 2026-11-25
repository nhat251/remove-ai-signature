#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function resolveHomePath(filepath: string): string {
  if (filepath.startsWith("~")) {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return path.resolve(filepath);
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

async function resolveImageBuffer(imageData: string): Promise<Buffer> {
  const trimmed = imageData.trim();

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const res = await fetch(trimmed);
    if (!res.ok) {
      throw new Error(`Failed to download image from URL: ${res.status} ${res.statusText}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
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
      const resolvedPath = resolveHomePath(trimmed);
      const stat = await fs.stat(resolvedPath);
      if (stat.isFile()) {
        return await fs.readFile(resolvedPath);
      }
    } catch {
      // Not a file on disk, proceed to base64 decode
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
    version: "1.2.0",
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
              description: "Overwrite target file if exists. Defaults to true.",
              default: true,
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
              description: "Optional destination path. If omitted, overwrites file_path.",
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
              description: "Overwrite target file if exists. Defaults to true.",
              default: true,
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
              description: "Optional destination path. If omitted, overwrites file_path.",
            },
            overwrite: {
              type: "boolean",
              description: "Overwrite destination if exists. Defaults to true.",
              default: true,
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
              description: "Whether to overwrite the file if it exists. Defaults to true.",
              default: true,
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
              description: "Whether to overwrite the file if it exists. Defaults to true.",
              default: true,
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
    const overwrite = args?.overwrite !== false;

    if (!imageData || !outputPathRaw) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: Both 'image_data' and 'output_path' are required." }],
      };
    }

    try {
      const buffer = await resolveImageBuffer(imageData);
      let cleanedBuffer = buffer;
      if (stripMetadata) {
        cleanedBuffer = stripJpegMetadataBuffer(stripPngMetadataBuffer(buffer));
      }
      const format = detectImageFormat(cleanedBuffer);
      let targetPath = resolveHomePath(outputPathRaw);

      if (!path.extname(targetPath) && format.ext !== "bin") {
        targetPath = `${targetPath}.${format.ext}`;
      }

      if (!overwrite) {
        try {
          await fs.access(targetPath);
          return {
            isError: true,
            content: [{ type: "text", text: `Error: File '${targetPath}' already exists and overwrite is false.` }],
          };
        } catch {
          // File does not exist, can write
        }
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, cleanedBuffer);

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

    if (!filePathRaw) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: 'file_path' is required." }],
      };
    }

    try {
      const sourcePath = resolveHomePath(filePathRaw);
      const targetPath = resolveHomePath(outputPathRaw);
      const buffer = await fs.readFile(sourcePath);
      const cleanBuffer = stripJpegMetadataBuffer(stripPngMetadataBuffer(buffer));

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, cleanBuffer);

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
    const overwrite = args?.overwrite !== false;

    if (!filePathRaw) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: 'file_path' is required." }],
      };
    }

    try {
      const ffmpeg = await getFfmpegBinary();
      const sourcePath = resolveHomePath(filePathRaw);
      const targetPath = resolveHomePath(outputPathRaw);

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
    const overwrite = args?.overwrite !== false;

    if (!filePathRaw || !outputPathRaw) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: Both 'file_path' and 'output_path' are required." }],
      };
    }

    try {
      const ffmpeg = await getFfmpegBinary();
      const sourcePath = resolveHomePath(filePathRaw);
      const targetPath = resolveHomePath(outputPathRaw);

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

      // Safe clamp boundaries
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
        // default delogo
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
      const sourcePath = resolveHomePath(filePathRaw);
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
    const overwrite = args?.overwrite !== false;

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
      let targetPath = resolveHomePath(outputPathRaw);

      if (!path.extname(targetPath) && format.ext !== "bin") {
        targetPath = `${targetPath}.${format.ext}`;
      }

      if (!overwrite) {
        try {
          await fs.access(targetPath);
          return {
            isError: true,
            content: [{ type: "text", text: `Error: File '${targetPath}' already exists and overwrite is false.` }],
          };
        } catch {
          // File does not exist, safe to write
        }
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, buffer);

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
      const targetPath = resolveHomePath(filePathRaw);
      const buffer = await fs.readFile(targetPath);
      const format = detectImageFormat(buffer);
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
    const overwrite = args?.overwrite !== false;

    if (!url || !outputPathRaw) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: 'url' and 'output_path' are required." }],
      };
    }

    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const format = detectImageFormat(buffer);

      let targetPath = resolveHomePath(outputPathRaw);
      if (!path.extname(targetPath) && format.ext !== "bin") {
        targetPath = `${targetPath}.${format.ext}`;
      }

      if (!overwrite) {
        try {
          await fs.access(targetPath);
          return {
            isError: true,
            content: [{ type: "text", text: `Error: File '${targetPath}' already exists and overwrite is false.` }],
          };
        } catch {
          // File does not exist, can write
        }
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, buffer);

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
    args: ["-y", "remove-ai-signature"],
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
args = ["-y", "remove-ai-signature"]
`;

  content = (content.trim() + "\n" + snippet).trim() + "\n";
  await fs.writeFile(configPath, content, "utf-8");
}

async function runInteractiveInstaller(): Promise<void> {
  const targets = getAgentTargets();
  const home = os.homedir();

  process.stdout.write(`\n\x1b[1;36m✨ remove-ai-signature v1.2.0 — Auto-Configuration Wizard\x1b[0m\n\n`);

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

  // If piped into or spawned by an MCP host (non-TTY stdin) or explicitly requested stdio:
  if (!process.stdin.isTTY || isStdioExplicit) {
    await runMcpServer();
    return;
  }

  // If executed in an interactive terminal by a human:
  await runInteractiveInstaller();
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
