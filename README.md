# Image Saver MCP Server

MCP server cung cấp các công cụ để agent nhận dữ liệu hình ảnh (Base64, Data URI, URL, File path) và lưu trực tiếp ra file trên máy tính.

## 🛠️ Công cụ cung cấp (Tools)

### 1. `save_image`
Lưu hình ảnh ra file từ nhiều định dạng đầu vào khác nhau.
- **`image_data`** (string, bắt buộc): 
  - Chuỗi Base64 (có hoặc không có prefix `data:image/...;base64,`)
  - Đường dẫn HTTP/HTTPS URL (tải về và lưu)
  - Đường dẫn file cục bộ (sao chép/chuyển vị trí)
- **`output_path`** (string, bắt buộc): Đường dẫn file đích cần lưu (ví dụ: `/home/nhat/per/output.png` hoặc `images/result.jpg`). Nếu không có đuôi mở rộng, server sẽ tự động nhận diện và bổ sung đúng định dạng ảnh. Tự động tạo thư mục cha nếu chưa tồn tại.
- **`overwrite`** (boolean, tùy chọn, mặc định: `true`): Ghi đè nếu file đã tồn tại.

### 2. `read_image`
Đọc file ảnh từ máy và chuyển thành chuỗi Base64 / Data URI để agent phân tích hoặc truyền đi.
- **`file_path`** (string, bắt buộc): Đường dẫn file ảnh.

### 3. `download_image`
Tải trực tiếp ảnh từ URL và lưu vào đường dẫn chỉ định.
- **`url`** (string, bắt buộc): Link ảnh web.
- **`output_path`** (string, bắt buộc): File đích cần lưu.
- **`overwrite`** (boolean, tùy chọn, mặc định: `true`).

## 🚀 Cấu hình MCP

Đã được cấu hình trong:
- **Global Antigravity**: `~/.gemini/config/mcp_config.json`
- **Workspace**: `~/per/.mcp.json`

```json
{
  "mcpServers": {
    "image-saver": {
      "command": "node",
      "args": ["/home/nhat/per/image-saver-mcp/dist/index.js"]
    }
  }
}
```
