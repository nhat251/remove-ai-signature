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
  if (preview.startsWith("<svg") || preview.startsWith("<?xml") && preview.includes("<svg")) {
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

const server = new Server(
  {
    name: "image-saver",
    version: "1.0.0",
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
              description: "Whether to overwrite if file exists. Defaults to true.",
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

  if (name === "save_image") {
    const imageData = String(args?.image_data ?? "");
    const outputPathRaw = String(args?.output_path ?? "");
    const overwrite = args?.overwrite !== false;

    if (!imageData) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: 'image_data' is required." }],
      };
    }
    if (!outputPathRaw) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: 'output_path' is required." }],
      };
    }

    try {
      const buffer = await resolveImageBuffer(imageData);
      if (buffer.length === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: decoded image buffer is empty." }],
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
            content: [{ type: "text", text: `Error: File '${targetPath}' already exists and overwrite is set to false.` }],
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
                message: `Successfully saved image (${buffer.length} bytes, format: ${format.ext}) to '${targetPath}'.`,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to save image: ${msg}` }],
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to read image: ${msg}` }],
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
          // Can write
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to download image: ${msg}` }],
      };
    }
  }

  return {
    isError: true,
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error starting image-saver MCP server:", error);
  process.exit(1);
});
