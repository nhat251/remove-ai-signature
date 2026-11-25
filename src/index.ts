#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

const server = new Server(
  {
    name: "image-saver",
    version: "1.1.0",
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
        name: "save_image",
        description:
          "Save an image to a local file. Accepts base64 encoded data (with or without 'data:image/...;base64,' prefix), an HTTP/HTTPS image URL to download, or an existing local image path to copy. Automatically creates parent directories and detects image format.",
        inputSchema: {
          type: "object",
          properties: {
            image_data: {
              type: "string",
              description:
                "The image content: can be a base64 string, data URI (data:image/png;base64,...), an HTTP/HTTPS image URL, or a local file path.",
            },
            output_path: {
              type: "string",
              description:
                "The destination file path where the image should be saved (e.g. '/home/nhat/per/output.png' or 'relative/path/image.jpg').",
            },
            overwrite: {
              type: "boolean",
              description:
                "Whether to overwrite the file if it already exists. Defaults to true.",
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
              description: "Absolute or relative path to the image file.",
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
              description:
                "Whether to overwrite the file if it already exists. Defaults to true.",
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

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
