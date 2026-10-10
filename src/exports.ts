import type { ReviewSession } from "./core/types";
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function downloadText(
  text: string,
  name: string,
  type = "application/json",
) {
  download(new Blob([text], { type }), name);
}
export async function exportSvg(svg: SVGSVGElement, name: string, png = false) {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const { width, height } = svg.viewBox.baseVal;
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  const xml = new XMLSerializer().serializeToString(clone);
  if (!png) {
    downloadText(xml, name + ".svg", "image/svg+xml");
    return;
  }
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("图片导出失败。"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width * 2;
    canvas.height = height * 2;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("PNG 导出失败。"))),
        "image/png",
      ),
    );
    download(blob, name + ".png");
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function exportOverlay(session: ReviewSession) {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = session.source.dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = session.source.width;
  canvas.height = session.source.height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  ctx.lineWidth = Math.max(1, session.source.width / 750);
  ctx.font = `${Math.max(9, session.source.width / 65)}px Arial`;
  session.rows.forEach((row) =>
    row.bands.forEach((band) => {
      ctx.strokeStyle = row.role === "reference" ? "#b6772d" : "#148677";
      ctx.setLineDash([]);
      const r = band.rect;
      ctx.strokeRect(r.x, r.y, r.width, r.height);
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = "#6d8baf";
      band.backgrounds.forEach((b) =>
        ctx.strokeRect(b.x, b.y, b.width, b.height),
      );
    }),
  );
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("叠图导出失败。"))),
      "image/png",
    ),
  );
  download(blob, "blotlens-rois.png");
}
