// A minimal multipart/form-data reader for the stub's uploads (message attachments, project logos).
export function multipart(body, type) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type ?? "");
  const fields = {};
  const files = [];
  if (!boundary) return { fields, files };
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let position = body.indexOf(marker);
  while (position >= 0) {
    const next = body.indexOf(marker, position + marker.length);
    if (next < 0) break;
    const part = body.subarray(position + marker.length + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, split).toString("utf8");
    const content = part.subarray(split + 4);
    const name = /name="([^"]*)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename !== undefined) files.push({ name, filename, type: /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? "", size: content.length, content });
    else if (name) fields[name] = content.toString("utf8");
    position = next;
  }
  return { fields, files };
}
